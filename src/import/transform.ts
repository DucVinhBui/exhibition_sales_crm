/**
 * Staging -> model. One set-based `INSERT ... SELECT` per table, in dependency order.
 *
 * Every transformation the archive needs lives in this file, as SQL, applied to all rows at
 * once. The rules, from data/README.md and CLAUDE.md:
 *
 *   empty field        -> NULL. Never 0, never '', never a default. An absent height is not
 *                         an approval; an absent area is not zero square metres.
 *   '12500,00'         -> NUMERIC 12500.00. Decimal comma, optional '.' thousands separator.
 *                         The value never becomes a JS number: the text goes to PostgreSQL
 *                         and PostgreSQL does the decimal parse.
 *   'DD/MM/YYYY'       -> DATE.
 *   'DD/MM/YYYY HH:mm' -> TIMESTAMPTZ, localised from Europe/Rome by PostgreSQL's own tz
 *                         database, so the stored instant is right across DST and does not
 *                         depend on the container's TZ.
 *   13 status spellings-> trim + upper -> the 5-value enum, with the untouched original kept
 *                         in opportunity.legacy_status_raw.
 *   'Y'/'N'/''         -> TRUE / FALSE / NULL. NULL is not FALSE.
 *   repeated company   -> one company per company_code; names are never a key.
 *   repeated fair_name -> one fair row, editions reference it.
 *   legacy_print_layout-> dropped (obsolete presentation metadata).
 *
 * Conflict handling is `ON CONFLICT (<legacy code>) DO UPDATE`, never on a surrogate id: the
 * legacy code is the identity the archive guarantees. In the normal lifecycle no conflict
 * ever fires, because an already-imported archive is skipped before this file runs; the
 * clause exists so that re-importing a *changed* archive over an existing database updates
 * the archive-sourced row instead of failing or duplicating it.
 */
import type { PoolClient } from "pg";

/* ---------------------------------------------------------------------------------------
 * Field-level transforms, as SQL expressions
 * ------------------------------------------------------------------------------------ */

/** Optional text: empty (or whitespace-only) means UNKNOWN, which is NULL. */
const text = (column: string): string => `nullif(btrim(${column}), '')`;

/**
 * Decimal comma -> NUMERIC. '12500,00' -> 12500.00, '12.500,00' -> 12500.00.
 * Empty -> NULL, so an unknown budget can never arrive as 0.
 */
const decimal = (column: string): string =>
  `replace(replace(${text(column)}, '.', ''), ',', '.')::numeric`;

/** 'DD/MM/YYYY' -> DATE. Empty -> NULL. */
const date = (column: string): string => `to_date(${text(column)}, 'DD/MM/YYYY')`;

/**
 * 'DD/MM/YYYY HH:mm' read as a wall-clock reading in Europe/Rome -> TIMESTAMPTZ.
 *
 * Built as `date + time` (a plain `timestamp`, no zone) and then localised with
 * `AT TIME ZONE 'Europe/Rome'`. Deliberately not `to_timestamp()`, which would interpret the
 * text in the session's TimeZone and make the stored instant depend on the container.
 */
const romeTimestamp = (column: string): string =>
  `((to_date(substr(btrim(${column}), 1, 10), 'DD/MM/YYYY') + substr(btrim(${column}), 12, 5)::time)` +
  ` AT TIME ZONE 'Europe/Rome')`;

/** Accepts '12500,00' and '12.500,00'; rejects '12500.00', which would silently become 1250000. */
const DECIMAL_COMMA_RE = "^[0-9]+([.][0-9]{3})*([,][0-9]{1,2})?$";
const DATE_RE = "^[0-9]{2}/[0-9]{2}/[0-9]{4}$";
const TIMESTAMP_RE = "^[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2}$";

/* ---------------------------------------------------------------------------------------
 * Pre-flight validation
 * ------------------------------------------------------------------------------------ */

