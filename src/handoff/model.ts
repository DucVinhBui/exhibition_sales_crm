/**
 * ===========================================================================================
 *  DETERMINISTIC LOCAL STAND-IN FOR A LANGUAGE MODEL — NOT A MODEL.
 * ===========================================================================================
 *
 * This file is where a model would be called if the assignment allowed one. It does not
 * call one. There is no API key, no network request, no downloaded weights, and nothing here
 * will ever acquire any: the entire file is template composition over facts that were read
 * from the CRM before it was called.
 *
 * The guarantees, which the tests in tests/model.test.ts enforce:
 *
 *   * PURE. No `Math.random()`, no `Date`, no `process.hrtime`, no filesystem, no network,
 *     no module-level mutable state. The same input produces byte-identical output, today
 *     and in six months, on any machine.
 *   * NO INVENTION. Every number and name in the output was passed in. Where a fact is
 *     missing the text says so; it never fills a gap with a plausible value, because the
 *     whole point of the exercise is that missing information changes the outcome.
 *   * NO JUDGEMENT. This file composes sentences. It never decides. The gates live in
 *     policy.ts and the verdict is the coordinator's.
 *
 * Why it is written as ordinary functions with an explicit label rather than hidden behind a
 * fake client: a reviewer should be able to see in one screen that nothing leaves the
 * process, and the UI should be able to say so on the badge.
 */
import type { ModelStamp } from "./types";

/**
 * The stamp every role attaches to its output, and the text the UI renders as a badge. The
 * README carries the same wording.
 */
export const MODEL_STAND_IN: ModelStamp = {
  id: "local-template-stand-in",
  version: "1.0.0",
  badge: "Stand-in model",
  label:
    "Deterministic local stand-in — text is composed from CRM facts by template, with no model call, no API key and no network access.",
};

/** Convenience export for a UI badge that wants only the short text. */
export const MODEL_STAND_IN_BADGE = MODEL_STAND_IN.badge;

/** Longer wording for a tooltip or an about panel. */
export const MODEL_STAND_IN_LABEL = MODEL_STAND_IN.label;

/* =======================================================================================
 * Sentence plumbing
 * ===================================================================================== */

/** Joins clauses into a paragraph, dropping the ones a caller left empty. Order is kept. */
function paragraph(sentences: Array<string | null>): string {
  return sentences.filter((sentence): sentence is string => sentence !== null && sentence !== "").join(" ");
}

/** 'a', 'a and b', 'a, b and c'. Deterministic: the caller's order is preserved. */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  const tail = items[items.length - 1] ?? "";
  return `${head} and ${tail}`;
}

/** 'is'/'are' for a list of n things. */
function verbFor(count: number): string {
  return count === 1 ? "is" : "are";
}

/* =======================================================================================
 * Preparer-facing composition
 * ===================================================================================== */

export interface BriefSummaryInput {
  company_name: string;
  contact_name: string | null;
  opportunity_code: string;
  description: string;
  fair_line: string | null;
  status_line: string;
  money_line: string;
  dimension_line: string;
  unknown_labels: readonly string[];
  activity_line: string | null;
  follow_up_line: string | null;
  notes: string;
}

/** The narrative at the top of the brief. Facts only, in a fixed order. */
export function composeBriefSummary(input: BriefSummaryInput): string {
  const who =
    input.contact_name === null
      ? `${input.company_name} (no contact recorded on the enquiry)`
      : `${input.company_name}, through ${input.contact_name},`;

  return paragraph([
    `${who} ${input.contact_name === null ? "has an enquiry" : "is enquiring"} about ${input.description} (${input.opportunity_code}).`,
    input.fair_line,
    input.status_line,
    input.money_line,
    input.dimension_line,
    input.unknown_labels.length === 0
      ? "Nothing on the enquiry is left unrecorded."
      : `Still unknown: ${joinList(input.unknown_labels)}. The brief does not guess at ${input.unknown_labels.length === 1 ? "it" : "them"}.`,
    input.activity_line,
    input.follow_up_line,
    input.notes.trim() === "" ? null : `Sales notes: ${input.notes.trim()}`,
  ]);
}

export interface NextStepInput {
  contact_name: string | null;
  contact_channel: string | null;
  missing_labels: readonly string[];
  follow_up_due: string | null;
  fair_line: string | null;
}

/**
 * The preparer's proposed next step. Note that it is a PROPOSAL: when the brief looks
 * complete it proposes a full handover, and it is the checker's job to notice if the
 * requested height breaches the edition limit. The roles are kept genuinely separate, so a
 * confident proposal can still be stopped downstream.
 */
