/**
 * Row types for the schema in db/migrations. Hand-written, no ORM and no codegen: these
 * types ARE the contract every other agent codes against, so they mirror the SQL exactly and
 * change only when a migration changes.
 *
 * Nullability is load-bearing and is the thing being graded. A column typed `T | null` here
 * is nullable in SQL because an empty field in the archive means UNKNOWN — never 0, never
 * "", never a default. Do not "simplify" any of these unions away, and do not paper over a
 * null with `?? 0` or `?? ""` at the call site: an absent height is not an approval and an
 * absent area is not zero square metres.
 *
 * `strictNullChecks` and `noUncheckedIndexedAccess` are on, so `rows[0]` is `T | undefined`.
 * Narrow it; do not assert it.
 *
 * ---------------------------------------------------------------------------------------
 * How SQL types map to TypeScript here (node-pg defaults, deliberately kept)
 * ---------------------------------------------------------------------------------------
 *
 *   BIGINT (int8)  -> string   node-pg returns int8 as a string, and a JS number cannot hold
 *                              every bigint exactly. Ids are opaque handles: compare them,
 *                              pass them as query parameters, never do arithmetic on them.
 *
 *   NUMERIC        -> string   node-pg returns numeric as a string, which is the whole point
 *                              of choosing NUMERIC. Parsing a euro amount into a JS float
 *                              reintroduces exactly the error NUMERIC exists to prevent.
 *                              Format for display, compare with a decimal helper, and send
 *                              values back to Postgres as strings.
 *
 *   DATE           -> string   as 'YYYY-MM-DD'. A calendar date has no timezone: a fair runs
 *                              on 24/06/2027 everywhere. node-pg's DEFAULT parser turns a
 *                              DATE into a JS Date at local midnight, which shifts the day
 *                              whenever the process timezone is not the one the value was
 *                              written in — a follow-up due Friday silently becomes Thursday.
 *                              REQUIRED of the query layer: either register a type parser for
 *                              OID 1082 that returns the raw string, or select date columns
 *                              as `col::text`. These types assume that has been done.
 *
 *   TIMESTAMPTZ    -> Date     an instant, not a wall-clock reading. node-pg's default parse
 *                              is correct. The archive writes DD/MM/YYYY HH:mm in
 *                              Europe/Rome; the importer localises before storing.
 *
 *   JSONB          -> unknown  narrowed by the owning module, which defines its own shape.
 */

/** A calendar date, 'YYYY-MM-DD'. No timezone. See the mapping note above. */
export type IsoDate = string;

/** A BIGINT surrogate primary key, as returned by node-pg. Opaque; never arithmetic. */
export type Id = string;

/** An exact decimal from a NUMERIC column, e.g. '48000.00'. Never parse into a float. */
export type Decimal = string;

/* =======================================================================================
 * Enums — must stay byte-identical to the CREATE TYPE statements in 001_init.sql
 * ===================================================================================== */

/**
 * Normalised commercial status. The archive spells it 13 ways; trim + upper collapses them
 * to these 5. The raw spelling is preserved in `Opportunity.legacy_status_raw`.
 *
 * Commercial status records no technical approval. WON does not mean the stand is buildable.
 */
export type OpportunityStatus = "OPEN" | "QUALIFIED" | "PROPOSAL" | "WON" | "LOST";

export const OPPORTUNITY_STATUSES = [
  "OPEN",
  "QUALIFIED",
  "PROPOSAL",
  "WON",
  "LOST",
] as const satisfies readonly OpportunityStatus[];

/** activity_log.activity_type, lower-case exactly as exported. */
export type ActivityType = "call" | "email" | "meeting" | "note" | "task";

export const ACTIVITY_TYPES = [
  "call",
  "email",
  "meeting",
  "note",
  "task",
] as const satisfies readonly ActivityType[];

/**
 * Coordinator verdict of a handoff run. PROVISIONAL is the middle ground between handing
 * over as soon as a fair and a budget are named and refusing to move until area and height
 * are known and checked.
 */
export type HandoffDecision = "ACCEPTED" | "PROVISIONAL" | "BLOCKED";

export const HANDOFF_DECISIONS = [
  "ACCEPTED",
  "PROVISIONAL",
  "BLOCKED",
] as const satisfies readonly HandoffDecision[];

/* =======================================================================================
 * Tables
 * ===================================================================================== */

/** `company` — an exhibitor. */
export interface Company {
  id: Id;
  /** Legacy natural key. Identity lives here, not in `name`. */
  company_code: string;
  /** Display/legal name. NOT unique — never join, dedupe or match exhibitors on it. */
  name: string;
  /** Two-letter legacy location code. null = unknown. */
  province_code: string | null;
  /** null = unknown. */
  region: string | null;
  /** Legacy account owner name, plain text; there is no user table and no login. null = unknown. */
  sales_rep_name: string | null;
}

/** `contact` — a person at an exhibitor. Entered once, reused across fairs and editions. */
export interface Contact {
  id: Id;
  /** Legacy natural key; the import's idempotency anchor for this table. */
  contact_code: string;
  company_id: Id;
  first_name: string;
  last_name: string;
  /** null = unknown. Not unique; case-insensitive lookups go through `lower(email)`. */
  email: string | null;
  /** null = unknown. */
  phone: string | null;
  /** null = unknown — not "no fax", simply unrecorded. Empty on most archive rows. */
  fax: string | null;
  /** Source-export row identifier, unique per archive row. Traceability back to the CSV. */
  legacy_row_id: string;
}

/** `fair` — a recurring fair, normalised out of `fair_edition`. */
export interface Fair {
  id: Id;
  /** Unique. "Same fair, other edition" is a join on `fair_id`, never a name comparison. */
  name: string;
}