/**
 * Runs a query that must return no rows and throws with samples if it does.
 *
 * These checks exist so that a surprising archive fails with a sentence a human can act on,
 * before anything is written, rather than as `invalid input syntax for type numeric` from
 * somewhere inside a 40,000-row insert. They do not repair anything: the importer never
 * invents a value to get a row in.
 */
async function assertEmpty(
  client: PoolClient,
  what: string,
  sql: string,
): Promise<void> {
  const rows = await sample(client, sql);
  if (rows.length > 0) {
    throw new Error(`[import] ${what}\n    ${rows.join("\n    ")}`);
  }
}

/**
 * The softer sibling: reports a data-quality problem the import can survive, and carries on.
 *
 * Used only where the model can represent the awkward row honestly — a nullable foreign key
 * that ends up NULL, or a repeated company block whose first row is taken deterministically.
 * Aborting a 75,020-row import over rows the schema *can* hold would trade a working CRM for
 * nothing. Anything the schema genuinely cannot express still uses assertEmpty().
 */
async function warnIfAny(
  client: PoolClient,
  what: string,
  countSql: string,
  sampleSql: string,
): Promise<void> {
  const { rows } = await client.query<{ n: string }>(countSql);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return;
  const samples = await sample(client, sampleSql);
  console.warn(`[import] WARNING: ${what} (${n} affected)\n    ${samples.join("\n    ")}`);
}

async function sample(client: PoolClient, sql: string): Promise<string[]> {
  const { rows } = await client.query<Record<string, unknown>>(`${sql} LIMIT 5`);
  return rows.map((r) => JSON.stringify(r));
}

