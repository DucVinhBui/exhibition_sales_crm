-- 001_init.sql — extensions, enums, tables, constraints.
--
-- Applied by src/db/setup.ts, which wraps each file in a single transaction and records it
-- in the schema_migration ledger it creates itself. Do not create schema_migration here and
-- do not use anything that cannot run inside a transaction (no CREATE INDEX CONCURRENTLY).
--
-- Design rules, from CLAUDE.md and data/README.md:
--
--   * An empty CSV field means UNKNOWN. It is stored as NULL — never 0, never '', never a
--     default. Every column that the archive can leave empty is nullable here, and the
--     importer must insert NULL rather than invent a value.
--   * An absent height is not an approval; an absent area is not zero square metres.
--   * requested_height_m is allowed to exceed the edition's max_stand_height_m. There is
--     deliberately NO check constraint tying them together: OP000005 requests 6.00 m at
--     PACK-2026, whose limit is 5.00 m, and that row must import successfully. The breach is
--     computed at read time and surfaced by the handoff assistant.
--   * Identity lives in the legacy codes, not in names. Company names are not unique and are
--     never a join or dedupe key.
--   * Surrogate BIGINT GENERATED ALWAYS AS IDENTITY primary keys; every legacy code is a
--     UNIQUE natural key alongside, which is what makes the import idempotent (ON CONFLICT
--     on the code, never on the surrogate id).
--   * Money is NUMERIC(12,2), area NUMERIC(8,2), height NUMERIC(4,2). Never float: a binary
--     float cannot represent a decimal-comma euro amount exactly.

-- ---------------------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------------------

-- Trigram similarity, for the GIN indexes in 002 that keep company/contact name search off
-- a sequential scan at 100,000 contacts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------

-- The archive spells the commercial status 13 different ways ('Open', ' open ', 'OPEN',
-- ' OPEN ', 'Qualified', ' qualified ', 'QUALIFIED', 'Proposal', ' proposal ', 'Won', 'WON',
-- 'Lost', ' lost '). trim + upper collapses them to these five states. The raw spelling is
-- kept alongside in opportunity.legacy_status_raw so the normalisation stays auditable and
-- reversible.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'opportunity_status') THEN
    CREATE TYPE opportunity_status AS ENUM ('OPEN', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST');
  END IF;
END
$$;

-- activity_log.activity_type, lower-case exactly as exported.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_type') THEN
    CREATE TYPE activity_type AS ENUM ('call', 'email', 'meeting', 'note', 'task');
  END IF;
END
$$;

-- Coordinator verdict of a handoff run. PROVISIONAL is the compromise between the sales
-- director (hand over as soon as a fair and a budget are named) and the technical
-- coordinator (nothing moves until area and height are known and checked).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'handoff_decision') THEN
    CREATE TYPE handoff_decision AS ENUM ('ACCEPTED', 'PROVISIONAL', 'BLOCKED');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------
-- company
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_code    TEXT NOT NULL,
  name            TEXT NOT NULL,
  province_code   TEXT,
  region          TEXT,
  sales_rep_name  TEXT,

  CONSTRAINT company_company_code_key UNIQUE (company_code)
);

COMMENT ON TABLE  company IS
  'Exhibitor. One row per company_code; companies_and_contacts.csv repeats company columns once per contact.';
COMMENT ON COLUMN company.company_code IS
  'Legacy natural key. Identity lives here, not in name — see company.name.';
COMMENT ON COLUMN company.name IS
  'Display/legal name. NOT UNIQUE by design: distinct exhibitors share names. Never join or dedupe on it.';
COMMENT ON COLUMN company.province_code IS
  'Two-letter legacy location code. NULL = unknown (the archive never writes a placeholder).';
COMMENT ON COLUMN company.region IS
  'Region label. NULL = unknown.';
COMMENT ON COLUMN company.sales_rep_name IS
  'Legacy account owner name, kept as text: the archive carries no user table and there is no login. NULL = unknown.';

-- ---------------------------------------------------------------------------------------
-- contact
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contact (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_code   TEXT NOT NULL,
  company_id     BIGINT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  fax            TEXT,
  legacy_row_id  TEXT NOT NULL,

  CONSTRAINT contact_contact_code_key  UNIQUE (contact_code),
  CONSTRAINT contact_legacy_row_id_key UNIQUE (legacy_row_id)
);

COMMENT ON TABLE  contact IS
  'Person at an exhibitor. A contact is entered once and reused across fairs and editions — never re-keyed per enquiry.';
COMMENT ON COLUMN contact.contact_code IS
  'Legacy natural key; the import''s idempotency anchor for this table.';
COMMENT ON COLUMN contact.legacy_row_id IS
  'Source-export row identifier (companies_and_contacts.csv), unique per row. Kept for traceability back to the archive.';
COMMENT ON COLUMN contact.email IS
  'NULL = unknown. Not unique: the archive does not guarantee one address per person, and an empty address must not collide.';
