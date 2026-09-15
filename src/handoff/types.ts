/**
 * The shapes the three handoff roles pass between each other, and the shape of everything
 * stored in `handoff_run`'s JSONB columns. `src/db/schema.ts` types those columns `unknown`
 * and says the shape is owned here; this file is that shape.
 *
 * Rules that these types exist to enforce:
 *
 *   * `null` means UNKNOWN. Every optional CRM value is `T | null`, never `T | undefined`
 *     and never defaulted. An absent height is not an approval; an absent area is not zero
 *     square metres. Nothing in this module may collapse a null into a value.
 *   * Everything here is JSON-serialisable and free of clock reads. A context snapshot is
 *     frozen at run time and re-read months later, so it carries no Date objects (instants
 *     are ISO-8601 strings) and no values that depend on when it is read.
 */
import type { Decimal, HandoffDecision, Id, IsoDate, OpportunityStatus } from "../db/schema";

export type { HandoffDecision } from "../db/schema";

/* =======================================================================================
 * The context: the CRM and fair facts a run actually read
 * ===================================================================================== */

/** Bumped when the snapshot shape changes, so an old stored run stays interpretable. */
export const CONTEXT_SNAPSHOT_VERSION = "handoff-context-1";

export interface ContextCompany {
  company_code: string;
  /** Display name. Not an identifier — companies share names. */
  name: string;
  province_code: string | null;
  region: string | null;
  sales_rep_name: string | null;
}

export interface ContextContact {
  contact_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
}

export interface ContextOpportunity {
  opportunity_code: string;
  description: string;
  /** The sales team's recorded value. Not the customer's budget, not a stand price. */
  amount_eur: Decimal | null;
  /** The customer's stated budget. null = unknown, never 0. */
  client_budget_eur: Decimal | null;
  status: OpportunityStatus;
  /** Kept beside `status` so the 13-spellings normalisation stays auditable in the run. */
  legacy_status_raw: string | null;
  opened_on: IsoDate;
  expected_close_on: IsoDate | null;
  /** null = UNKNOWN. Never zero square metres. */
  stand_area_sqm: Decimal | null;
  /** REQUESTED by the customer, never an approved height. null = unknown, not an approval. */
  requested_height_m: Decimal | null;
  brief_notes: string;
}

export interface ContextFairEdition {
  edition_code: string;
  fair_name: string;
  city: string | null;
  venue: string | null;
  starts_on: IsoDate;
  ends_on: IsoDate;
  /**
   * null = no limit recorded for this edition. That is NOT unlimited height and NOT an
   * approval: with nothing on file the breach cannot be evaluated, and the policy treats
   * that as outstanding information rather than as permission.
   */
  max_stand_height_m: Decimal | null;
}

export interface ContextActivity {
  entry_id: string;
  type: "call" | "email" | "meeting" | "note" | "task";
  /** ISO-8601 instant, e.g. '2026-08-20T07:30:00.000Z'. A string, so the snapshot is stable. */
  occurred_at: string;
  details: string;
  follow_up_on: IsoDate | null;
  /** Tri-state: true = done, false = pending, null = not applicable. null is not false. */
  is_completed: boolean | null;
  legacy_author: string;
}

/**
 * Everything one run read, frozen. Stored verbatim in `handoff_run.context_snapshot` so
 * revisiting a run shows what it saw, not what the record says today.
 */
export interface HandoffContext {
  snapshot_version: typeof CONTEXT_SNAPSHOT_VERSION;
  opportunity_id: Id;
  company: ContextCompany;
  /** null = no contact recorded on the enquiry. Not "the company itself". */
  contact: ContextContact | null;
  opportunity: ContextOpportunity;
  /**
   * null = the enquiry names no edition. Present for every imported row (the column is NOT
   * NULL), but the policy still checks it: Gate A is "a fair is named", and a gate that
   * cannot fail is not a gate.
   */
  fair_edition: ContextFairEdition | null;
  /** Most recent entries scoped to THIS opportunity. Company-level chatter is excluded. */
  recent_activity: ContextActivity[];
  /** Pending, dated tasks on this opportunity: `is_completed = false AND follow_up_on IS NOT NULL`. */
  open_follow_ups: ContextActivity[];
}

/* =======================================================================================
 * Shared vocabulary
 * ===================================================================================== */

/**
 * How serious a finding is.
 *
 *   INFO    — worth stating; changes nothing on its own.
 *   MISSING — a fact the CRM does not hold. Pushes towards PROVISIONAL, never towards
 *             ACCEPTED. Silence is not consent.
 *   BLOCKER — a conflict or an absent precondition that stops the handoff outright.
 */
export type Severity = "INFO" | "MISSING" | "BLOCKER";

export const SEVERITIES = ["INFO", "MISSING", "BLOCKER"] as const satisfies readonly Severity[];

/** Which of the two policy tiers a finding belongs to. null = neither, purely informational. */
export type GateName = "A" | "B";

/** The label every role stamps on its output, so the UI can badge a run as non-model work. */
export interface ModelStamp {
  id: string;
  version: string;
  /** Short badge text, e.g. for a pill next to the summary. */
  badge: string;
  /** One-line label for the UI and the README. */
  label: string;
}