export async function validateStaging(client: PoolClient): Promise<void> {
  // --- identity: legacy codes must be present and unique within their file -------------
  await assertEmpty(
    client,
    "companies_and_contacts.csv: rows with an empty company_code, contact_code or legacy_row_id",
    `SELECT legacy_row_id, company_code, contact_code FROM stg_companies_and_contacts
      WHERE ${text("company_code")} IS NULL OR ${text("contact_code")} IS NULL OR ${text("legacy_row_id")} IS NULL`,
  );
  await assertEmpty(
    client,
    "companies_and_contacts.csv: contact_code appears more than once",
    `SELECT btrim(contact_code) AS contact_code, count(*) AS rows FROM stg_companies_and_contacts
      GROUP BY 1 HAVING count(*) > 1`,
  );
  // Survivable: the company insert takes the first row by legacy_row_id, deterministically.
  await warnIfAny(
    client,
    "companies_and_contacts.csv: a company_code repeats with conflicting company details; " +
      "keeping the first row by legacy_row_id",
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM stg_companies_and_contacts GROUP BY btrim(company_code)
        HAVING count(DISTINCT (company_name, province_code, region, sales_rep)) > 1) x`,
    `SELECT btrim(company_code) AS company_code,
            count(DISTINCT (company_name, province_code, region, sales_rep)) AS variants
       FROM stg_companies_and_contacts GROUP BY 1
      HAVING count(DISTINCT (company_name, province_code, region, sales_rep)) > 1`,
  );
  await assertEmpty(
    client,
    "opportunities.csv: opportunity_code appears more than once",
    `SELECT btrim(opportunity_code) AS opportunity_code, count(*) AS rows FROM stg_opportunities
      GROUP BY 1 HAVING count(*) > 1`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: entry_id appears more than once",
    `SELECT btrim(entry_id) AS entry_id, count(*) AS rows FROM stg_activity_log
      GROUP BY 1 HAVING count(*) > 1`,
  );
  await assertEmpty(
    client,
    "fair_editions.csv: fair_edition_code appears more than once",
    `SELECT btrim(fair_edition_code) AS fair_edition_code, count(*) AS rows FROM stg_fair_editions
      GROUP BY 1 HAVING count(*) > 1`,
  );

  // --- columns the model requires: the archive must actually supply them ---------------
  await assertEmpty(
    client,
    "opportunities.csv: required column empty (description, amount_eur, legacy_status, opened_on, fair_edition_code or brief_notes)",
    `SELECT opportunity_code FROM stg_opportunities
      WHERE ${text("description")} IS NULL OR ${text("amount_eur")} IS NULL
         OR ${text("legacy_status")} IS NULL OR ${text("opened_on")} IS NULL
         OR ${text("fair_edition_code")} IS NULL OR ${text("brief_notes")} IS NULL`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: required column empty (company_code, activity_type, occurred_at, details or legacy_author)",
    `SELECT entry_id FROM stg_activity_log
      WHERE ${text("company_code")} IS NULL OR ${text("activity_type")} IS NULL
         OR ${text("occurred_at")} IS NULL OR ${text("details")} IS NULL
         OR ${text("legacy_author")} IS NULL`,
  );

  // --- value shapes --------------------------------------------------------------------
  await assertEmpty(
    client,
    "opportunities.csv: a money/measurement value is not in decimal-comma form",
    `SELECT opportunity_code, amount_eur, stand_area_sqm, client_budget_eur, requested_height_m
       FROM stg_opportunities
      WHERE (${text("amount_eur")}        IS NOT NULL AND btrim(amount_eur)         !~ '${DECIMAL_COMMA_RE}')
         OR (${text("stand_area_sqm")}    IS NOT NULL AND btrim(stand_area_sqm)     !~ '${DECIMAL_COMMA_RE}')
         OR (${text("client_budget_eur")} IS NOT NULL AND btrim(client_budget_eur)  !~ '${DECIMAL_COMMA_RE}')
         OR (${text("requested_height_m")} IS NOT NULL AND btrim(requested_height_m) !~ '${DECIMAL_COMMA_RE}')`,
  );
  await assertEmpty(
    client,
    "fair_editions.csv: max_stand_height_m is not in decimal-comma form",
    `SELECT fair_edition_code, max_stand_height_m FROM stg_fair_editions
      WHERE ${text("max_stand_height_m")} IS NOT NULL AND btrim(max_stand_height_m) !~ '${DECIMAL_COMMA_RE}'`,
  );
  await assertEmpty(
    client,
    "a date is not DD/MM/YYYY",
    `SELECT 'opportunities.csv' AS file, opportunity_code AS code, opened_on AS value FROM stg_opportunities
      WHERE ${text("opened_on")} IS NOT NULL AND btrim(opened_on) !~ '${DATE_RE}'
      UNION ALL
     SELECT 'opportunities.csv', opportunity_code, expected_close_on FROM stg_opportunities
      WHERE ${text("expected_close_on")} IS NOT NULL AND btrim(expected_close_on) !~ '${DATE_RE}'
      UNION ALL
     SELECT 'activity_log.csv', entry_id, follow_up_on FROM stg_activity_log
      WHERE ${text("follow_up_on")} IS NOT NULL AND btrim(follow_up_on) !~ '${DATE_RE}'
      UNION ALL
     SELECT 'fair_editions.csv', fair_edition_code, starts_on FROM stg_fair_editions
      WHERE btrim(starts_on) !~ '${DATE_RE}'
      UNION ALL
     SELECT 'fair_editions.csv', fair_edition_code, ends_on FROM stg_fair_editions
      WHERE btrim(ends_on) !~ '${DATE_RE}'`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: occurred_at is not 'DD/MM/YYYY HH:mm'",
    `SELECT entry_id, occurred_at FROM stg_activity_log WHERE btrim(occurred_at) !~ '${TIMESTAMP_RE}'`,
  );

  // --- enumerations --------------------------------------------------------------------
  await assertEmpty(
    client,
    "opportunities.csv: legacy_status spelling does not collapse to a known state (trim + upper)",
    `SELECT DISTINCT legacy_status FROM stg_opportunities
      WHERE upper(btrim(legacy_status)) NOT IN ('OPEN', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST')`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: unknown activity_type",
    `SELECT DISTINCT activity_type FROM stg_activity_log
      WHERE btrim(activity_type) NOT IN ('call', 'email', 'meeting', 'note', 'task')`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: completion_marker is neither 'Y', 'N' nor empty",
    `SELECT DISTINCT completion_marker FROM stg_activity_log
      WHERE ${text("completion_marker")} IS NOT NULL AND upper(btrim(completion_marker)) NOT IN ('Y', 'N')`,
  );

  // --- referential integrity, reported by legacy code rather than as an FK violation ----
  await assertEmpty(
    client,
    "opportunities.csv: company_code not present in companies_and_contacts.csv",
    `SELECT DISTINCT o.opportunity_code, o.company_code FROM stg_opportunities o
      WHERE NOT EXISTS (SELECT 1 FROM stg_companies_and_contacts c
                         WHERE btrim(c.company_code) = btrim(o.company_code))`,
  );
  // Survivable: contact_id is nullable, so a dangling contact_code imports as "no contact
  // recorded". Reported loudly because that is indistinguishable, afterwards, from the 882
  // opportunities the archive genuinely leaves without a contact.
  await warnIfAny(
    client,
    "opportunities.csv: contact_code not present in companies_and_contacts.csv; importing the opportunity with no contact",
    `SELECT count(*) AS n FROM stg_opportunities o
      WHERE ${text("o.contact_code")} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stg_companies_and_contacts c
                         WHERE btrim(c.contact_code) = btrim(o.contact_code))`,
    `SELECT o.opportunity_code, o.contact_code FROM stg_opportunities o
      WHERE ${text("o.contact_code")} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stg_companies_and_contacts c
                         WHERE btrim(c.contact_code) = btrim(o.contact_code))`,
  );
  await assertEmpty(
    client,
    "opportunities.csv: fair_edition_code not present in fair_editions.csv",
    `SELECT DISTINCT o.opportunity_code, o.fair_edition_code FROM stg_opportunities o
      WHERE NOT EXISTS (SELECT 1 FROM stg_fair_editions f
                         WHERE btrim(f.fair_edition_code) = btrim(o.fair_edition_code))`,
  );
  await assertEmpty(
    client,
    "activity_log.csv: company_code not present in companies_and_contacts.csv",
    `SELECT a.entry_id, a.company_code FROM stg_activity_log a
      WHERE NOT EXISTS (SELECT 1 FROM stg_companies_and_contacts c
                         WHERE btrim(c.company_code) = btrim(a.company_code))`,
  );
  // Survivable: opportunity_id is nullable. Reported loudly for the same reason — such a row
  // would otherwise be silently filed as company-level chatter alongside the archive's 5,001
  // genuinely company-level entries.
  await warnIfAny(
    client,
    "activity_log.csv: opportunity_code not present in opportunities.csv; importing the entry as company-level",
    `SELECT count(*) AS n FROM stg_activity_log a
      WHERE ${text("a.opportunity_code")} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stg_opportunities o
                         WHERE btrim(o.opportunity_code) = btrim(a.opportunity_code))`,
    `SELECT a.entry_id, a.opportunity_code FROM stg_activity_log a
      WHERE ${text("a.opportunity_code")} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stg_opportunities o
                         WHERE btrim(o.opportunity_code) = btrim(a.opportunity_code))`,
  );
}