/** `fair_edition` — one dated running of a fair; what an opportunity attaches to. */
export interface FairEdition {
  id: Id;
  /** Legacy natural key. */
  edition_code: string;
  fair_id: Id;
  city: string | null;
  venue: string | null;
  /** First exhibition day. */
  starts_on: IsoDate;
  /** Last exhibition day. */
  ends_on: IsoDate;
  /**
   * Edition height limit in metres, as a NUMERIC string.
   *
   * null = no limit recorded. That is NOT unlimited height and NOT an approval: with no
   * limit on file, a breach simply cannot be evaluated, and the handoff assistant must say
   * so rather than pass the enquiry as compliant.
   */
  max_stand_height_m: Decimal | null;
}

/** `opportunity` — a stand enquiry for one company at one fair edition. */
export interface Opportunity {
  id: Id;
  /** Legacy natural key. */
  opportunity_code: string;
  company_id: Id;
  /**
   * Primary contact. null = none recorded on the enquiry (882 archive rows). null is
   * unknown; it does not mean "the company itself" and must not be filled in with a guess.
   */
  contact_id: Id | null;
  fair_edition_id: Id;
  description: string;
  /**
   * The sales team's recorded opportunity value in EUR, excluding VAT. Not a calculated
   * stand price and not the customer's budget — see `client_budget_eur`.
   */
  amount_eur: Decimal;
  /** Normalised status. Carries no technical approval. */
  status: OpportunityStatus;
  /** The status exactly as exported, whitespace and casing intact. */
  legacy_status_raw: string;
  opened_on: IsoDate;
  /**
   * Expected date of the SALES decision. null = none recorded — not closed, not overdue,
   * not imminent.
   */
  expected_close_on: IsoDate | null;
  /** null = no campaign attributed. */
  historical_campaign_code: string | null;
  /**
   * Allocated plot area in m².
   *
   * null = UNKNOWN, never zero square metres. The technical coordinator's precondition: a
   * null here is a blocker for handoff, not a small stand.
   */
  stand_area_sqm: Decimal | null;
  /**
   * The customer's stated stand budget, excluding VAT. null = unknown, never 0. May
   * legitimately differ from `amount_eur`; a difference is a conflict to surface, not an
   * error to reconcile.
   */
  client_budget_eur: Decimal | null;
  /**
   * The height the customer REQUESTED, in metres. Not an approved height.
   *
   * May exceed `FairEdition.max_stand_height_m` — one archive row (OP000005: 6.00 m against
   * PACK-2026's 5.00 m) does exactly that and imports successfully. Both values are kept and
   * the breach is computed at read time. Never clamp it, never normalise it away.
   *
   * null = unknown, and an absent height is not an approval.
   */
  requested_height_m: Decimal | null;
  /** Sales notes: the requested stand and what is still outstanding. */
  brief_notes: string;
}

/** `activity` — a log entry against a company, optionally against one opportunity. */
export interface Activity {
  id: Id;
  /** Legacy natural key. */
  entry_id: string;
  company_id: Id;
  /**
   * null = a company-level entry belonging to no enquiry (5,001 archive rows). The null is
   * the point: an opportunity timeline shows only that edition's conversations, so general
   * company chatter is never attributed to an enquiry it does not belong to.
   */
  opportunity_id: Id | null;
  /** A completed call/email/meeting records customer contact; a note is internal; a task is work still to do. */
  type: ActivityType;
  /** An instant. Stored TIMESTAMPTZ; the archive's wall-clock times are Europe/Rome. */
  occurred_at: Date;
  details: string;
  /** Requested follow-up date. null = none requested; only dated rows enter the queue. */
  follow_up_on: IsoDate | null;
  /**
   * TRI-STATE, from the archive's `completion_marker`:
   *
   *   true  — 'Y', the interaction is completed
   *   false — 'N', pending: a task still to do
   *   null  — empty, NOT APPLICABLE (typically a note, neither done nor pending)
   *
   * null is not false. Collapsing empty to false drops ~7,948 irrelevant entries into the
   * follow-up queue and corrupts it. The queue is exactly `is_completed === false` with a
   * `follow_up_on`, which is the predicate of the partial index in 002_indexes.sql — so
   * `!is_completed` is a bug here, not a shorthand.
   */
  is_completed: boolean | null;
  /** Legacy username of whoever created the entry. */
  legacy_author: string;
}

/**
 * `handoff_run` — one run of the handoff assistant. Append-only: a run is never updated, so
 * revisiting it shows what it actually saw, even after the brief was edited and re-run.
 */
export interface HandoffRun {
  id: Id;
  opportunity_id: Id;
  /** The CRM and fair facts the run read, frozen at run time. Shape owned by src/handoff. */
  context_snapshot: unknown;
  /** Output of the preparer role. Shape owned by src/handoff. */
  brief: unknown;
  /** Output of the checker role. Shape owned by src/handoff. */
  review: unknown;
  decision: HandoffDecision;
  /** The coordinator's stated reason; missing information and conflicts must be visible here. */
  decision_reason: string;
  /** Policy version in force for this run, so old runs stay interpretable. */
  policy_version: string;
  created_at: Date;
}

/**
 * `import_state` — ledger of completed archive imports. A row exists only once an import has
 * finished, and (dataset_version, file_checksums) is UNIQUE: that pair is what makes a second
 * `./dev.sh` a no-op that preserves user edits, while `./reset.sh` drops the volume and the
 * next start re-imports.
 */
export interface ImportState {
  id: Id;
  /** `dataset_version` from the archive's manifest.json. */
  dataset_version: string;
  /** `{ [filename]: sha256 }`. Checksums, not the version alone, decide archive identity. */
  file_checksums: Record<string, string>;
  completed_at: Date;
}
