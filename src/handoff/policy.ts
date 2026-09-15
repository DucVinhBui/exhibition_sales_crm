/**
 * The handoff policy: two tiers, versioned.
 *
 * The team disagrees, and the disagreement is real rather than a misunderstanding:
 *
 *   The sales director  — hand the enquiry over as soon as the customer names a fair and
 *                         gives a budget. Waiting for the rest of the brief costs time.
 *   The technical lead  — nothing moves until the stand area and the requested height are
 *                         known and checked against the fair, because the team keeps
 *                         starting work on requests it cannot deliver.
 *
 * Both are right about their own cost. So the policy has two tiers rather than one
 * threshold, and a third outcome for the case neither of them described:
 *
 *   Gate A passes, Gate B does not  -> PROVISIONAL  technical may start scoping, and is
 *                                                   handed an explicit list of what is
 *                                                   still unknown. The list is the whole
 *                                                   point: it is what stops an incomplete
 *                                                   request being presented as deliverable.
 *   Gate A and Gate B pass          -> ACCEPTED     nothing outstanding, nothing in breach.
 *   A conflict, or Gate A unmet     -> BLOCKED      stop. The brief must change first.
 *
 * Rules that are not negotiable anywhere below:
 *
 *   * NULL is unknown. Unknown pushes towards PROVISIONAL or BLOCKED, never towards
 *     ACCEPTED. An absent height is not an approval; an absent area is not zero m².
 *   * A requested height above the edition limit is a CONFLICT, not a shortfall. It is not
 *     downgradable to PROVISIONAL: no list of outstanding items makes a 6 m stand fit under
 *     a 5 m limit. The brief has to change.
 *   * A NULL `max_stand_height_m` means the breach cannot be EVALUATED. That is not
 *     permission, and it is not a limit of infinity.
 *   * Commercial status records no technical approval whatsoever. A WON opportunity with no
 *     area is still blocked technically, and `status` is deliberately absent from both gates.
 */
import { compareDecimal, formatMetres, formatSquareMetres } from "./decimal";
import type { GateResult, HandoffContext, HeightCheck, Outstanding } from "./types";

/**
 * Stamped on every run. Old rows keep the version they were decided under, so a run from
 * before a policy change stays interpretable instead of being silently re-read under rules
 * that did not exist when it was made.
 */
export const POLICY_VERSION = "handoff-policy-1.0.0";

/** Human-readable statement of the tiers, for the UI and the README. */
export const POLICY_SUMMARY = {
  version: POLICY_VERSION,
  gate_a: {
    name: "A" as const,
    owner: "Sales director",
    condition: "A fair edition is named and a budget or opportunity value is recorded.",
    grants: "PROVISIONAL — technical may start scoping, with the outstanding list attached.",
  },
  gate_b: {
    name: "B" as const,
    owner: "Technical coordinator",
    condition:
      "Gate A passes, the stand area is known, the requested height is known, and that height is within the edition's recorded limit.",
    grants: "ACCEPTED — the enquiry can be worked as briefed.",
  },
  conflict: {
    condition: "The requested height exceeds the edition's recorded maximum.",
    grants: "BLOCKED — not downgradable to PROVISIONAL; the brief must change first.",
  },
} as const;

/* =======================================================================================
 * The height check — computed at read time from two values that are both kept
 * ===================================================================================== */

/**
 * Compare the requested height with the edition limit without ever merging them.
 *
 * Four outcomes, and only one of them lets Gate B pass. The two "unknown" outcomes exist so
 * that the absence of a number can never be read as a pass.
 */
export function checkHeight(
  requested: string | null,
  limit: string | null,
  editionCode: string | null,
): HeightCheck {
  const where = editionCode ? ` for ${editionCode}` : "";

  if (requested === null) {
    return {
      status: "REQUEST_UNKNOWN",
      requested_m: null,
      limit_m: limit,
      statement:
        limit === null
          ? "No requested height on file, and no height limit recorded for the edition. Nothing can be checked, and an absent height is not an approval."
          : `No requested height on file. The limit${where} is ${formatMetres(limit)}; an absent height is not an approval.`,
    };
  }

  if (limit === null) {
    return {
      status: "LIMIT_UNKNOWN",
      requested_m: requested,
      limit_m: null,
      statement: `The customer asks for ${formatMetres(requested)}, but no height limit is recorded${where}. The request cannot be checked — that is not permission to build it.`,
    };
  }

  const comparison = compareDecimal(requested, limit);
  if (comparison > 0) {
    return {
      status: "BREACH",
      requested_m: requested,
      limit_m: limit,
      statement: `The customer asks for ${formatMetres(requested)} against a limit of ${formatMetres(limit)}${where}. No exception to an edition limit is recorded anywhere in the archive.`,
    };
  }

  return {
    status: "WITHIN_LIMIT",
    requested_m: requested,
    limit_m: limit,
    statement: `The requested ${formatMetres(requested)} is within the ${formatMetres(limit)} limit${where}.`,
  };
}

