/**
 * Every SQL statement the screens run, in one file so the access paths can be reviewed
 * against db/migrations/002_indexes.sql side by side.
 *
 * Rules that are not negotiable here:
 *
 *   * Parameterised SQL only. No value is ever interpolated into a statement string.
 *   * No `SELECT *`. Each query names the columns the screen actually renders, so adding a
 *     column to a table never silently widens a 100,000-row read.
 *   * Every everyday query is written to MATCH an existing index, verbatim where the index
 *     is an expression or a partial one. The comment above each query names the index it
 *     relies on. If a query's shape changes, the index match has to be re-checked with
 *     EXPLAIN -- an expression index is only used when the query repeats the expression
 *     exactly, and a partial index only when the predicate is spelled the same way.
 *   * Dates come back as 'YYYY-MM-DD' strings because src/db/pool.ts registers a type
 *     parser for OID 1082. NUMERIC comes back as an exact decimal string. Neither is parsed
 *     into a JS number anywhere in this application.
 */

import { pool } from "@/db/pool";
import type {
  ActivityType,
  Decimal,
  Id,
  IsoDate,
  OpportunityStatus,
} from "@/db/schema";
import { toLikePattern } from "./format";

/* =======================================================================================
 * Search
 * ===================================================================================== */

export interface CompanyHit {
  id: Id;
  company_code: string;
  name: string;
  province_code: string | null;
  region: string | null;
  sales_rep_name: string | null;
}

export interface ContactHit {
  id: Id;
  contact_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company_code: string;
  company_name: string;
  region: string | null;
  sales_rep_name: string | null;
}

/** A page of results plus whether another page exists, from a LIMIT n+1 lookahead. */
export interface Page<T> {
  rows: T[];
  hasMore: boolean;
}

