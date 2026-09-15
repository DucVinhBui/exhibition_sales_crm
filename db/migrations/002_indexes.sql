-- 002_indexes.sql — the index strategy.
--
-- Kept separate from 001 so a bulk load can run before the indexes exist if that proves
-- faster, and so the strategy can be reasoned about on its own.
--
-- Target: 100,000 contacts with proportional companies, opportunities and activities —
-- roughly 5x the supplied archive (10,000 companies / 20,000 contacts / 15,000
-- opportunities / 40,000 activities). A sequential scan on a search or follow-up path is a
-- defect, so every everyday query below has an index that can answer it.
--
-- Each index carries the query it exists for. If a query changes shape, check the index
-- still matches: expression indexes (lower(email), the concatenated full name) and the
-- partial follow-up index are only used when the query repeats the expression / predicate
-- verbatim.
--
-- Note on transactions: src/db/setup.ts runs this file inside one transaction, so
-- CREATE INDEX CONCURRENTLY is not available here and is not needed — the indexes are built
-- on an empty database before the import.

-- ---------------------------------------------------------------------------------------
-- Fuzzy name search (pg_trgm GIN)
-- ---------------------------------------------------------------------------------------

-- "Find an exhibitor" — the account manager types a fragment of a name, possibly misspelled,
-- and company names are neither unique nor normalised.
--
--   SELECT id, name, province_code, region
--     FROM company
--    WHERE name ILIKE '%' || $1 || '%'
--    ORDER BY similarity(name, $1) DESC, name
--    LIMIT 20;
--
-- GIN + gin_trgm_ops is what makes the leading-wildcard ILIKE (and similarity / % ) index-
-- assisted; a btree on name cannot serve a leading wildcard at all. At 100,000 companies the
-- alternative is a full sequential scan on every keystroke.
CREATE INDEX IF NOT EXISTS company_name_trgm_idx
  ON company USING GIN (name gin_trgm_ops);

-- "Find a contact" — same search box, matched against the whole name, because users type
-- "giulia de luca" rather than picking a field. The index is on the concatenated expression
-- so one pass covers first and last name, including matches that straddle the space.
--
--   SELECT c.id, c.first_name, c.last_name, c.email, co.name
--     FROM contact c
--     JOIN company co ON co.id = c.company_id
--    WHERE (c.first_name || ' ' || c.last_name) ILIKE '%' || $1 || '%'
--    ORDER BY similarity(c.first_name || ' ' || c.last_name, $1) DESC
--    LIMIT 20;
--
-- This is the index that carries the 100,000-contact requirement. The query must repeat the
-- expression exactly as written here, or the planner will not match it.
CREATE INDEX IF NOT EXISTS contact_full_name_trgm_idx
  ON contact USING GIN ((first_name || ' ' || last_name) gin_trgm_ops);

-- ---------------------------------------------------------------------------------------
-- Case-insensitive exact contact lookup by email
-- ---------------------------------------------------------------------------------------

-- "An email came in from this address — who is it?" Addresses are case-insensitive in
-- practice and the archive's casing is not normalised, so the lookup is on lower(email).
--
--   SELECT id, first_name, last_name, company_id
--     FROM contact
--    WHERE lower(email) = lower($1);
--
-- A btree on the expression gives an index scan for the exact match. Not UNIQUE: the archive
-- makes no such guarantee and a duplicate address must not break the import. Rows with
-- email IS NULL are stored as NULL entries and are never returned by an equality probe.
CREATE INDEX IF NOT EXISTS contact_email_lower_idx
  ON contact (lower(email));

-- ---------------------------------------------------------------------------------------
-- The follow-up queue (PARTIAL)
-- ---------------------------------------------------------------------------------------

-- "If a customer promises to confirm the floor area on Friday, that needs to turn into
-- something they can find and act on."
--
--   SELECT a.id, a.follow_up_on, a.details, a.company_id, a.opportunity_id
--     FROM activity a
--    WHERE a.is_completed = FALSE
--      AND a.follow_up_on IS NOT NULL
--      AND a.follow_up_on <= $1          -- due / overdue as of today
--    ORDER BY a.follow_up_on
--    LIMIT 50;
--
-- Partial on exactly the queue's predicate. In the supplied archive only 1,192 of 40,000
-- rows qualify — 3% — because 23,973 entries are completed and 7,948 carry is_completed
-- NULL (not applicable) and are correctly excluded rather than counted as pending. The index
-- is therefore ~30x smaller than a full one, stays cached, and gives the ordering for free.
--
-- This is where the tri-state earns its keep: had empty been collapsed to FALSE, the
-- predicate would match ~8x more rows and the queue would fill with notes nobody owes anyone.
--
-- The query must spell the predicate the same way (is_completed = FALSE, not IS NOT TRUE)
-- for the planner to use this index. company_id is the second key so a per-account-manager
-- queue can filter without leaving the index.
CREATE INDEX IF NOT EXISTS activity_follow_up_queue_idx
  ON activity (follow_up_on, company_id)
  WHERE is_completed = FALSE AND follow_up_on IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- Opportunity access paths
-- ---------------------------------------------------------------------------------------

