/**
 * ROLE 2 of 3 — THE CHECKER.
 *
 * Takes the preparer's brief and the facts it was built from, and reviews them against the
 * fair edition's technical rules and the two-tier policy. It returns findings; it does not
 * decide. Every finding names the field it concerns, so the UI can point at the thing that
 * needs fixing rather than at a paragraph.
 *
 * It is given BOTH the brief and the context on purpose. Checking the brief alone would
 * trust the preparer's reading of the CRM; checking the context alone would make the brief
 * decorative. Holding the two together lets the checker do the one thing a reviewer is
 * actually for: notice when the document says something the records do not support. That is
 * the CONTRADICTS_CRM finding below — cheap here, and the only defence against a preparer
 * that fills a gap with a plausible value.
 */
import { composeReviewSummary, MODEL_STAND_IN } from "../model";
import { evaluatePolicy, POLICY_VERSION } from "../policy";
import type { Brief, Finding, HandoffContext, Outstanding, Review } from "../types";

/** Fields whose brief entry must match a non-null CRM value, by dotted path. */
const VERIFIABLE_FIELDS: ReadonlyArray<{ field: string; read: (c: HandoffContext) => string | null }> = [
  { field: "opportunity.stand_area_sqm", read: (c) => c.opportunity.stand_area_sqm },
  { field: "opportunity.requested_height_m", read: (c) => c.opportunity.requested_height_m },
  { field: "opportunity.client_budget_eur", read: (c) => c.opportunity.client_budget_eur },
  { field: "fair_edition.max_stand_height_m", read: (c) => c.fair_edition?.max_stand_height_m ?? null },
];

function outstandingToFinding(item: Outstanding, gate: "A" | "B"): Finding {
  return {
    code: `MISSING_${item.field.split(".").pop()?.toUpperCase() ?? "FIELD"}`,
    severity: gate === "A" ? "BLOCKER" : "MISSING",
    field: item.field,
    label: item.label,
    message: item.message,
    gate,
  };
}

export function check(brief: Brief, context: HandoffContext): Review {
  const policy = evaluatePolicy(context);
  const findings: Finding[] = [];

  /* ---- Gate A: unmet conditions stop everything, so they are BLOCKERs ----------------- */

  for (const item of policy.gate_a.unmet) {
    findings.push(outstandingToFinding(item, "A"));
  }

  /* ---- The height comparison, always stated, whichever way it came out ---------------- */

  switch (policy.height_check.status) {
    case "BREACH":
      findings.push({
        code: "HEIGHT_EXCEEDS_EDITION_LIMIT",
        severity: "BLOCKER",
        field: "opportunity.requested_height_m",
        label: "Requested height",
        message: policy.height_check.statement,
        gate: "B",
      });
      break;
    case "LIMIT_UNKNOWN":
      // Not a pass. With no limit on file the check cannot be performed at all, and an
      // unperformed check is not a passed one.
      findings.push({
        code: "EDITION_LIMIT_UNKNOWN",
        severity: "MISSING",
        field: "fair_edition.max_stand_height_m",
        label: "Edition height limit",
        message: policy.height_check.statement,
        gate: "B",
      });
      break;
    case "REQUEST_UNKNOWN":
      findings.push({
        code: "HEIGHT_NOT_REQUESTED",
        severity: "MISSING",
        field: "opportunity.requested_height_m",
        label: "Requested height",
        message: policy.height_check.statement,
        gate: "B",
      });
      break;
    case "WITHIN_LIMIT":
      findings.push({
        code: "HEIGHT_WITHIN_LIMIT",
        severity: "INFO",
        field: "opportunity.requested_height_m",
        label: "Requested height",
        message: policy.height_check.statement,
        gate: "B",
      });
      break;
  }

  /* ---- Gate B: the remaining technical unknowns --------------------------------------- */

  for (const item of policy.gate_b.unmet) {
    const alreadyReported = findings.some((finding) => finding.field === item.field);
    if (alreadyReported) continue;
    findings.push(outstandingToFinding(item, "B"));
  }

  /* ---- Commercial status is not technical approval ------------------------------------ */

  if (context.opportunity.status === "WON" && !policy.gate_b.passes) {
    findings.push({
      code: "WON_BUT_NOT_TECHNICALLY_READY",
      severity: "INFO",
      field: "opportunity.status",
      label: "Commercial status",
      message:
        "The opportunity is marked WON. That is a commercial state and records no technical approval: the outstanding items below still apply.",
      gate: null,
    });
  }

  if (context.opportunity.status === "LOST") {
    findings.push({
      code: "OPPORTUNITY_LOST",
      severity: "INFO",
      field: "opportunity.status",
      label: "Commercial status",
      message:
        "The opportunity is marked LOST. The technical check below still reports what it sees, but confirm with the account manager before spending time on it.",
      gate: null,
    });
  }

  /* ---- Does the brief say anything the CRM does not hold? ------------------------------ */

  for (const { field, read } of VERIFIABLE_FIELDS) {
    const claimed = brief.known.find((fact) => fact.field === field);
    const actual = read(context);
    if (claimed !== undefined && actual === null) {
      findings.push({
        code: "CONTRADICTS_CRM",
        severity: "BLOCKER",
        field,
        label: claimed.label,
        message: `The brief states ${claimed.label.toLowerCase()} as "${claimed.value}", but the CRM holds no value for it. A brief may not supply a fact the records do not.`,
        gate: null,
      });
    }
  }

  /* ---- Is the proposed next step supportable? ----------------------------------------- */

  if (brief.proposed_next_step.owner === "technical" && !policy.gate_b.passes) {
    findings.push({
      code: "NEXT_STEP_OVERREACHES",
      severity: "INFO",
      field: "brief.proposed_next_step",
      label: "Proposed next step",
      message:
        "The brief proposes handing over to technical, but the technical condition is not met. The coordinator's decision below replaces that proposal.",
      gate: null,
    });
  }

  const blockers = findings.filter((finding) => finding.severity === "BLOCKER");

  // A field named in a BLOCKER is not "outstanding information" — waiting will not fix it.
  const outstanding = policy.outstanding.filter(
    (item) => !blockers.some((blocker) => blocker.field === item.field),
  );

  const summary = composeReviewSummary({
    opportunity_code: context.opportunity.opportunity_code,
    gate_a_passes: policy.gate_a.passes,
    gate_b_passes: policy.gate_b.passes,
    height_statement: policy.height_check.statement,
    outstanding_labels: outstanding.map((item) => item.label),
    conflict_count: policy.conflicts.length,
  });

  return {
    reviewed_by: "checker",
    policy_version: POLICY_VERSION,
    model: MODEL_STAND_IN,
    findings,
    gate_a: policy.gate_a,
    gate_b: policy.gate_b,
    height_check: policy.height_check,
    outstanding,
    blockers,
    summary,
  };
}

/** Exported for the UI's findings table: a stable, legible ordering. */
export const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  BLOCKER: 0,
  MISSING: 1,
  INFO: 2,
};