/* =======================================================================================
 * Preparer output — the brief
 * ===================================================================================== */

/** A fact the CRM actually holds, formatted once for display and kept raw for the checker. */
export interface BriefFact {
  /** Dotted path of the source column, e.g. 'opportunity.stand_area_sqm'. */
  field: string;
  label: string;
  /** Display-ready text, e.g. '80 m²'. */
  value: string;
  /** The value exactly as read. Null only for text fields the CRM stores as NOT NULL. */
  raw: string | null;
}

/** A fact the CRM does NOT hold. The preparer names it; it never guesses a value. */
export interface BriefUnknown {
  field: string;
  label: string;
  /** Why its absence matters and who can resolve it. */
  note: string;
}

export interface BriefActivityLine {
  entry_id: string;
  when: string;
  type: ContextActivity["type"];
  details: string;
  /** Pending dated task ('follow-up due 18/09/2026'), or null when there is nothing due. */
  follow_up: string | null;
}

export interface ProposedNextStep {
  /** Who the preparer thinks should act next. The checker may disagree; the coordinator decides. */
  owner: "sales" | "technical";
  action: string;
  detail: string;
  /** Fields the proposal depends on, named so the checker can verify the proposal. */
  depends_on: string[];
}

/**
 * The preparer's output: the enquiry, assembled. It contains no verdict — applying the
 * policy is the checker's job and deciding is the coordinator's.
 */
export interface Brief {
  brief_version: string;
  prepared_by: "preparer";
  model: ModelStamp;
  opportunity_code: string;
  headline: string;
  /** Composed prose for the person reading the brief. */
  summary: string;
  company_line: string;
  contact_line: string | null;
  fair_line: string | null;
  known: BriefFact[];
  unknown: BriefUnknown[];
  recent_activity: BriefActivityLine[];
  open_follow_ups: BriefActivityLine[];
  proposed_next_step: ProposedNextStep;
}

/* =======================================================================================
 * Checker output — the review
 * ===================================================================================== */

export interface Finding {
  /** Stable machine code; the UI may group on it and it never changes meaning. */
  code: string;
  severity: Severity;
  /** The column this finding is about. Every finding names a field. */
  field: string;
  label: string;
  message: string;
  gate: GateName | null;
}

/** One unmet condition of a tier, in the form the coordinator repeats to the salesperson. */
export interface Outstanding {
  field: string;
  label: string;
  message: string;
}

export interface GateResult {
  name: GateName;
  /** Whose condition this is, in the team's own words. */
  owner: string;
  condition: string;
  passes: boolean;
  unmet: Outstanding[];
}

/**
 * The requested height against the edition limit, computed at read time from two values
 * that are both kept. Never clamped, never normalised away.
 */
export type HeightCheckStatus =
  /** Both values known and the request fits. The only status Gate B accepts. */
  | "WITHIN_LIMIT"
  /** Both values known and the request exceeds the limit. A conflict, not a shortfall. */
  | "BREACH"
  /** No requested height on file. Unknown — and an absent height is not an approval. */
  | "REQUEST_UNKNOWN"
  /** No limit on file for the edition. The breach CANNOT be evaluated. Not permission. */
  | "LIMIT_UNKNOWN";

export interface HeightCheck {
  status: HeightCheckStatus;
  requested_m: Decimal | null;
  limit_m: Decimal | null;
  /** Sentence naming both numbers, or naming which one is missing. */
  statement: string;
}

export interface Review {
  reviewed_by: "checker";
  policy_version: string;
  model: ModelStamp;
  findings: Finding[];
  gate_a: GateResult;
  gate_b: GateResult;
  height_check: HeightCheck;
  /** Everything still outstanding, in the order the coordinator should recite it. */
  outstanding: Outstanding[];
  /** Findings of severity BLOCKER. Non-empty means the handoff cannot proceed at all. */
  blockers: Finding[];
  summary: string;
}

/* =======================================================================================
 * Coordinator output — the decision
 * ===================================================================================== */

export interface Decision {
  decided_by: "coordinator";
  policy_version: string;
  model: ModelStamp;
  decision: HandoffDecision;
  /** Continue or stop. PROVISIONAL continues, with the outstanding list attached. */
  proceed: boolean;
  /** One sentence a salesperson can act on. Missing facts and conflicts are visible here. */
  reason: string;
  /** What technical is told is still unknown. The reason PROVISIONAL is safe to use. */
  outstanding: Outstanding[];
  blockers: Finding[];
  /** What should happen next, after the checker has had its say. */
  next_step: ProposedNextStep;
}

/* =======================================================================================
 * The assembled run
 * ===================================================================================== */

/** The three role outputs of one run, before persistence. Pure: no ids, no timestamps. */
export interface HandoffResult {
  context: HandoffContext;
  brief: Brief;
  review: Review;
  decision: Decision;
}

/** A persisted run, as the UI reads it back. */
export interface HandoffRunRecord {
  id: Id;
  opportunity_id: Id;
  opportunity_code: string;
  context_snapshot: HandoffContext;
  brief: Brief;
  review: Review;
  decision: HandoffDecision;
  decision_reason: string;
  policy_version: string;
  created_at: string;
}
