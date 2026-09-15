/**
 * ROLE 1 of 3 — THE PREPARER.
 *
 * Assembles the brief from the CRM facts the run actually read: company, contact,
 * opportunity, fair edition, and the activity scoped to THIS opportunity (never the
 * company's general chatter — this edition's enquiry shows only this edition's
 * conversations). It proposes a next step and stops there.
 *
 * Two things it must not do, both of which are the point of the role:
 *
 *   * It never invents a value. Every unknown is listed as an unknown, by field name, with
 *     a note about why it matters. A blank area does not become 0 m²; a blank height does
 *     not become "no special requirement".
 *   * It never applies the policy. It does not import policy.ts and it has no idea what the
 *     gates are. When area and height are on file it proposes a full handover even if the
 *     height breaches the edition limit — catching that is the checker's job, and the
 *     separation is what makes the check worth running.
 */
import { formatDate, formatEuro, formatMetres, formatSquareMetres } from "../decimal";
import { composeBriefSummary, composeNextStep, MODEL_STAND_IN } from "../model";
import type {
  Brief,
  BriefActivityLine,
  BriefFact,
  BriefUnknown,
  ContextActivity,
  HandoffContext,
  ProposedNextStep,
} from "../types";

export const BRIEF_VERSION = "handoff-brief-1.0.0";

/** Recent entries are quoted in the brief; older ones stay in the CRM. */
const ACTIVITY_LINES_IN_BRIEF = 5;

function contactName(context: HandoffContext): string | null {
  const contact = context.contact;
  if (contact === null) return null;
  return `${contact.first_name} ${contact.last_name}`.trim();
}

/** Phone if we have one, else email, else nothing. We do not claim a channel we lack. */
function contactChannel(context: HandoffContext): string | null {
  const contact = context.contact;
  if (contact === null) return null;
  return contact.phone ?? contact.email ?? null;
}

function fairLine(context: HandoffContext): string | null {
  const edition = context.fair_edition;
  if (edition === null) return null;

  const where = edition.city === null ? "" : ` in ${edition.city}`;
  const venue = edition.venue === null ? "" : `, ${edition.venue}`;
  const limit =
    edition.max_stand_height_m === null
      ? "no maximum stand height is recorded for the edition"
      : `the edition allows stands up to ${formatMetres(edition.max_stand_height_m)}`;

  return `The fair is ${edition.fair_name} (${edition.edition_code})${where}${venue}, ${formatDate(edition.starts_on)} to ${formatDate(edition.ends_on)}, and ${limit}.`;
}

function activityLine(entry: ContextActivity): BriefActivityLine {
  // Instant -> 'DD/MM/YYYY' via the ISO string, with no Date arithmetic and no timezone
  // shifting: the importer already stored the correct instant.
  const day = entry.occurred_at.slice(0, 10);
  return {
    entry_id: entry.entry_id,
    when: formatDate(day),
    type: entry.type,
    details: entry.details,
    follow_up:
      entry.follow_up_on === null
        ? null
        : entry.is_completed === false
          ? `follow-up due ${formatDate(entry.follow_up_on)}`
          : `follow-up noted for ${formatDate(entry.follow_up_on)}`,
  };
}

/**
 * The facts on file and the facts missing from it, in one pass so a value can never appear
 * in both lists.
 */
