/**
 * Reading the facts a handoff run is allowed to use, and writing the runs back.
 *
 * Every date leaves Postgres as text and every instant leaves it as an ISO-8601 UTC string,
 * cast in SQL rather than parsed in JS. Two reasons: a calendar date has no timezone and
 * must not be dragged across one, and a context snapshot has to serialise to the same bytes
 * whatever the server's TZ happens to be — which is the determinism guarantee, applied to
 * the input rather than the model.
 *
 * Both queries are single-row or index-driven lookups by id, so they stay flat at
 * 100,000 contacts: `opportunity_opportunity_code_key`, `activity_opportunity_occurred_idx`,
 * `activity_follow_up_queue_idx` and `handoff_run_opportunity_created_idx` cover them.
 */
import type { Pool, PoolClient } from "pg";
import type { Id } from "../db/schema";
import {
  CONTEXT_SNAPSHOT_VERSION,
  type ContextActivity,
  type HandoffContext,
  type HandoffRunRecord,
} from "./types";

/** Anything that can run a query: the shared pool, or a client inside a transaction. */
export type Db = Pool | PoolClient;

/** Instants are rendered in SQL, so nothing here depends on the process timezone. */
const ISO_INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** How much of the enquiry's own history a run reads. Opportunity-scoped, never company-wide. */
export const RECENT_ACTIVITY_LIMIT = 10;

export class OpportunityNotFoundError extends Error {
  constructor(public readonly lookup: string) {
    super(`No opportunity found for ${lookup}`);
    this.name = "OpportunityNotFoundError";
  }
}

interface OpportunityRow {
  id: string;
  opportunity_code: string;
  description: string;
  amount_eur: string;
  client_budget_eur: string | null;
  status: HandoffContext["opportunity"]["status"];
  legacy_status_raw: string;
  opened_on: string;
  expected_close_on: string | null;
  stand_area_sqm: string | null;
  requested_height_m: string | null;
  brief_notes: string;
  company_code: string;
  company_name: string;
  province_code: string | null;
  region: string | null;
  sales_rep_name: string | null;
  contact_code: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  edition_code: string | null;
  fair_name: string | null;
  city: string | null;
  venue: string | null;
  starts_on: string | null;
  ends_on: string | null;
  max_stand_height_m: string | null;
}

const OPPORTUNITY_SELECT = `
  SELECT o.id,
         o.opportunity_code,
         o.description,
         o.amount_eur,
         o.client_budget_eur,
         o.status,
         o.legacy_status_raw,
         o.opened_on::text          AS opened_on,
         o.expected_close_on::text  AS expected_close_on,
         o.stand_area_sqm,
         o.requested_height_m,
         o.brief_notes,
         c.company_code,
         c.name                     AS company_name,
         c.province_code,
         c.region,
         c.sales_rep_name,
         ct.contact_code,
         ct.first_name              AS contact_first_name,
         ct.last_name               AS contact_last_name,
         ct.email                   AS contact_email,
         ct.phone                   AS contact_phone,
         fe.edition_code,
         f.name                     AS fair_name,
         fe.city,
         fe.venue,
         fe.starts_on::text         AS starts_on,
         fe.ends_on::text           AS ends_on,
         fe.max_stand_height_m
    FROM opportunity o
    JOIN company c       ON c.id  = o.company_id
    LEFT JOIN contact ct ON ct.id = o.contact_id
    LEFT JOIN fair_edition fe ON fe.id = o.fair_edition_id
    LEFT JOIN fair f          ON f.id  = fe.fair_id
`;

interface ActivityRow {
  entry_id: string;
  type: ContextActivity["type"];
  occurred_at: string;
  details: string;
  follow_up_on: string | null;
  is_completed: boolean | null;
  legacy_author: string;
}

const ACTIVITY_SELECT = `
  SELECT a.entry_id,
         a.type,
         to_char(a.occurred_at AT TIME ZONE 'UTC', ${ISO_INSTANT}) AS occurred_at,
         a.details,
         a.follow_up_on::text AS follow_up_on,
         a.is_completed,
         a.legacy_author
    FROM activity a
`;

function toContext(row: OpportunityRow, recent: ActivityRow[], followUps: ActivityRow[]): HandoffContext {
  return {
    snapshot_version: CONTEXT_SNAPSHOT_VERSION,
    opportunity_id: row.id,
    company: {
      company_code: row.company_code,
      name: row.company_name,
      province_code: row.province_code,
      region: row.region,
      sales_rep_name: row.sales_rep_name,
    },
    contact:
      row.contact_code === null
        ? null
        : {
            contact_code: row.contact_code,
            first_name: row.contact_first_name ?? "",
            last_name: row.contact_last_name ?? "",
            email: row.contact_email,
            phone: row.contact_phone,
          },
    opportunity: {
      opportunity_code: row.opportunity_code,
      description: row.description,
      amount_eur: row.amount_eur,
      client_budget_eur: row.client_budget_eur,
      status: row.status,
      legacy_status_raw: row.legacy_status_raw,
      opened_on: row.opened_on,
      expected_close_on: row.expected_close_on,
      stand_area_sqm: row.stand_area_sqm,
      requested_height_m: row.requested_height_m,
      brief_notes: row.brief_notes,
    },
    fair_edition:
      row.edition_code === null || row.starts_on === null || row.ends_on === null
        ? null
        : {
            edition_code: row.edition_code,
            fair_name: row.fair_name ?? row.edition_code,
            city: row.city,
            venue: row.venue,
            starts_on: row.starts_on,
            ends_on: row.ends_on,
            // Left null when the edition records no limit. Not a limit of infinity.
            max_stand_height_m: row.max_stand_height_m,
          },
    recent_activity: recent,
    open_follow_ups: followUps,
  };
}