function toPage<T>(rows: T[], limit: number): Page<T> {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Company name search.
 *
 * Index: company_name_trgm_idx -- GIN (name gin_trgm_ops). A leading-wildcard ILIKE cannot
 * use a btree at all; the trigram GIN is what keeps this off a sequential scan of 100,000
 * companies. similarity() only runs on the rows the index already matched, so the ranking
 * costs nothing extra.
 *
 * The caller guarantees term.length >= MIN_SEARCH_LENGTH: a one- or two-character pattern
 * contains no whole trigram and the index could not be used for it.
 */
export async function searchCompanies(
  term: string,
  limit: number,
  offset: number,
): Promise<Page<CompanyHit>> {
  const { rows } = await pool.query<CompanyHit>(
    `SELECT c.id,
            c.company_code,
            c.name,
            c.province_code,
            c.region,
            c.sales_rep_name
       FROM company c
      WHERE c.name ILIKE $1
      ORDER BY similarity(c.name, $2) DESC, c.name, c.id
      LIMIT $3 OFFSET $4`,
    [toLikePattern(term), term, limit + 1, offset],
  );
  return toPage(rows, limit);
}

/**
 * Contact search across the whole name, because people type "giulia de luca" rather than
 * choosing a field.
 *
 * Index: contact_full_name_trgm_idx -- GIN ((first_name || ' ' || last_name) gin_trgm_ops).
 * The expression below is byte-identical to the indexed one on purpose; change the spacing
 * and the planner stops matching it. This is the index that carries the 100,000-contact
 * requirement.
 *
 * The match, the ranking and the LIMIT happen in the subquery, BEFORE the company join.
 * Written as a flat join instead, a common surname matches a thousand contacts, the planner
 * decides hashing every company is cheaper than a thousand index probes, and the search path
 * acquires a sequential scan of the company table. Joining after the limit leaves at most
 * one page of primary-key lookups, whatever the term matches.
 */
export async function searchContacts(
  term: string,
  limit: number,
  offset: number,
): Promise<Page<ContactHit>> {
  const { rows } = await pool.query<ContactHit>(
    `SELECT ct.id,
            ct.contact_code,
            ct.first_name,
            ct.last_name,
            ct.email,
            ct.phone,
            co.company_code,
            co.name           AS company_name,
            co.region,
            co.sales_rep_name
       FROM (
              SELECT c.id, c.contact_code, c.first_name, c.last_name,
                     c.email, c.phone, c.company_id
                FROM contact c
               WHERE (c.first_name || ' ' || c.last_name) ILIKE $1
               ORDER BY similarity(c.first_name || ' ' || c.last_name, $2) DESC,
                        c.last_name, c.first_name, c.id
               LIMIT $3 OFFSET $4
            ) ct
       JOIN company co ON co.id = ct.company_id
      ORDER BY similarity(ct.first_name || ' ' || ct.last_name, $2) DESC,
               ct.last_name, ct.first_name, ct.id`,
    [toLikePattern(term), term, limit + 1, offset],
  );
  return toPage(rows, limit);
}

/**
 * The front door with an empty search box: exhibitors in alphabetical order.
 *
 * Index: company_name_id_idx -- btree (name, id). The trigram GIN cannot order, so this is
 * what makes the default page an index scan instead of a sort of every company. id breaks
 * ties because names are NOT unique.
 */
export async function listCompanies(limit: number, offset: number): Promise<Page<CompanyHit>> {
  const { rows } = await pool.query<CompanyHit>(
    `SELECT c.id,
            c.company_code,
            c.name,
            c.province_code,
            c.region,
            c.sales_rep_name
       FROM company c
      ORDER BY c.name, c.id
      LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  return toPage(rows, limit);
}

/**
 * The figures on the front page.
 *
 * The three big ones are PLANNER ESTIMATES, read from pg_class.reltuples, not exact counts.
 * `SELECT count(*) FROM company` is a sequential scan, and putting three of them on the
 * search screen would mean scanning every company, contact and opportunity on every
 * keystroke-sized page load -- precisely the defect the 100,000-contact target rules out.
 * The number is a sense of scale, so an estimate is the honest cost/benefit, and the screen
 * marks it with a "≈" rather than pretending to an accuracy it did not pay for.
 *
 * The follow-up figure IS exact: it comes from the small partial index as an index-only
 * scan, and a queue you are told to act on should not be approximate.
 *
 * reltuples is -1 on a table that has never been analysed (a brand-new database before
 * autovacuum's first pass). That is reported as null -- unknown, not zero -- and the screen
 * simply omits the figure rather than claiming the archive is empty.
 */
export interface FairEditionOption {
  id: Id;
  edition_code: string;
  fair_name: string;
  city: string | null;
  starts_on: IsoDate;
  ends_on: IsoDate;
  max_stand_height_m: Decimal | null;
}

/**
 * Every edition, for the "open a new enquiry" picker.
 *
 * No index note and no pagination: the archive holds sixteen editions and a fair calendar is
 * not a table that grows with the customer base. The height limit travels with the option so
 * the picker can state the rule the enquiry will be judged against BEFORE it is created --
 * the operator should see "5,00 m allowed" while choosing, not discover it from a BLOCKED
 * handoff afterwards.
 */
export async function listFairEditions(): Promise<FairEditionOption[]> {
  const { rows } = await pool.query<FairEditionOption>(
    `SELECT fe.id,
            fe.edition_code,
            f.name AS fair_name,
            fe.city,
            fe.starts_on,
            fe.ends_on,
            fe.max_stand_height_m
       FROM fair_edition fe
       JOIN fair f ON f.id = fe.fair_id
      ORDER BY f.name, fe.starts_on DESC`,
  );
  return rows;
}

export interface NewOpportunity {
  company_id: Id;
  contact_id: Id | null;
  fair_edition_id: Id;
  description: string;
  /** null = sales has put no figure on it yet. Never 0. */
  amount_eur: Decimal | null;
  opened_on: IsoDate;
  brief_notes: string;
}

/**
 * Opens an enquiry from the company screen and returns its new code.
 *
 * The code is allocated inside the INSERT, from the highest OP-number already present. It is
 * not a sequence: the archive brings its own codes (OP000001..OP015000 today) and a sequence
 * seeded at 1 would collide with every one of them on the first insert after a reset. Reading
 * the maximum in the same statement that writes the row keeps allocation and insertion atomic
 * against the statement's snapshot.
 *
 * Two concurrent creations can still read the same maximum and race, so the unique constraint
 * is treated as the arbiter and the loser simply retries. That is the correct division of
 * labour: the database decides, the application does not pretend to have prevented it.
 *
 * status is OPEN and legacy_status_raw is NULL -- see db/migrations/004_new_enquiries.sql.
 */
export async function insertOpportunity(entry: NewOpportunity): Promise<string> {
  const statement = `
    INSERT INTO opportunity (
      opportunity_code, company_id, contact_id, fair_edition_id, description,
      amount_eur, status, legacy_status_raw, opened_on, brief_notes
    )
    SELECT 'OP' || lpad(
             (COALESCE(max(substring(o.opportunity_code FROM 3)::bigint), 0) + 1)::text, 6, '0'),
           $1::bigint, $2::bigint, $3::bigint, $4::text,
           $5::numeric, 'OPEN', NULL, $6::date, $7::text
      FROM opportunity o
     WHERE o.opportunity_code ~ '^OP[0-9]+$'
    RETURNING opportunity_code
  `;
  const values = [
    entry.company_id,
    entry.contact_id,
    entry.fair_edition_id,
    entry.description,
    entry.amount_eur,
    entry.opened_on,
    entry.brief_notes,
  ];

  for (let attempt = 0; ; attempt += 1) {
    try {
      const { rows } = await pool.query<{ opportunity_code: string }>(statement, values);
      const created = rows[0];
      // RETURNING on a successful single-row INSERT always yields one row; this guards the
      // type rather than a real possibility.
      if (created === undefined) throw new Error("The enquiry was not created.");
      return created.opportunity_code;
    } catch (error) {
      const duplicate =
        typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
      if (!duplicate || attempt >= 2) throw error;
    }
  }
}

export interface ArchiveTotals {
  companies: number | null;
  contacts: number | null;
  opportunities: number | null;
  open_follow_ups: number;
  /** Cheap existence probe, so "no data yet" is never inferred from an estimate. */
  has_data: boolean;
}

export async function getArchiveTotals(): Promise<ArchiveTotals> {
  const [estimates, exact] = await Promise.all([
    pool.query<{ relname: string; estimate: string }>(
      `SELECT c.relname::text AS relname,
              c.reltuples::bigint AS estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('company', 'contact', 'opportunity')`,
    ),
    pool.query<{ open_follow_ups: string; has_data: boolean }>(
      `SELECT (SELECT count(*) FROM activity
                WHERE is_completed = FALSE
                  AND follow_up_on IS NOT NULL) AS open_follow_ups,
              EXISTS (SELECT 1 FROM company)    AS has_data`,
    ),
  ]);

  const estimate = (relname: string): number | null => {
    const raw = estimates.rows.find((row) => row.relname === relname)?.estimate;
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };

  const row = exact.rows[0];
  return {
    companies: estimate("company"),
    contacts: estimate("contact"),
    opportunities: estimate("opportunity"),
    open_follow_ups: Number(row?.open_follow_ups ?? 0),
    has_data: row?.has_data ?? false,
  };
}

/* =======================================================================================
 * Company detail
 * ===================================================================================== */

export interface CompanyRecord {
  id: Id;
  company_code: string;
  name: string;
  province_code: string | null;
  region: string | null;
  sales_rep_name: string | null;
}

/** Lookup by the legacy code, never by name: company names are not unique. */
export async function getCompanyByCode(code: string): Promise<CompanyRecord | null> {
  const { rows } = await pool.query<CompanyRecord>(
    `SELECT id, company_code, name, province_code, region, sales_rep_name
       FROM company
      WHERE company_code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

export interface CompanyContact {
  id: Id;
  contact_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  fax: string | null;
  opportunity_count: string;
}

/**
 * The company's people. Index: contact_company_idx -- btree (company_id).
 * The correlated count uses opportunity_contact_idx and is bounded by this company's
 * contact list, which is a handful of rows.
 */
export async function getCompanyContacts(companyId: Id): Promise<CompanyContact[]> {
  const { rows } = await pool.query<CompanyContact>(
    `SELECT ct.id,
            ct.contact_code,
            ct.first_name,
            ct.last_name,
            ct.email,
            ct.phone,
            ct.fax,
            (SELECT count(*) FROM opportunity o WHERE o.contact_id = ct.id) AS opportunity_count
       FROM contact ct
      WHERE ct.company_id = $1
      ORDER BY ct.last_name, ct.first_name, ct.id
      LIMIT 500`,
    [companyId],
  );
  return rows;
}

export interface CompanyOpportunity {
  id: Id;
  opportunity_code: string;
  description: string;
  amount_eur: Decimal | null;
  status: OpportunityStatus;
  legacy_status_raw: string | null;
  opened_on: IsoDate;
  expected_close_on: IsoDate | null;
  stand_area_sqm: Decimal | null;
  client_budget_eur: Decimal | null;
  requested_height_m: Decimal | null;
  contact_code: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  fair_id: Id;
  fair_name: string;
  edition_code: string;
  edition_city: string | null;
  edition_starts_on: IsoDate;
  edition_ends_on: IsoDate;
  max_stand_height_m: Decimal | null;
}

/**
 * Every enquiry this exhibitor has ever raised, with the edition each one belongs to, so a
 * returning exhibitor reads as a history. Grouping by fair happens in the page, on rows the
 * database already returned in fair / edition order.
 *
 * Index: opportunity_company_edition_idx -- btree (company_id, fair_edition_id), whose
 * leading column serves this lookup. The joins are primary-key probes on fair_edition,
 * fair and contact.
 */
export async function getCompanyOpportunities(companyId: Id): Promise<CompanyOpportunity[]> {
  const { rows } = await pool.query<CompanyOpportunity>(
    `SELECT o.id,
            o.opportunity_code,
            o.description,
            o.amount_eur,
            o.status,
            o.legacy_status_raw,
            o.opened_on,
            o.expected_close_on,
            o.stand_area_sqm,
            o.client_budget_eur,
            o.requested_height_m,
            ct.contact_code             AS contact_code,
            ct.first_name               AS contact_first_name,
            ct.last_name                AS contact_last_name,
            f.id                        AS fair_id,
            f.name                      AS fair_name,
            fe.edition_code,
            fe.city                     AS edition_city,
            fe.starts_on                AS edition_starts_on,
            fe.ends_on                  AS edition_ends_on,
            fe.max_stand_height_m
       FROM opportunity o
       JOIN fair_edition fe ON fe.id = o.fair_edition_id
       JOIN fair f          ON f.id  = fe.fair_id
       LEFT JOIN contact ct ON ct.id = o.contact_id
      WHERE o.company_id = $1
      ORDER BY f.name, fe.starts_on DESC, o.opened_on DESC, o.id
      LIMIT 500`,
    [companyId],
  );
  return rows;
}

export interface ActivityRow {
  id: Id;
  entry_id: string;
  type: ActivityType;
  occurred_at: Date;
  details: string;
  follow_up_on: IsoDate | null;
  is_completed: boolean | null;
  legacy_author: string;
}

/**
 * Company-wide entries ONLY: opportunity_id IS NULL. ~5,001 archive rows belong to the
 * exhibitor rather than to any enquiry, and attributing them to an enquiry is exactly the
 * mistake the sales coordinator is complaining about. They are shown here, under their own
 * heading, and nowhere else.
 *
 * Index: activity_company_occurred_idx -- btree (company_id, occurred_at DESC), which
 * supplies both the filter and the ordering.
 */
export async function getCompanyLevelActivity(
  companyId: Id,
  limit: number,
): Promise<ActivityRow[]> {
  const { rows } = await pool.query<ActivityRow>(
    `SELECT a.id,
            a.entry_id,
            a.type,
            a.occurred_at,
            a.details,
            a.follow_up_on,
            a.is_completed,
            a.legacy_author
       FROM activity a
      WHERE a.company_id = $1
        AND a.opportunity_id IS NULL
      ORDER BY a.occurred_at DESC
      LIMIT $2`,
    [companyId, limit],
  );
  return rows;
}

export interface ActivitySplit {
  company_level: number;
  enquiry_level: number;
}

/** How the exhibitor's log divides between company-wide and enquiry-scoped entries. */
export async function getCompanyActivitySplit(companyId: Id): Promise<ActivitySplit> {
  const { rows } = await pool.query<{ company_level: string; enquiry_level: string }>(
    `SELECT count(*) FILTER (WHERE a.opportunity_id IS NULL)     AS company_level,
            count(*) FILTER (WHERE a.opportunity_id IS NOT NULL) AS enquiry_level
       FROM activity a
      WHERE a.company_id = $1`,
    [companyId],
  );
  const row = rows[0];
  return {
    company_level: Number(row?.company_level ?? 0),
    enquiry_level: Number(row?.enquiry_level ?? 0),
  };
}

/* =======================================================================================
 * Opportunity detail
 * ===================================================================================== */

export interface OpportunityDetail {
  id: Id;
  opportunity_code: string;
  description: string;
  amount_eur: Decimal | null;
  status: OpportunityStatus;
  legacy_status_raw: string | null;
  opened_on: IsoDate;
  expected_close_on: IsoDate | null;
  historical_campaign_code: string | null;
  stand_area_sqm: Decimal | null;
  client_budget_eur: Decimal | null;
  requested_height_m: Decimal | null;
  brief_notes: string;

  company_id: Id;
  company_code: string;
  company_name: string;
  company_region: string | null;
  company_province: string | null;
  sales_rep_name: string | null;

  contact_code: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;

  fair_name: string;
  edition_code: string;
  edition_city: string | null;
  edition_venue: string | null;
  edition_starts_on: IsoDate;
  edition_ends_on: IsoDate;
  max_stand_height_m: Decimal | null;
}

/** Lookup by the legacy opportunity code (UNIQUE), joined out to everything the header shows. */
export async function getOpportunityByCode(code: string): Promise<OpportunityDetail | null> {
  const { rows } = await pool.query<OpportunityDetail>(
    `SELECT o.id,
            o.opportunity_code,
            o.description,
            o.amount_eur,
            o.status,
            o.legacy_status_raw,
            o.opened_on,
            o.expected_close_on,
            o.historical_campaign_code,
            o.stand_area_sqm,
            o.client_budget_eur,
            o.requested_height_m,
            o.brief_notes,
            co.id             AS company_id,
            co.company_code,
            co.name           AS company_name,
            co.region         AS company_region,
            co.province_code  AS company_province,
            co.sales_rep_name,
            ct.contact_code,
            ct.first_name     AS contact_first_name,
            ct.last_name      AS contact_last_name,
            ct.email          AS contact_email,
            ct.phone          AS contact_phone,
            f.name            AS fair_name,
            fe.edition_code,
            fe.city           AS edition_city,
            fe.venue          AS edition_venue,
            fe.starts_on      AS edition_starts_on,
            fe.ends_on        AS edition_ends_on,
            fe.max_stand_height_m
       FROM opportunity o
       JOIN company co      ON co.id = o.company_id
       JOIN fair_edition fe ON fe.id = o.fair_edition_id
       JOIN fair f          ON f.id  = fe.fair_id
       LEFT JOIN contact ct ON ct.id = o.contact_id
      WHERE o.opportunity_code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

/**
 * THIS enquiry's conversations, and nothing else. Not the company's other entries, not a
 * previous edition's. `opportunity_id = $1` is the whole point of the screen: people have
 * been reading last year's agreement as if it still applied.
 *
 * Index: activity_opportunity_occurred_idx -- btree (opportunity_id, occurred_at DESC):
 * filter and ordering in one, no sort node.
 */
export async function getOpportunityActivity(
  opportunityId: Id,
  limit: number,
): Promise<ActivityRow[]> {
  const { rows } = await pool.query<ActivityRow>(
    `SELECT a.id,
            a.entry_id,
            a.type,
            a.occurred_at,
            a.details,
            a.follow_up_on,
            a.is_completed,
            a.legacy_author
       FROM activity a
      WHERE a.opportunity_id = $1
      ORDER BY a.occurred_at DESC
      LIMIT $2`,
    [opportunityId, limit],
  );
  return rows;
}

/** Sibling enquiries: the same exhibitor at other editions. Cross-linked, never merged. */
export interface SiblingOpportunity {
  opportunity_code: string;
  status: OpportunityStatus;
  fair_name: string;
  edition_code: string;
  edition_starts_on: IsoDate;
}

export async function getSiblingOpportunities(
  companyId: Id,
  excludeId: Id,
): Promise<SiblingOpportunity[]> {
  const { rows } = await pool.query<SiblingOpportunity>(
    `SELECT o.opportunity_code,
            o.status,
            f.name       AS fair_name,
            fe.edition_code,
            fe.starts_on AS edition_starts_on
       FROM opportunity o
       JOIN fair_edition fe ON fe.id = o.fair_edition_id
       JOIN fair f          ON f.id  = fe.fair_id
      WHERE o.company_id = $1
        AND o.id <> $2
      ORDER BY fe.starts_on DESC, o.id
      LIMIT 25`,
    [companyId, excludeId],
  );
  return rows;
}

/*
 * Handoff run history is NOT read here. `listHandoffRuns` is exported by src/handoff and the
 * UI calls that — the engine owns the shape of its own runs, and the UI reaches its public
 * functions rather than its tables.
 */

/* =======================================================================================
 * Follow-up queue
 * ===================================================================================== */

export interface FollowUpRow {
  id: Id;
  entry_id: string;
  type: ActivityType;
  occurred_at: Date;
  details: string;
  follow_up_on: IsoDate;
  legacy_author: string;
  company_code: string;
  company_name: string;
  sales_rep_name: string | null;
  region: string | null;
  opportunity_code: string | null;
  opportunity_description: string | null;
  fair_name: string | null;
  edition_code: string | null;
}

export type FollowUpScope = "all" | "overdue" | "week";

/**
 * "A customer promised to confirm the floor area on Friday."
 *
 * THE PREDICATE IS THE POINT. `is_completed = FALSE AND follow_up_on IS NOT NULL` -- not
 * `NOT is_completed`, not `is_completed IS NOT TRUE`, not `COALESCE(is_completed, false)`.
 * is_completed is tri-state: NULL means NOT APPLICABLE (a note is neither done nor pending)
 * and there are ~7,948 such rows in the archive. Treating NULL as "not completed" would
 * drop every one of them into this queue and make it useless.
 *
 * It is also written this way because activity_follow_up_queue_idx is PARTIAL on exactly
 * this predicate -- `(follow_up_on, company_id) WHERE is_completed = FALSE AND follow_up_on
 * IS NOT NULL`. Spelled any other way the planner cannot prove the index covers the query
 * and falls back to a sequential scan of every activity row. The ORDER BY follows the index
 * key order so the queue comes out sorted without a sort node.
 *
 * The optional date bound is applied to follow_up_on, the index's leading column, so
 * "overdue" and "due this week" stay range scans on the same index.
 */
export async function getFollowUps(
  scope: FollowUpScope,
  referenceDate: IsoDate,
  limit: number,
  offset: number,
): Promise<Page<FollowUpRow>> {
  // Every bound applies to follow_up_on, the partial index's leading key, so a scoped queue
  // is a range scan on the same index rather than a different access path.
  //
  // "Overdue" is strictly before the reference date; "due within 7 days" starts AT it, so the
  // two views partition the queue instead of overlapping -- and each tab holds exactly the
  // number its counter above claims.
  const from: IsoDate | null = scope === "week" ? referenceDate : null;
  const strictlyBefore: IsoDate | null = scope === "overdue" ? referenceDate : null;
  const onOrBefore: IsoDate | null = scope === "week" ? weekBound(referenceDate) : null;

  const { rows } = await pool.query<FollowUpRow>(
    `SELECT a.id,
            a.entry_id,
            a.type,
            a.occurred_at,
            a.details,
            a.follow_up_on,
            a.legacy_author,
            co.company_code,
            co.name        AS company_name,
            co.sales_rep_name,
            co.region,
            o.opportunity_code,
            o.description  AS opportunity_description,
            f.name         AS fair_name,
            fe.edition_code
       FROM activity a
       JOIN company co           ON co.id = a.company_id
       LEFT JOIN opportunity o   ON o.id  = a.opportunity_id
       LEFT JOIN fair_edition fe ON fe.id = o.fair_edition_id
       LEFT JOIN fair f          ON f.id  = fe.fair_id
      WHERE a.is_completed = FALSE
        AND a.follow_up_on IS NOT NULL
        AND ($1::date IS NULL OR a.follow_up_on >= $1::date)
        AND ($2::date IS NULL OR a.follow_up_on <  $2::date)
        AND ($3::date IS NULL OR a.follow_up_on <= $3::date)
      ORDER BY a.follow_up_on, a.company_id, a.id
      LIMIT $4 OFFSET $5`,
    [from, strictlyBefore, onOrBefore, limit + 1, offset],
  );
  return toPage(rows, limit);
}

/** referenceDate + 7 calendar days, as 'YYYY-MM-DD'. Pure string/UTC arithmetic. */
function weekBound(referenceDate: IsoDate): IsoDate {
  const base = Date.UTC(
    Number(referenceDate.slice(0, 4)),
    Number(referenceDate.slice(5, 7)) - 1,
    Number(referenceDate.slice(8, 10)),
  );
  return new Date(base + 7 * 86_400_000).toISOString().slice(0, 10);
}

export interface FollowUpCounts {
  total: number;
  overdue: number;
  due_this_week: number;
  /** Rows the queue deliberately leaves out, shown so the exclusion is visible, not silent. */
  completed_with_date: number;
  not_applicable_with_date: number;
}

/**
 * The queue's own totals, plus the two populations it excludes. Both aggregate scans read
 * activity once; the queue counts come from the partial index.
 */
export async function getFollowUpCounts(referenceDate: IsoDate): Promise<FollowUpCounts> {
  const [queue, excluded] = await Promise.all([
    pool.query<{ total: string; overdue: string; due_this_week: string }>(
      `SELECT count(*)                                           AS total,
              count(*) FILTER (WHERE a.follow_up_on <  $1::date) AS overdue,
              count(*) FILTER (WHERE a.follow_up_on >= $1::date
                                 AND a.follow_up_on <= $2::date) AS due_this_week
         FROM activity a
        WHERE a.is_completed = FALSE
          AND a.follow_up_on IS NOT NULL`,
      [referenceDate, weekBound(referenceDate)],
    ),
    pool.query<{ completed_with_date: string; not_applicable_with_date: string }>(
      `SELECT count(*) FILTER (WHERE a.is_completed = TRUE)  AS completed_with_date,
              count(*) FILTER (WHERE a.is_completed IS NULL) AS not_applicable_with_date
         FROM activity a
        WHERE a.follow_up_on IS NOT NULL`,
    ),
  ]);
  const q = queue.rows[0];
  const e = excluded.rows[0];
  return {
    total: Number(q?.total ?? 0),
    overdue: Number(q?.overdue ?? 0),
    due_this_week: Number(q?.due_this_week ?? 0),
    completed_with_date: Number(e?.completed_with_date ?? 0),
    not_applicable_with_date: Number(e?.not_applicable_with_date ?? 0),
  };
}

/* =======================================================================================
 * Mutations
 * ===================================================================================== */

export interface OpportunityBriefPatch {
  /** NULL clears the value back to UNKNOWN. That is a legitimate edit, not a no-op. */
  stand_area_sqm: Decimal | null;
  requested_height_m: Decimal | null;
  client_budget_eur: Decimal | null;
  brief_notes: string;
}

/**
 * Saves the editable part of the brief. Writes NULL for a field left blank, because blank
 * means unknown -- the same meaning the archive's empty field carries. It never substitutes
 * 0, and the CHECK constraints in 001_init.sql would reject a 0 anyway.
 */
export async function updateOpportunityBrief(
  opportunityCode: string,
  patch: OpportunityBriefPatch,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE opportunity
        SET stand_area_sqm     = $2::numeric,
            requested_height_m = $3::numeric,
            client_budget_eur  = $4::numeric,
            brief_notes        = $5
      WHERE opportunity_code = $1`,
    [
      opportunityCode,
      patch.stand_area_sqm,
      patch.requested_height_m,
      patch.client_budget_eur,
      patch.brief_notes,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export interface StatusChange {
  opportunity_id: Id;
  company_id: Id;
  from: OpportunityStatus;
  to: OpportunityStatus;
  /** Free text the operator adds; may be empty. */
  reason: string;
  author: string;
  at: Date;
}

/**
 * Moves an enquiry along the commercial funnel and records that it moved.
 *
 * `opportunity.status` holds only the CURRENT value, so an UPDATE on its own destroys the
 * answer to "who marked this won, and when?". The transition is therefore also written as an
 * activity entry on the same enquiry, which is where this application already keeps history
 * -- no new table, and the change appears in the timeline beside the conversations that
 * caused it.
 *
 * Both writes go in ONE transaction. Half of this pair is worse than neither: a status with
 * no record of who moved it is exactly the gap the entry exists to close, and an entry
 * describing a move that did not happen is a lie in the timeline.
 *
 * The entry is a `note` with is_completed NULL -- not applicable. It is a fact about what
 * happened, not a task, and it must never appear in the follow-up queue.
 */
export async function changeOpportunityStatus(change: StatusChange): Promise<void> {
  const detail =
    change.reason === ""
      ? `Status moved from ${change.from} to ${change.to}.`
      : `Status moved from ${change.from} to ${change.to}. ${change.reason}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE opportunity SET status = $2::opportunity_status WHERE id = $1`, [
      change.opportunity_id,
      change.to,
    ]);
    await client.query(
      `INSERT INTO activity
              (entry_id, company_id, opportunity_id, type, occurred_at,
               details, follow_up_on, is_completed, legacy_author)
       VALUES ($1, $2, $3, 'note'::activity_type, $4, $5, NULL, NULL, $6)`,
      [
        `UI-${crypto.randomUUID()}`,
        change.company_id,
        change.opportunity_id,
        change.at,
        detail,
        change.author,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface NewActivity {
  company_id: Id;
  /** null records a company-wide entry; a value scopes it to that one enquiry. */
  opportunity_id: Id | null;
  type: ActivityType;
  /** An instant. The form supplies Europe/Rome wall-clock time; the action localises it. */
  occurred_at: Date;
  details: string;
  follow_up_on: IsoDate | null;
  /** Tri-state, unchanged from the archive's meaning. null = not applicable. */
  is_completed: boolean | null;
  legacy_author: string;
}

/**
 * Records a conversation or a task. entry_id is generated with a 'UI-' prefix so entries
 * created in the app are always distinguishable from archive rows (AC0000001 style) and can
 * never collide with a future import.
 */
export async function insertActivity(entry: NewActivity): Promise<void> {
  await pool.query(
    `INSERT INTO activity
            (entry_id, company_id, opportunity_id, type, occurred_at,
             details, follow_up_on, is_completed, legacy_author)
     VALUES ($1, $2, $3, $4::activity_type, $5, $6, $7::date, $8, $9)`,
    [
      `UI-${crypto.randomUUID()}`,
      entry.company_id,
      entry.opportunity_id,
      entry.type,
      entry.occurred_at,
      entry.details,
      entry.follow_up_on,
      entry.is_completed,
      entry.legacy_author,
    ],
  );
}

/** Marks a pending task done, or puts it back into the queue. Never touches NULL rows. */
export async function setActivityCompletion(
  entryId: string,
  isCompleted: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE activity
        SET is_completed = $2
      WHERE entry_id = $1
        AND is_completed IS NOT NULL`,
    [entryId, isCompleted],
  );
}