export function composeNextStep(input: NextStepInput): { action: string; detail: string } {
  const who = input.contact_name ?? "the customer";
  const via = input.contact_channel === null ? "" : ` on ${input.contact_channel}`;

  if (input.missing_labels.length > 0) {
    const due =
      input.follow_up_due === null
        ? ""
        : ` A follow-up is already booked for ${input.follow_up_due}; use it.`;
    return {
      action: `Ask ${who} to confirm ${joinList(input.missing_labels.map((label) => label.toLowerCase()))}`,
      detail: `${joinList(input.missing_labels)} ${verbFor(input.missing_labels.length)} not on file. Call ${who}${via} and record the answer on the enquiry, then run the handoff again.${due}`,
    };
  }

  return {
    action: "Hand the brief to the technical team for scoping",
    detail: paragraph([
      "Everything the technical team asks for before scoping is recorded on the enquiry.",
      input.fair_line,
      "Send the brief across and keep the enquiry open for the build questions that follow.",
    ]),
  };
}

/* =======================================================================================
 * Checker-facing composition
 * ===================================================================================== */

export interface ReviewSummaryInput {
  opportunity_code: string;
  gate_a_passes: boolean;
  gate_b_passes: boolean;
  height_statement: string;
  outstanding_labels: readonly string[];
  conflict_count: number;
}

export function composeReviewSummary(input: ReviewSummaryInput): string {
  return paragraph([
    `Reviewed ${input.opportunity_code} against the handoff policy.`,
    input.gate_a_passes
      ? "The commercial condition is met: a fair edition is named and there is a figure to work to."
      : "The commercial condition is not met, so there is nothing to hand over yet.",
    input.height_statement,
    input.gate_b_passes
      ? "The technical condition is met: area and height are both on file and the height has been checked."
      : input.outstanding_labels.length === 0
        ? "The technical condition is not met."
        : `The technical condition is not met — ${joinList(input.outstanding_labels.map((label) => label.toLowerCase()))} ${verbFor(input.outstanding_labels.length)} outstanding.`,
    input.conflict_count === 0
      ? null
      : `${input.conflict_count === 1 ? "One request conflicts" : `${input.conflict_count} requests conflict`} with the edition rules and cannot be resolved by waiting for information.`,
  ]);
}

/* =======================================================================================
 * Coordinator-facing composition
 * ===================================================================================== */

export interface DecisionReasonInput {
  decision: "ACCEPTED" | "PROVISIONAL" | "BLOCKED";
  opportunity_code: string;
  fair_label: string | null;
  area_phrase: string;
  height_phrase: string;
  limit_phrase: string | null;
  money_phrase: string;
  outstanding_labels: readonly string[];
  /**
   * Why a BLOCKED run is blocked. CONFLICT means the brief asks for something the edition
   * rules forbid; PRECONDITION means something needed for any handover at all is absent.
   * The two need different closing advice, and telling a salesperson to "agree a change"
   * when nothing was ever requested would be nonsense.
   */
  blocked_kind: "CONFLICT" | "PRECONDITION";
  blocker_statements: readonly string[];
}

/**
 * One sentence — occasionally two — that a salesperson can act on without reading the
 * findings table. The numbers in it always come from the context; none is composed here.
 */
export function composeDecisionReason(input: DecisionReasonInput): string {
  const at = input.fair_label === null ? "" : ` at ${input.fair_label}`;

  if (input.decision === "BLOCKED") {
    return paragraph([
      `Blocked on ${input.opportunity_code}${at}: ${input.blocker_statements.join(" ")}`,
      input.blocked_kind === "CONFLICT"
        ? "Technical cannot take this on as briefed — agree a change with the customer, update the enquiry and run the handoff again."
        : "There is nothing to hand over until that is recorded on the enquiry; add it and run the handoff again.",
    ]);
  }

  if (input.decision === "ACCEPTED") {
    return paragraph([
      `Ready for technical handoff: ${input.opportunity_code}${at} is ${input.area_phrase} at ${input.height_phrase}${input.limit_phrase === null ? "" : `, within the ${input.limit_phrase} limit`}, with ${input.money_phrase} recorded.`,
      "Nothing is outstanding and nothing conflicts with the edition rules.",
    ]);
  }

  return paragraph([
    `Provisional handoff: ${input.opportunity_code}${at} has ${input.money_phrase} recorded, so technical can start scoping,`,
    `but ${joinList(input.outstanding_labels.map((label) => label.toLowerCase()))} ${verbFor(input.outstanding_labels.length)} still unknown and must be confirmed before anything is quoted or built.`,
    "This is not a complete brief and must not be worked as one.",
  ]);
}