async function loadActivity(db: Db, opportunityId: Id): Promise<{ recent: ActivityRow[]; followUps: ActivityRow[] }> {
  // Only this enquiry's conversations. Company-level entries (opportunity_id IS NULL) are
  // deliberately excluded: last year's agreement must not surface inside this year's brief.
  const recent = await db.query<ActivityRow>(
    `${ACTIVITY_SELECT}
      WHERE a.opportunity_id = $1
      ORDER BY a.occurred_at DESC, a.entry_id DESC
      LIMIT ${RECENT_ACTIVITY_LIMIT}`,
    [opportunityId],
  );

  // The follow-up queue predicate exactly: pending AND dated. `is_completed = FALSE`, never
  // `NOT is_completed` — null means "not applicable", not "pending".
  const followUps = await db.query<ActivityRow>(
    `${ACTIVITY_SELECT}
      WHERE a.opportunity_id = $1
        AND a.is_completed = FALSE
        AND a.follow_up_on IS NOT NULL
      ORDER BY a.follow_up_on ASC, a.entry_id ASC
      LIMIT ${RECENT_ACTIVITY_LIMIT}`,
    [opportunityId],
  );

  return { recent: recent.rows, followUps: followUps.rows };
}

/** Read everything a run is allowed to use, by legacy opportunity code. */
export async function loadContextByCode(db: Db, opportunityCode: string): Promise<HandoffContext> {
  const { rows } = await db.query<OpportunityRow>(
    `${OPPORTUNITY_SELECT} WHERE o.opportunity_code = $1`,
    [opportunityCode],
  );
  const row = rows[0];
  if (row === undefined) throw new OpportunityNotFoundError(`opportunity_code ${opportunityCode}`);

  const { recent, followUps } = await loadActivity(db, row.id);
  return toContext(row, recent, followUps);
}

/** Read everything a run is allowed to use, by surrogate id (what the UI holds in a URL). */
export async function loadContextById(db: Db, opportunityId: Id): Promise<HandoffContext> {
  const { rows } = await db.query<OpportunityRow>(`${OPPORTUNITY_SELECT} WHERE o.id = $1`, [
    opportunityId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new OpportunityNotFoundError(`opportunity id ${opportunityId}`);

  const { recent, followUps } = await loadActivity(db, row.id);
  return toContext(row, recent, followUps);
}

/* =======================================================================================
 * handoff_run — append only
 * ===================================================================================== */

interface RunRow {
  id: string;
  opportunity_id: string;
  opportunity_code: string;
  context_snapshot: HandoffContext;
  brief: HandoffRunRecord["brief"];
  review: HandoffRunRecord["review"];
  decision: HandoffRunRecord["decision"];
  decision_reason: string;
  policy_version: string;
  created_at: string;
}

const RUN_SELECT = `
  SELECT r.id,
         r.opportunity_id,
         o.opportunity_code,
         r.context_snapshot,
         r.brief,
         r.review,
         r.decision,
         r.decision_reason,
         r.policy_version,
         to_char(r.created_at AT TIME ZONE 'UTC', ${ISO_INSTANT}) AS created_at
    FROM handoff_run r
    JOIN opportunity o ON o.id = r.opportunity_id
`;

export interface InsertRunInput {
  opportunity_id: Id;
  context_snapshot: unknown;
  brief: unknown;
  review: unknown;
  decision: HandoffRunRecord["decision"];
  decision_reason: string;
  policy_version: string;
}

/**
 * Append one run. There is no update path in this module and there must not be one: editing
 * the brief and running again adds a row, so the earlier run stays readable exactly as it
 * was decided, under the policy version it was decided under.
 */
export async function insertRun(db: Db, input: InsertRunInput): Promise<{ id: Id; created_at: string }> {
  const { rows } = await db.query<{ id: string; created_at: string }>(
    `INSERT INTO handoff_run
       (opportunity_id, context_snapshot, brief, review, decision, decision_reason, policy_version)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING id, to_char(created_at AT TIME ZONE 'UTC', ${ISO_INSTANT}) AS created_at`,
    [
      input.opportunity_id,
      JSON.stringify(input.context_snapshot),
      JSON.stringify(input.brief),
      JSON.stringify(input.review),
      input.decision,
      input.decision_reason,
      input.policy_version,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error("handoff_run insert returned no row");
  return { id: row.id, created_at: row.created_at };
}

/** Runs for one opportunity, newest first — the order the UI lists them in. */
export async function selectRunsForOpportunity(
  db: Db,
  opportunityId: Id,
  limit = 50,
): Promise<HandoffRunRecord[]> {
  const { rows } = await db.query<RunRow>(
    `${RUN_SELECT}
      WHERE r.opportunity_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    [opportunityId, limit],
  );
  return rows;
}

/** One stored run, by id. Returns null when it does not exist. */
export async function selectRun(db: Db, runId: Id): Promise<HandoffRunRecord | null> {
  const { rows } = await db.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
  return rows[0] ?? null;
}