-- "Everything about an exhibitor in one place", and the repeat-exhibitor question: this
-- company's enquiries, grouped or filtered by edition.
--
--   SELECT o.*, fe.edition_code
--     FROM opportunity o
--     JOIN fair_edition fe ON fe.id = o.fair_edition_id
--    WHERE o.company_id = $1
--      AND ($2::bigint IS NULL OR o.fair_edition_id = $2)
--    ORDER BY o.opened_on DESC;
--
-- Composite, company first: it serves both the company-only lookup (leading column) and the
-- company+edition lookup. Because company_id leads, this index also covers the
-- opportunity.company_id foreign key — a separate single-column index on company_id would be
-- redundant and is intentionally not created.
CREATE INDEX IF NOT EXISTS opportunity_company_edition_idx
  ON opportunity (company_id, fair_edition_id);

-- FK index: "who is on this edition, and where does the pipeline stand?" Also the index that
-- keeps a fair_edition update or delete from scanning opportunity.
--
--   SELECT o.id, o.opportunity_code, o.status, o.amount_eur
--     FROM opportunity o
--    WHERE o.fair_edition_id = $1 AND o.status = $2;
--
-- status is the second key because the edition pipeline is nearly always filtered by state.
CREATE INDEX IF NOT EXISTS opportunity_fair_edition_status_idx
  ON opportunity (fair_edition_id, status);

-- FK index: "what is this person on the hook for?", and it stops the ON DELETE SET NULL on
-- contact from degrading into a sequential scan of opportunity.
--
--   SELECT id, opportunity_code, description FROM opportunity WHERE contact_id = $1;
--
-- Partial: 882 archive opportunities have no contact and NULL rows are never probed for.
CREATE INDEX IF NOT EXISTS opportunity_contact_idx
  ON opportunity (contact_id)
  WHERE contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- Activity access paths (also the FK indexes for activity)
-- ---------------------------------------------------------------------------------------

-- "Show only this edition's conversations and follow-ups" — the opportunity timeline, newest
-- first. This is the query that stops last year's agreement being read as if it still applied.
--
--   SELECT id, type, occurred_at, details, is_completed
--     FROM activity
--    WHERE opportunity_id = $1
--    ORDER BY occurred_at DESC
--    LIMIT 50;
--
-- Composite gives both the filter and the ordering, so no sort node. It is also the FK index
-- for activity.opportunity_id (leading column), needed for the ON DELETE SET NULL path.
CREATE INDEX IF NOT EXISTS activity_opportunity_occurred_idx
  ON activity (opportunity_id, occurred_at DESC);

-- The company timeline: every conversation with the exhibitor, including the company-level
-- entries that belong to no enquiry.
--
--   SELECT id, type, occurred_at, details, opportunity_id
--     FROM activity
--    WHERE company_id = $1
--    ORDER BY occurred_at DESC
--    LIMIT 50;
--
-- Also the FK index for activity.company_id (leading column), needed for the ON DELETE
-- CASCADE from company.
CREATE INDEX IF NOT EXISTS activity_company_occurred_idx
  ON activity (company_id, occurred_at DESC);

-- ---------------------------------------------------------------------------------------
-- Remaining foreign keys
-- ---------------------------------------------------------------------------------------

-- FK index for contact.company_id: the contact list on a company page, and the index that
-- makes the ON DELETE CASCADE from company an index scan rather than a scan of 100,000 rows.
--
--   SELECT id, first_name, last_name, email, phone
--     FROM contact WHERE company_id = $1 ORDER BY last_name, first_name;
CREATE INDEX IF NOT EXISTS contact_company_idx
  ON contact (company_id);

-- FK index for fair_edition.fair_id: "the same exhibitor at other editions of this fair" —
-- the join that replaces comparing repeated fair names.
--
--   SELECT fe.id, fe.edition_code, fe.starts_on
--     FROM fair_edition fe WHERE fe.fair_id = $1 ORDER BY fe.starts_on DESC;
--
-- Small table (16 rows here), but the index is what makes the plan stable as editions
-- accumulate and it protects the ON DELETE RESTRICT check.
CREATE INDEX IF NOT EXISTS fair_edition_fair_idx
  ON fair_edition (fair_id);

-- FK index for handoff_run.opportunity_id, ordered so "the latest run for this opportunity"
-- and "the history of runs" are the same index.
--
--   SELECT id, decision, decision_reason, created_at
--     FROM handoff_run WHERE opportunity_id = $1 ORDER BY created_at DESC;
CREATE INDEX IF NOT EXISTS handoff_run_opportunity_created_idx
  ON handoff_run (opportunity_id, created_at DESC);

-- ---------------------------------------------------------------------------------------
-- Listing support
-- ---------------------------------------------------------------------------------------

-- The exhibitor list and its keyset pagination, when no search term is typed. The trigram
-- GIN above cannot order; this btree makes the default alphabetical page an index scan
-- instead of a sort of 100,000 rows. id breaks ties, since names are not unique.
--
--   SELECT id, name, province_code, region, sales_rep_name
--     FROM company
--    WHERE (name, id) > ($1, $2)
--    ORDER BY name, id
--    LIMIT 50;
CREATE INDEX IF NOT EXISTS company_name_id_idx
  ON company (name, id);
