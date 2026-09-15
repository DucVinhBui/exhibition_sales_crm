-- ---------------------------------------------------------------------------------------
-- 004 — let an enquiry be opened inside the CRM, not only imported from the archive.
--
-- Two columns were NOT NULL because every row in the legacy export carries them. That is a
-- true statement about the ARCHIVE, and it was the right constraint while the archive was
-- the only source of rows. It stops being right the moment a salesperson opens next year's
-- enquiry from the company screen, because at that moment neither value exists:
--
--   amount_eur         is what sales expects to invoice. On a brand-new enquiry that is
--                      genuinely not known yet. Requiring it would force a made-up figure,
--                      which is the same defect the importer refuses to commit when it
--                      stores an empty CSV field as NULL rather than 0.
--
--   legacy_status_raw  is the spelling the OLD SYSTEM used. A row created here was never in
--                      the old system, so there is no such spelling. Writing "OPEN" into it
--                      would claim a provenance the row does not have.
--
-- The positive-value CHECK on amount_eur needs no change: `NULL > 0` evaluates to NULL and a
-- CHECK only rejects FALSE, so a missing amount passes and a zero still fails loudly.
--
-- This also makes a branch of the handoff policy reachable for the first time. Gate A asks
-- for "a budget or an opportunity value"; with amount_eur NOT NULL that test could never
-- fail, so every enquiry in the archive cleared Gate A by construction. An enquiry opened
-- here with neither figure is now genuinely below Gate A, which is what the policy always
-- described.
-- ---------------------------------------------------------------------------------------

ALTER TABLE opportunity ALTER COLUMN amount_eur        DROP NOT NULL;
ALTER TABLE opportunity ALTER COLUMN legacy_status_raw DROP NOT NULL;