function collectFacts(context: HandoffContext): { known: BriefFact[]; unknown: BriefUnknown[] } {
  const { opportunity, fair_edition } = context;
  const known: BriefFact[] = [];
  const unknown: BriefUnknown[] = [];

  known.push({
    field: "opportunity.description",
    label: "Enquiry",
    value: opportunity.description,
    raw: opportunity.description,
  });

  known.push({
    field: "opportunity.status",
    label: "Commercial status",
    // The raw spelling is shown beside the normalised one: the archive spells it 13 ways and
    // the operator should be able to see what the CRM actually holds.
    value: `${opportunity.status} (recorded as "${opportunity.legacy_status_raw}")`,
    raw: opportunity.status,
  });

  if (fair_edition === null) {
    unknown.push({
      field: "opportunity.fair_edition_id",
      label: "Fair edition",
      note: "No fair edition is named, so there is no venue, no dates and no height limit to work to.",
    });
  } else {
    known.push({
      field: "opportunity.fair_edition_id",
      label: "Fair edition",
      value: `${fair_edition.fair_name} (${fair_edition.edition_code})`,
      raw: fair_edition.edition_code,
    });
  }

  known.push({
    field: "opportunity.amount_eur",
    label: "Opportunity value",
    value: formatEuro(opportunity.amount_eur),
    raw: opportunity.amount_eur,
  });

  if (opportunity.client_budget_eur === null) {
    unknown.push({
      field: "opportunity.client_budget_eur",
      label: "Customer budget",
      note: "The customer has not stated a budget. The recorded opportunity value is the sales team's own figure and is not a substitute for it.",
    });
  } else {
    known.push({
      field: "opportunity.client_budget_eur",
      label: "Customer budget",
      value: formatEuro(opportunity.client_budget_eur),
      raw: opportunity.client_budget_eur,
    });
  }

  if (opportunity.stand_area_sqm === null) {
    unknown.push({
      field: "opportunity.stand_area_sqm",
      label: "Stand area",
      note: "Not recorded. Unknown means unknown — it is not zero square metres, and it cannot be inferred from the budget.",
    });
  } else {
    known.push({
      field: "opportunity.stand_area_sqm",
      label: "Stand area",
      value: formatSquareMetres(opportunity.stand_area_sqm),
      raw: opportunity.stand_area_sqm,
    });
  }

  if (opportunity.requested_height_m === null) {
    unknown.push({
      field: "opportunity.requested_height_m",
      label: "Requested height",
      note: "The customer has not asked for a height. An absent height is not an approval and not a default — it simply has not been decided.",
    });
  } else {
    known.push({
      field: "opportunity.requested_height_m",
      label: "Requested height",
      // Stated as a request, never as an approved height, and never compared here.
      value: `${formatMetres(opportunity.requested_height_m)} requested by the customer`,
      raw: opportunity.requested_height_m,
    });
  }

  if (fair_edition !== null) {
    if (fair_edition.max_stand_height_m === null) {
      unknown.push({
        field: "fair_edition.max_stand_height_m",
        label: "Edition height limit",
        note: "No maximum stand height is recorded for this edition, so there is nothing to check a requested height against.",
      });
    } else {
      known.push({
        field: "fair_edition.max_stand_height_m",
        label: "Edition height limit",
        value: formatMetres(fair_edition.max_stand_height_m),
        raw: fair_edition.max_stand_height_m,
      });
    }
  }

  if (opportunity.expected_close_on !== null) {
    known.push({
      field: "opportunity.expected_close_on",
      label: "Expected sales decision",
      value: formatDate(opportunity.expected_close_on),
      raw: opportunity.expected_close_on,
    });
  }

  if (context.contact === null) {
    unknown.push({
      field: "opportunity.contact_id",
      label: "Primary contact",
      note: "No contact is recorded on this enquiry, so there is no one named to chase the outstanding details with.",
    });
  }

  return { known, unknown };
}

/** The technical facts the customer still owes us — what the next step is actually about. */
function missingForTechnical(unknown: BriefUnknown[]): string[] {
  const technicalFields = new Set([
    "opportunity.stand_area_sqm",
    "opportunity.requested_height_m",
    "fair_edition.max_stand_height_m",
  ]);
  return unknown.filter((item) => technicalFields.has(item.field)).map((item) => item.label);
}

/**
 * Assemble the brief. Pure: same context in, byte-identical brief out.
 */