/* ---------------------------------------------------------------------------------------
 * The transforms
 * ------------------------------------------------------------------------------------ */

export interface TransformCounts {
  company: number;
  contact: number;
  fair: number;
  fair_edition: number;
  opportunity: number;
  activity: number;
}

/**
 * `companies_and_contacts.csv` holds one row per contact and repeats the company columns.
 * `DISTINCT ON (company_code)` collapses them to one company per code — by code, never by
 * name: 10,000 codes share 9,999 distinct names in this archive, so deduping on the name
 * would silently merge two unrelated exhibitors.
 */
const INSERT_COMPANY = `
  INSERT INTO company (company_code, name, province_code, region, sales_rep_name)
  SELECT DISTINCT ON (btrim(s.company_code))
         btrim(s.company_code),
         btrim(s.company_name),
         ${text("s.province_code")},
         ${text("s.region")},
         ${text("s.sales_rep")}
    FROM stg_companies_and_contacts s
   ORDER BY btrim(s.company_code), s.legacy_row_id
  ON CONFLICT (company_code) DO UPDATE
     SET name           = EXCLUDED.name,
         province_code  = EXCLUDED.province_code,
         region         = EXCLUDED.region,
         sales_rep_name = EXCLUDED.sales_rep_name
`;

/** One contact per source row. Attached to its company by code. */
const INSERT_CONTACT = `
  INSERT INTO contact (contact_code, company_id, first_name, last_name, email, phone, fax, legacy_row_id)
  SELECT btrim(s.contact_code),
         c.id,
         btrim(s.contact_first_name),
         btrim(s.contact_last_name),
         ${text("s.email")},
         ${text("s.phone")},
         ${text("s.fax")},
         btrim(s.legacy_row_id)
    FROM stg_companies_and_contacts s
    JOIN company c ON c.company_code = btrim(s.company_code)
  ON CONFLICT (contact_code) DO UPDATE
     SET company_id    = EXCLUDED.company_id,
         first_name    = EXCLUDED.first_name,
         last_name     = EXCLUDED.last_name,
         email         = EXCLUDED.email,
         phone         = EXCLUDED.phone,
         fax           = EXCLUDED.fax,
         legacy_row_id = EXCLUDED.legacy_row_id
`;

