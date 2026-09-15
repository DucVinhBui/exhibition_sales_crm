"use server";

/**
 * Server actions for one enquiry: edit the brief, record a conversation, run the assistant.
 *
 * All three are plain server actions on <form action={...}>. There is no API route and no
 * client-side fetching: the mutation, the revalidation and the redirect happen on the
 * server, and the screens work with JavaScript switched off.
 *
 * Feedback comes back as a query parameter on a redirect rather than as component state,
 * again so nothing here needs a client bundle. The redirects are on POST targets only — "/"
 * itself never redirects, because verify.sh curls it without -L.
 */
import { revalidatePath } from "next/cache";
import { runHandoff } from "@/handoff";
import { redirect } from "next/navigation";
import type { ActivityType, OpportunityStatus } from "@/db/schema";
import { ACTIVITY_TYPES, OPPORTUNITY_STATUSES } from "@/db/schema";
import {
  changeOpportunityStatus,
  getOpportunityByCode,
  insertActivity,
  updateOpportunityBrief,
} from "@/app/_lib/queries";
import { parseDateInput, parseDecimalInput, romeWallClockToInstant } from "@/app/_lib/input";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function back(code: string, params: Record<string, string>): never {
  const search = new URLSearchParams(params);
  redirect(`/opportunities/${encodeURIComponent(code)}?${search.toString()}`);
}

/**
 * Saves the editable brief: area, requested height, customer budget, notes.
 *
 * A field left empty is stored as NULL — unknown. That is deliberate and it is reversible:
 * a figure entered by mistake can be cleared back to "not known" rather than being frozen
 * at a wrong value or at zero.
 *
 * The requested height is NOT validated against the edition limit here. An over-limit
 * request is a real thing a customer asked for; it is recorded as asked and the conflict is
 * computed and shown at read time. Refusing to save it would delete the problem instead of
 * surfacing it.
 */
export async function saveBriefAction(formData: FormData): Promise<void> {
  const code = field(formData, "opportunity_code");
  if (code === "") redirect("/");

  const area = parseDecimalInput(field(formData, "stand_area_sqm"), {
    label: "Stand area",
    precision: 8,
    scale: 2,
  });
  const height = parseDecimalInput(field(formData, "requested_height_m"), {
    label: "Requested height",
    precision: 4,
    scale: 2,
  });
  const budget = parseDecimalInput(field(formData, "client_budget_eur"), {
    label: "Customer budget",
    precision: 12,
    scale: 2,
  });

  for (const result of [area, height, budget]) {
    if (!result.ok) back(code, { error: result.error });
  }
  if (!area.ok || !height.ok || !budget.ok) return; // unreachable; narrows the union

  const updated = await updateOpportunityBrief(code, {
    stand_area_sqm: area.value,
    requested_height_m: height.value,
    client_budget_eur: budget.value,
    brief_notes: field(formData, "brief_notes"),
  });

  if (!updated) back(code, { error: "That enquiry no longer exists." });

  revalidatePath(`/opportunities/${code}`);
  back(code, { saved: "brief" });
}

/**
 * Records a conversation or a task AGAINST THIS ENQUIRY.
 *
 * opportunity_id is always set here, so the entry can never drift into the company-wide log
 * and can never appear under a different edition. That scoping is the sales coordinator's
 * whole complaint and it is enforced at the point of writing, not at the point of reading.
 *
 * The completion marker stays tri-state on the way in:
 *   pending        -> FALSE, and with a follow-up date it joins the follow-up queue
 *   completed      -> TRUE
 *   not applicable -> NULL, for a note that is neither done nor pending
 */