COMMENT ON COLUMN contact.phone IS 'NULL = unknown.';
COMMENT ON COLUMN contact.fax IS
  'NULL = unknown. Empty for the large majority of rows; an empty fax is not "no fax on file", it is simply unrecorded.';

-- ---------------------------------------------------------------------------------------
-- fair / fair_edition
-- ---------------------------------------------------------------------------------------

-- fair is normalised out of fair_edition on purpose. "The same exhibitor at several editions
-- of the same fair" has to be a join on fair_id, not a string comparison on a repeated
-- fair_name. The archive holds 16 editions of 4 fairs.
CREATE TABLE IF NOT EXISTS fair (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  TEXT NOT NULL,

  CONSTRAINT fair_name_key UNIQUE (name)
);

COMMENT ON TABLE fair IS
  'Recurring fair. Normalised out of fair_edition so "same fair, other edition" is a join, not a name comparison.';

CREATE TABLE IF NOT EXISTS fair_edition (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  edition_code        TEXT NOT NULL,
  fair_id             BIGINT NOT NULL REFERENCES fair (id) ON DELETE RESTRICT,
  city                TEXT,
  venue               TEXT,
  starts_on           DATE NOT NULL,
  ends_on             DATE NOT NULL,
  max_stand_height_m  NUMERIC(4, 2),

  CONSTRAINT fair_edition_edition_code_key UNIQUE (edition_code),
  CONSTRAINT fair_edition_dates_ordered    CHECK (ends_on >= starts_on),
  CONSTRAINT fair_edition_height_positive  CHECK (max_stand_height_m IS NULL OR max_stand_height_m > 0)
);

COMMENT ON TABLE  fair_edition IS
  'One dated running of a fair. The unit an opportunity is attached to, so this edition''s conversations never inherit last edition''s agreement.';
COMMENT ON COLUMN fair_edition.max_stand_height_m IS
  'Edition height limit in metres. NULL = no limit recorded, which is NOT an unlimited height and NOT an approval — a breach simply cannot be evaluated. No exceptions are recorded anywhere in the archive.';

-- ---------------------------------------------------------------------------------------
-- opportunity
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunity (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_code          TEXT NOT NULL,
  company_id                BIGINT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  contact_id                BIGINT REFERENCES contact (id) ON DELETE SET NULL,
  fair_edition_id           BIGINT NOT NULL REFERENCES fair_edition (id) ON DELETE RESTRICT,
  description               TEXT NOT NULL,
  amount_eur                NUMERIC(12, 2) NOT NULL,
  status                    opportunity_status NOT NULL,
  legacy_status_raw         TEXT NOT NULL,
  opened_on                 DATE NOT NULL,
  expected_close_on         DATE,
  historical_campaign_code  TEXT,
  stand_area_sqm            NUMERIC(8, 2),
  client_budget_eur         NUMERIC(12, 2),
  requested_height_m        NUMERIC(4, 2),
  brief_notes               TEXT NOT NULL,

  CONSTRAINT opportunity_opportunity_code_key UNIQUE (opportunity_code),

  -- Positive, not non-negative: the archive has no zero placeholders, so a 0 would mean an
  -- empty field was collapsed to a default somewhere in the importer. These checks make that
  -- bug fail loudly instead of silently producing "0 m²" stands.
  CONSTRAINT opportunity_amount_positive  CHECK (amount_eur > 0),
  CONSTRAINT opportunity_area_positive    CHECK (stand_area_sqm    IS NULL OR stand_area_sqm    > 0),
  CONSTRAINT opportunity_budget_positive  CHECK (client_budget_eur IS NULL OR client_budget_eur > 0),
  CONSTRAINT opportunity_height_positive  CHECK (requested_height_m IS NULL OR requested_height_m > 0)

  -- DELIBERATELY ABSENT: any CHECK comparing requested_height_m to the edition's
  -- max_stand_height_m. OP000005 asks for 6.00 m at PACK-2026 (limit 5.00 m) and must import.
  -- Both values are kept; the breach is derived at read time. Never clamp, never normalise away.
);

COMMENT ON TABLE  opportunity IS
  'A stand enquiry for one company at one fair edition. Scoped to the edition so a prior edition''s agreement never carries over implicitly.';
COMMENT ON COLUMN opportunity.contact_id IS
  'Primary contact. NULL = no contact recorded on the enquiry (882 archive rows). NULL is unknown, not "the company itself".';
COMMENT ON COLUMN opportunity.amount_eur IS
  'Sales team''s recorded opportunity value in EUR, excluding VAT. Not a calculated stand price and not the customer''s budget — see client_budget_eur.';
COMMENT ON COLUMN opportunity.status IS
  'Normalised commercial status. Commercial status records no technical approval whatsoever.';
COMMENT ON COLUMN opportunity.legacy_status_raw IS
  'The status exactly as exported, whitespace and casing intact. Kept beside status so the 13-spellings-to-5-states normalisation stays auditable.';
COMMENT ON COLUMN opportunity.expected_close_on IS
  'Expected date of the SALES decision. NULL = no expected close recorded; it does not mean closed, overdue or imminent.';