/**
 * `fair_name` repeats across editions; one row per distinct name, editions reference it.
 * This is the one place a name is a key, and it is the fair's own name, not an exhibitor's.
 */
const INSERT_FAIR = `
  INSERT INTO fair (name)
  SELECT DISTINCT btrim(s.fair_name) FROM stg_fair_editions s
  ON CONFLICT (name) DO NOTHING
`;

const INSERT_FAIR_EDITION = `
  INSERT INTO fair_edition (edition_code, fair_id, city, venue, starts_on, ends_on, max_stand_height_m)
  SELECT btrim(s.fair_edition_code),
         f.id,
         ${text("s.city")},
         ${text("s.venue")},
         ${date("s.starts_on")},
         ${date("s.ends_on")},
         ${decimal("s.max_stand_height_m")}
    FROM stg_fair_editions s
    JOIN fair f ON f.name = btrim(s.fair_name)
  ON CONFLICT (edition_code) DO UPDATE
     SET fair_id            = EXCLUDED.fair_id,
         city               = EXCLUDED.city,
         venue              = EXCLUDED.venue,
         starts_on          = EXCLUDED.starts_on,
         ends_on            = EXCLUDED.ends_on,
         max_stand_height_m = EXCLUDED.max_stand_height_m
`;

/**
 * Note what is NOT here: no comparison of requested_height_m against the edition's
 * max_stand_height_m, no LEAST(), no clamp. OP000005 asks 6.00 m at PACK-2026's 5.00 m and
 * both numbers land in the database untouched; the breach is derived at read time.
 *
 * `status` is the normalised enum and `legacy_status_raw` is the source text with its
 * casing and surrounding whitespace intact, so the 13-to-5 collapse stays auditable.
 */
