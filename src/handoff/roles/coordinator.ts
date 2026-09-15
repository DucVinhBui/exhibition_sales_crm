/**
 * ROLE 3 of 3 — THE COORDINATOR.
 *
 * Maps the checker's findings to one of three outcomes and says why, in a sentence a
 * salesperson can act on without reading a findings table. It decides continue or stop.
 *
 * The precedence below is the whole argument between the sales director and the technical
 * coordinator, written down:
 *
 *   1. A BLOCKER wins.           A conflict is not resolved by attaching a list of caveats.
 *                                 A 6 m stand does not fit under a 5 m limit because sales
 *                                 flagged it as provisional. Stop; change the brief.
 *   2. Gate A unmet -> stop.     With no fair named and no figure on file there is nothing
 *                                 to hand over. Even the director's tier is not met.
 *   3. Gate B met -> ACCEPTED.   Nothing outstanding, nothing in breach.
 *   4. Otherwise -> PROVISIONAL. The compromise. Technical starts scoping and is handed the
 *                                 outstanding list, so the enquiry can never be mistaken for
 *                                 a complete brief. Unknown information always lands here or
 *                                 lower — never in ACCEPTED.
 */
import { formatEuro } from "../decimal";
import { composeDecisionReason, MODEL_STAND_IN } from "../model";
import { describeArea, describeHeight, POLICY_VERSION } from "../policy";
import type { Brief, Decision, HandoffContext, ProposedNextStep, Review } from "../types";
import type { HandoffDecision } from "../../db/schema";

/** The precedence, as data, so it can be shown in the UI and read in a review. */
export const DECISION_PRECEDENCE: ReadonlyArray<{ rule: string; outcome: HandoffDecision }> = [
  { rule: "Any BLOCKER finding — a conflict with the edition rules, or a missing precondition for any handover at all.", outcome: "BLOCKED" },
  { rule: "Gate A unmet: no fair edition named, or no budget and no opportunity value on file.", outcome: "BLOCKED" },
  { rule: "Gate B met: area and height known, height within the edition limit.", outcome: "ACCEPTED" },
  { rule: "Gate A met, Gate B not met: hand over provisionally with the outstanding list attached.", outcome: "PROVISIONAL" },
];

function nextStepFor(
  decision: HandoffDecision,
  brief: Brief,
  review: Review,
): ProposedNextStep {
  if (decision === "BLOCKED") {
    const conflict = review.blockers[0];
    return {
      owner: "sales",
      action:
        conflict?.code === "HEIGHT_EXCEEDS_EDITION_LIMIT"
          ? "Agree a height within the edition limit with the customer, then re-run the handoff"
          : "Resolve the blocking item on the enquiry, then re-run the handoff",
      detail: review.blockers.map((blocker) => `${blocker.label}: ${blocker.message}`).join(" "),
      depends_on: review.blockers.map((blocker) => blocker.field),
    };
  }

  if (decision === "ACCEPTED") {
    return {
      owner: "technical",
      action: "Hand the brief to the technical team for scoping",
      detail:
        "Area and height are on file and the height has been checked against the edition limit. Nothing is outstanding.",
      depends_on: [],
    };
  }

  // PROVISIONAL: both things happen at once, which is the point of the tier.
  return {
    owner: "sales",
    action: "Send the brief across as provisional and chase the outstanding details",
    detail: `Technical can start scoping now. Still to confirm: ${review.outstanding
      .map((item) => item.label.toLowerCase())
      .join(", ")}. ${brief.proposed_next_step.detail}`,
    depends_on: review.outstanding.map((item) => item.field),
  };
}

export function coordinate(brief: Brief, review: Review, context: HandoffContext): Decision {
  const decision: HandoffDecision =
    review.blockers.length > 0 || !review.gate_a.passes
      ? "BLOCKED"
      : review.gate_b.passes
        ? "ACCEPTED"
        : "PROVISIONAL";

  const { opportunity, fair_edition } = context;

  const reason = composeDecisionReason({
    decision,
    opportunity_code: opportunity.opportunity_code,
    fair_label: fair_edition === null ? null : `${fair_edition.fair_name} (${fair_edition.edition_code})`,
    area_phrase: describeArea(opportunity.stand_area_sqm),
    height_phrase: describeHeight(opportunity.requested_height_m),
    limit_phrase:
      fair_edition?.max_stand_height_m == null ? null : describeHeight(fair_edition.max_stand_height_m),
    money_phrase:
      opportunity.client_budget_eur === null
        ? `an opportunity value of ${formatEuro(opportunity.amount_eur)}`
        : `a budget of ${formatEuro(opportunity.client_budget_eur)}`,
    outstanding_labels: review.outstanding.map((item) => item.label),
    blocked_kind: review.blockers.some((blocker) => blocker.code === "HEIGHT_EXCEEDS_EDITION_LIMIT")
      ? "CONFLICT"
      : "PRECONDITION",
    blocker_statements: review.blockers.map((blocker) => blocker.message),
  });

  return {
    decided_by: "coordinator",
    policy_version: POLICY_VERSION,
    model: MODEL_STAND_IN,
    decision,
    // PROVISIONAL continues — that is the compromise. BLOCKED stops.
    proceed: decision !== "BLOCKED",
    reason,
    outstanding: review.outstanding,
    blockers: review.blockers,
    next_step: nextStepFor(decision, brief, review),
  };
}