export function prepare(context: HandoffContext): Brief {
  const { company, opportunity, fair_edition } = context;
  const { known, unknown } = collectFacts(context);

  const name = contactName(context);
  const fair_line = fairLine(context);

  const recent_activity = context.recent_activity.slice(0, ACTIVITY_LINES_IN_BRIEF).map(activityLine);
  const open_follow_ups = context.open_follow_ups.map(activityLine);
  const firstFollowUp = context.open_follow_ups[0];
  const firstFollowUpDate = firstFollowUp?.follow_up_on ?? null;

  const money_line =
    opportunity.client_budget_eur === null
      ? `The customer has not stated a budget; sales records the opportunity at ${formatEuro(opportunity.amount_eur)}.`
      : `The customer's stated budget is ${formatEuro(opportunity.client_budget_eur)}, against a recorded opportunity value of ${formatEuro(opportunity.amount_eur)}.`;

  const dimension_line = (() => {
    const area = opportunity.stand_area_sqm;
    const height = opportunity.requested_height_m;
    if (area !== null && height !== null) {
      return `The plot is ${formatSquareMetres(area)} and the customer has asked for ${formatMetres(height)}.`;
    }
    if (area !== null) {
      return `The plot is ${formatSquareMetres(area)}; no height has been requested.`;
    }
    if (height !== null) {
      return `The customer has asked for ${formatMetres(height)}; the plot area is not recorded.`;
    }
    return "Neither the plot area nor a requested height is recorded.";
  })();

  const missing = missingForTechnical(unknown);
  const composed = composeNextStep({
    contact_name: name,
    contact_channel: contactChannel(context),
    missing_labels: missing,
    follow_up_due: firstFollowUpDate === null ? null : formatDate(firstFollowUpDate),
    fair_line,
  });

  const proposed_next_step: ProposedNextStep = {
    owner: missing.length > 0 ? "sales" : "technical",
    action: composed.action,
    detail: composed.detail,
    depends_on:
      missing.length > 0
        ? unknown
            .filter((item) => missing.includes(item.label))
            .map((item) => item.field)
        : ["opportunity.stand_area_sqm", "opportunity.requested_height_m"],
  };

  const summary = composeBriefSummary({
    company_name: company.name,
    contact_name: name,
    opportunity_code: opportunity.opportunity_code,
    description: opportunity.description,
    fair_line,
    status_line: `Sales has it at ${opportunity.status}, opened ${formatDate(opportunity.opened_on)}. Commercial status carries no technical approval.`,
    money_line,
    dimension_line,
    unknown_labels: unknown.map((item) => item.label),
    activity_line:
      recent_activity.length === 0
        ? "There is no activity logged against this enquiry."
        : `The last entry on this enquiry was a ${recent_activity[0]?.type ?? "note"} on ${recent_activity[0]?.when ?? ""}: ${recent_activity[0]?.details ?? ""}`,
    follow_up_line:
      firstFollowUpDate === null
        ? null
        : `${open_follow_ups.length === 1 ? "One task is" : `${open_follow_ups.length} tasks are`} still open on this enquiry, the next due ${formatDate(firstFollowUpDate)}.`,
    notes: opportunity.brief_notes,
  });

  return {
    brief_version: BRIEF_VERSION,
    prepared_by: "preparer",
    model: MODEL_STAND_IN,
    opportunity_code: opportunity.opportunity_code,
    headline: `${company.name} — ${opportunity.description}${fair_edition === null ? "" : ` (${fair_edition.edition_code})`}`,
    summary,
    company_line: `${company.name} [${company.company_code}]${company.region === null ? "" : `, ${company.region}`}${company.sales_rep_name === null ? "" : ` — account manager ${company.sales_rep_name}`}`,
    contact_line:
      context.contact === null
        ? null
        : `${name} [${context.contact.contact_code}]${context.contact.email === null ? "" : ` · ${context.contact.email}`}${context.contact.phone === null ? "" : ` · ${context.contact.phone}`}`,
    fair_line,
    known,
    unknown,
    recent_activity,
    open_follow_ups,
    proposed_next_step,
  };
}