const INSERT_OPPORTUNITY = `
  INSERT INTO opportunity (
    opportunity_code, company_id, contact_id, fair_edition_id, description, amount_eur,
    status, legacy_status_raw, opened_on, expected_close_on, historical_campaign_code,
    stand_area_sqm, client_budget_eur, requested_height_m, brief_notes
  )
  SELECT btrim(s.opportunity_code),
         c.id,
         ct.id,
         fe.id,
         s.description,
         ${decimal("s.amount_eur")},
         upper(btrim(s.legacy_status))::opportunity_status,
         s.legacy_status,
         ${date("s.opened_on")},
         ${date("s.expected_close_on")},
         ${text("s.historical_campaign_code")},
         ${decimal("s.stand_area_sqm")},
         ${decimal("s.client_budget_eur")},
         ${decimal("s.requested_height_m")},
         s.brief_notes
    FROM stg_opportunities s
    JOIN company      c  ON c.company_code   = btrim(s.company_code)
    JOIN fair_edition fe ON fe.edition_code  = btrim(s.fair_edition_code)
    LEFT JOIN contact ct ON ct.contact_code  = ${text("s.contact_code")}
  ON CONFLICT (opportunity_code) DO UPDATE
     SET company_id               = EXCLUDED.company_id,
         contact_id               = EXCLUDED.contact_id,
         fair_edition_id          = EXCLUDED.fair_edition_id,
         description              = EXCLUDED.description,
         amount_eur               = EXCLUDED.amount_eur,
         status                   = EXCLUDED.status,
         legacy_status_raw        = EXCLUDED.legacy_status_raw,
         opened_on                = EXCLUDED.opened_on,
         expected_close_on        = EXCLUDED.expected_close_on,
         historical_campaign_code = EXCLUDED.historical_campaign_code,
         stand_area_sqm           = EXCLUDED.stand_area_sqm,
         client_budget_eur        = EXCLUDED.client_budget_eur,
         requested_height_m       = EXCLUDED.requested_height_m,
         brief_notes              = EXCLUDED.brief_notes
`;

/**
 * `is_completed` is the tri-state. 'Y' -> TRUE, 'N' -> FALSE, empty -> NULL, and the ELSE
 * branch is unreachable because validateStaging() has already rejected any other marker.
 * There is no `coalesce(..., false)` anywhere near this column by design: NULL means "not
 * applicable" (a note is neither done nor pending), and collapsing it to FALSE would drop
 * every note into the follow-up queue.
 */
const INSERT_ACTIVITY = `
  INSERT INTO activity (
    entry_id, company_id, opportunity_id, type, occurred_at, details, follow_up_on,
    is_completed, legacy_author
  )
  SELECT btrim(s.entry_id),
         c.id,
         o.id,
         btrim(s.activity_type)::activity_type,
         ${romeTimestamp("s.occurred_at")},
         s.details,
         ${date("s.follow_up_on")},
         CASE upper(${text("s.completion_marker")})
           WHEN 'Y' THEN TRUE
           WHEN 'N' THEN FALSE
           ELSE NULL
         END,
         btrim(s.legacy_author)
    FROM stg_activity_log s
    JOIN company c ON c.company_code = btrim(s.company_code)
    LEFT JOIN opportunity o ON o.opportunity_code = ${text("s.opportunity_code")}
  ON CONFLICT (entry_id) DO UPDATE
     SET company_id     = EXCLUDED.company_id,
         opportunity_id = EXCLUDED.opportunity_id,
         type           = EXCLUDED.type,
         occurred_at    = EXCLUDED.occurred_at,
         details        = EXCLUDED.details,
         follow_up_on   = EXCLUDED.follow_up_on,
         is_completed   = EXCLUDED.is_completed,
         legacy_author  = EXCLUDED.legacy_author
`;

/** Runs every transform, in dependency order, on the caller's open transaction. */
export async function transformAll(client: PoolClient): Promise<TransformCounts> {
  const counts: TransformCounts = {
    company: 0,
    contact: 0,
    fair: 0,
    fair_edition: 0,
    opportunity: 0,
    activity: 0,
  };

  const steps: ReadonlyArray<[keyof TransformCounts, string]> = [
    ["company", INSERT_COMPANY],
    ["contact", INSERT_CONTACT],
    ["fair", INSERT_FAIR],
    ["fair_edition", INSERT_FAIR_EDITION],
    ["opportunity", INSERT_OPPORTUNITY],
    ["activity", INSERT_ACTIVITY],
  ];

  for (const [name, sql] of steps) {
    const started = Date.now();
    const result = await client.query(sql);
    counts[name] = result.rowCount ?? 0;
    console.log(`[import] ${name}: ${counts[name]} rows in ${Date.now() - started} ms`);
  }

  return counts;
}