COMMENT ON COLUMN opportunity.historical_campaign_code IS
  'Historical campaign attribution. NULL = no campaign attributed.';
COMMENT ON COLUMN opportunity.stand_area_sqm IS
  'Allocated plot area in m². NULL = UNKNOWN, never zero square metres. The technical coordinator treats NULL as a blocker, not as a small stand.';
COMMENT ON COLUMN opportunity.client_budget_eur IS
  'Customer''s stated stand budget, excluding VAT. NULL = unknown, never 0. May legitimately differ from amount_eur.';
COMMENT ON COLUMN opportunity.requested_height_m IS
  'Height REQUESTED by the customer, in metres. Not an approved height. May exceed fair_edition.max_stand_height_m — both values are kept and the breach is computed at read time. NULL = unknown, and an absent height is not an approval.';
COMMENT ON COLUMN opportunity.brief_notes IS
  'Sales notes about the requested stand and what is still outstanding. Free text; the handoff assistant reads it but never treats it as a substitute for a missing area or height.';

-- ---------------------------------------------------------------------------------------
-- activity
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activity (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id        TEXT NOT NULL,
  company_id      BIGINT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  opportunity_id  BIGINT REFERENCES opportunity (id) ON DELETE SET NULL,
  type            activity_type NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  details         TEXT NOT NULL,
  follow_up_on    DATE,
  is_completed    BOOLEAN,
  legacy_author   TEXT NOT NULL,

  CONSTRAINT activity_entry_id_key UNIQUE (entry_id)
);

COMMENT ON TABLE  activity IS
  'Log entry, attached either to the company alone or to one opportunity. A completed call/email/meeting records customer contact; a note is internal; a task is work still to do.';
COMMENT ON COLUMN activity.opportunity_id IS
  'NULL = company-level entry not tied to any enquiry (5,001 archive rows). NULL is the point of the column: an opportunity timeline must show only this edition''s conversations, so company-level chatter is not silently attributed to an enquiry.';
COMMENT ON COLUMN activity.occurred_at IS
  'TIMESTAMPTZ. The archive writes DD/MM/YYYY HH:mm in Europe/Rome; the importer localises before storing, so the instant survives DST and any server timezone.';
COMMENT ON COLUMN activity.follow_up_on IS
  'Requested follow-up date. NULL = none requested. Only rows with a date can enter the follow-up queue.';

-- The graded tri-state. Do not add a DEFAULT and do not backfill it.
COMMENT ON COLUMN activity.is_completed IS
  'Tri-state, from completion_marker: TRUE = Y (completed), FALSE = N (pending — a task still to do), NULL = empty in the archive, meaning NOT APPLICABLE (typically a note, which is neither done nor pending). NULL is not FALSE: collapsing empty to false would drop ~7,948 irrelevant rows into the follow-up queue and corrupt it. Never DEFAULT this column.';

-- ---------------------------------------------------------------------------------------
-- handoff_run
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS handoff_run (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id    BIGINT NOT NULL REFERENCES opportunity (id) ON DELETE CASCADE,
  context_snapshot  JSONB NOT NULL,
  brief             JSONB NOT NULL,
  review            JSONB NOT NULL,
  decision          handoff_decision NOT NULL,
  decision_reason   TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  handoff_run IS
  'One run of the handoff assistant, kept forever and append-only: rows are never updated, so an earlier run stays readable after the brief is edited and the assistant re-run.';
COMMENT ON COLUMN handoff_run.context_snapshot IS
  'The CRM and fair facts the run actually read, frozen at run time. Stored rather than re-derived so a revisited run shows what it saw, not what the record says today.';
COMMENT ON COLUMN handoff_run.brief IS  'Output of the preparer role.';
COMMENT ON COLUMN handoff_run.review IS 'Output of the checker role.';
COMMENT ON COLUMN handoff_run.decision_reason IS
  'The coordinator''s stated reason. Missing information and conflicting requests must be visible here.';
COMMENT ON COLUMN handoff_run.policy_version IS
  'Version of the handoff policy in force for this run, so old runs remain interpretable after the policy changes.';

-- ---------------------------------------------------------------------------------------
-- import_state
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_state (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_version TEXT NOT NULL,
  file_checksums  JSONB NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The idempotency ledger: a completed row for this exact (version, checksums) pair means
  -- "this archive is already in", so the second ./dev.sh imports nothing and user edits
  -- survive. ./reset.sh drops the volume, which drops this row, so the next start re-imports.
  CONSTRAINT import_state_dataset_key UNIQUE (dataset_version, file_checksums)
);

COMMENT ON TABLE  import_state IS
  'Ledger of completed archive imports. A row is written only after an import finishes.';
COMMENT ON COLUMN import_state.dataset_version IS 'manifest.json dataset_version.';
COMMENT ON COLUMN import_state.file_checksums IS
  'SHA-256 of each source file, as {filename: sha256}. Checksums, not just the version, decide identity: a re-generated archive keeping version 2.0.0 must still re-import.';