/* =======================================================================================
 * The gates
 * ===================================================================================== */

/** Everything the policy has to say about one context. Facts in, verdict-free structure out. */
export interface PolicyEvaluation {
  policy_version: string;
  gate_a: GateResult;
  gate_b: GateResult;
  height_check: HeightCheck;
  /** Unmet conditions across both tiers, deduplicated, in recital order. */
  outstanding: Outstanding[];
  /** Irreconcilable findings. Non-empty means BLOCKED regardless of the gates. */
  conflicts: Outstanding[];
}

export function evaluatePolicy(context: HandoffContext): PolicyEvaluation {
  const { opportunity, fair_edition } = context;

  /* ---- Gate A: the sales director's condition ---------------------------------------- */

  const gateAUnmet: Outstanding[] = [];

  if (fair_edition === null) {
    gateAUnmet.push({
      field: "opportunity.fair_edition_id",
      label: "Fair edition",
      message:
        "No fair edition is named on this enquiry, so there is nothing to check a stand against and no dates to plan to.",
    });
  }

  // Either figure satisfies the director: the customer's own budget, or, failing that, the
  // value sales has recorded. They are different things and are never merged — the budget is
  // what the customer said, the amount is what sales expects to invoice.
  const hasMoney = opportunity.client_budget_eur !== null || opportunity.amount_eur !== null;
  if (!hasMoney) {
    gateAUnmet.push({
      field: "opportunity.client_budget_eur",
      label: "Budget",
      message:
        "Neither a customer budget nor a recorded opportunity value is on file, so there is no commercial basis for a handover.",
    });
  }

  const gate_a: GateResult = {
    name: "A",
    owner: POLICY_SUMMARY.gate_a.owner,
    condition: POLICY_SUMMARY.gate_a.condition,
    passes: gateAUnmet.length === 0,
    unmet: gateAUnmet,
  };

  /* ---- The height comparison, needed by Gate B ---------------------------------------- */

  const height_check = checkHeight(
    opportunity.requested_height_m,
    fair_edition?.max_stand_height_m ?? null,
    fair_edition?.edition_code ?? null,
  );

  /* ---- Gate B: the technical coordinator's condition ---------------------------------- */

  const gateBUnmet: Outstanding[] = [...gateAUnmet];

  if (opportunity.stand_area_sqm === null) {
    gateBUnmet.push({
      field: "opportunity.stand_area_sqm",
      label: "Stand area",
      message:
        "The stand area is unknown. It is not zero square metres and it cannot be assumed — nothing can be laid out or costed without it.",
    });
  }

  switch (height_check.status) {
    case "REQUEST_UNKNOWN":
      gateBUnmet.push({
        field: "opportunity.requested_height_m",
        label: "Requested height",
        message:
          "No requested height is on file. An absent height is not an approval: until the customer states one there is nothing to check against the edition limit.",
      });
      break;
    case "LIMIT_UNKNOWN":
      gateBUnmet.push({
        field: "fair_edition.max_stand_height_m",
        label: "Edition height limit",
        message:
          "No maximum stand height is recorded for this edition, so the requested height cannot be checked. A missing limit is not permission — confirm it with the organiser.",
      });
      break;
    case "BREACH":
      // Recorded as a conflict below, not as something outstanding. Gate B fails either way.
      gateBUnmet.push({
        field: "opportunity.requested_height_m",
        label: "Requested height",
        message: height_check.statement,
      });
      break;
    case "WITHIN_LIMIT":
      break;
  }

  const gate_b: GateResult = {
    name: "B",
    owner: POLICY_SUMMARY.gate_b.owner,
    condition: POLICY_SUMMARY.gate_b.condition,
    passes: gateBUnmet.length === 0,
    unmet: gateBUnmet,
  };

  /* ---- Conflicts ---------------------------------------------------------------------- */

  const conflicts: Outstanding[] =
    height_check.status === "BREACH"
      ? [
          {
            field: "opportunity.requested_height_m",
            label: "Requested height",
            message: height_check.statement,
          },
        ]
      : [];

  // Outstanding is what the customer or the organiser still owes us. A breach is not on that
  // list: it is not resolved by information arriving, it is resolved by the brief changing.
  const outstanding = gateBUnmet.filter(
    (item) => !conflicts.some((conflict) => conflict.field === item.field),
  );

  return { policy_version: POLICY_VERSION, gate_a, gate_b, height_check, outstanding, conflicts };
}

/* =======================================================================================
 * Formatting helpers shared by the roles, kept here so the policy owns its own vocabulary
 * ===================================================================================== */

export function describeArea(area: string | null): string {
  return area === null ? "area unknown" : formatSquareMetres(area);
}

export function describeHeight(height: string | null): string {
  return height === null ? "height unknown" : formatMetres(height);
}