export async function logActivityAction(formData: FormData): Promise<void> {
  const code = field(formData, "opportunity_code");
  if (code === "") redirect("/");

  const opportunity = await getOpportunityByCode(code);
  if (opportunity === null) back(code, { error: "That enquiry no longer exists." });

  const typeRaw = field(formData, "type");
  const type = ACTIVITY_TYPES.includes(typeRaw as ActivityType)
    ? (typeRaw as ActivityType)
    : null;
  if (type === null) back(code, { error: "Choose a valid entry type." });

  const details = field(formData, "details").trim();
  if (details === "") {
    back(code, { error: "Write what was said — an entry with no detail helps nobody later." });
  }

  const occurredAt = romeWallClockToInstant(field(formData, "occurred_at"));
  if (occurredAt === null) {
    back(code, { error: "When did this happen? Give a date and time." });
  }

  const followUp = parseDateInput(field(formData, "follow_up_on"), "Follow-up date");
  if (!followUp.ok) back(code, { error: followUp.error });

  const completionRaw = field(formData, "completion");
  const isCompleted =
    completionRaw === "completed" ? true : completionRaw === "pending" ? false : null;

  if (isCompleted === null && followUp.value !== null) {
    back(code, {
      error:
        "A follow-up date needs a completion state of pending or completed. 'Not applicable' means the entry is neither, so it would never reach the follow-up queue.",
    });
  }

  const author = field(formData, "legacy_author").trim();

  await insertActivity({
    company_id: opportunity.company_id,
    opportunity_id: opportunity.id,
    type,
    occurred_at: occurredAt,
    details,
    follow_up_on: followUp.value,
    is_completed: isCompleted,
    legacy_author: author === "" ? "crm.user" : author,
  });

  revalidatePath(`/opportunities/${code}`);
  revalidatePath("/follow-ups");
  back(code, {
    saved: followUp.value !== null && isCompleted === false ? "activity-follow-up" : "activity",
  });
}

/**
 * Runs the three roles and appends a handoff_run row.
 *
 * The UI knows nothing about the policy: it calls the engine's exported `runHandoff` and
 * renders whatever comes back. Re-running after an edit appends; it never overwrites, so the
 * earlier run stays readable with the facts it actually saw.
 */
export async function runHandoffAction(formData: FormData): Promise<void> {
  const code = field(formData, "opportunity_code");
  if (code === "") redirect("/");

  let decision: string;
  try {
    const run = await runHandoff({ opportunityCode: code });
    decision = run.decision;
  } catch (error) {
    back(code, {
      error: `The assistant could not run: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  revalidatePath(`/opportunities/${code}`);
  back(code, { ran: decision });
}

/**
 * Moves the enquiry along the commercial funnel.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not enforce an order. OPEN -> QUALIFIED -> PROPOSAL -> WON is how the funnel is
 * meant to run, but real enquiries skip stages (a returning exhibitor arrives qualified) and
 * go backwards (a WON deal collapses). A state machine here would make the CRM disagree with
 * what actually happened, and the archive already contains the evidence: it holds every
 * status with no recorded path between them.
 *
 * It does not touch the handoff. Commercial status and technical readiness are separate axes
 * -- WON records that the customer signed, never that the stand can be built -- so marking an
 * enquiry won neither accepts nor invalidates any handoff run.
 */
export async function changeStatusAction(formData: FormData): Promise<void> {
  const code = field(formData, "opportunity_code");
  if (code === "") redirect("/");

  const opportunity = await getOpportunityByCode(code);
  if (opportunity === null) back(code, { error: "That enquiry no longer exists." });

  const wanted = field(formData, "status");
  if (!OPPORTUNITY_STATUSES.includes(wanted as OpportunityStatus)) {
    back(code, { error: "Choose one of the five commercial statuses." });
  }
  const next = wanted as OpportunityStatus;

  if (next === opportunity.status) {
    back(code, { error: `This enquiry is already ${opportunity.status}. Nothing was changed.` });
  }

  await changeOpportunityStatus({
    opportunity_id: opportunity.id,
    company_id: opportunity.company_id,
    from: opportunity.status,
    to: next,
    reason: field(formData, "reason").trim(),
    author: field(formData, "legacy_author").trim() || "crm.user",
    at: new Date(),
  });

  revalidatePath(`/opportunities/${code}`);
  revalidatePath(`/companies/${opportunity.company_code}`);
  back(code, { saved: `status:${next}` });
}
