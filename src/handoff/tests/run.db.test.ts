/**
 * Database-backed tests: persistence, append-only re-runs, and the three archive rows the
 * README walks through.
 *
 * Everything runs inside ONE transaction that is rolled back at the end, so the suite leaves
 * the database exactly as it found it and can be run against a live stack. Its own fixtures
 * use codes no archive row uses, so it neither depends on nor collides with the import.
 *
 * Run: docker compose run --rm --no-deps -v "$PWD/src:/app/src" \
 *        --entrypoint npx app tsx --test src/handoff/tests/
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { PoolClient } from "pg";

import { pool } from "../../db/pool";
import { listHandoffRuns, runHandoff, getHandoffRun } from "../run";
import { POLICY_VERSION } from "../policy";

const CO = "ZZTEST-CO-1";
const CT = "ZZTEST-CT-1";
const ED_LIMITED = "ZZTEST-ED-5M";
const ED_NO_LIMIT = "ZZTEST-ED-NOLIMIT";
const OP_COMPLETE = "ZZTEST-OP-COMPLETE";
const OP_INCOMPLETE = "ZZTEST-OP-INCOMPLETE";
const OP_BREACH = "ZZTEST-OP-BREACH";
const OP_NO_LIMIT = "ZZTEST-OP-NOLIMIT";

let db: PoolClient;
let archiveImported = false;

before(async () => {
  db = await pool.connect();
  await db.query("BEGIN");

  await db.query(
    `INSERT INTO company (company_code, name, province_code, region, sales_rep_name)
     VALUES ($1, 'Zeta Test Exhibitor Srl', 'MI', 'Lombardia', 'G. Ferri')`,
    [CO],
  );
  await db.query(
    `INSERT INTO contact (contact_code, company_id, first_name, last_name, email, phone, legacy_row_id)
     VALUES ($1, (SELECT id FROM company WHERE company_code = $2), 'Elena', 'Rossi',
             'elena.rossi@example.test', '+39 02 1234567', 'ZZTEST-ROW-1')`,
    [CT, CO],
  );
  await db.query(`INSERT INTO fair (name) VALUES ('Zeta Test Fair')`);
  await db.query(
    `INSERT INTO fair_edition (edition_code, fair_id, city, venue, starts_on, ends_on, max_stand_height_m)
     VALUES ($1, (SELECT id FROM fair WHERE name = 'Zeta Test Fair'), 'Milan', 'North Hall',
             DATE '2026-10-20', DATE '2026-10-23', 5.00),
            ($2, (SELECT id FROM fair WHERE name = 'Zeta Test Fair'), 'Milan', 'North Hall',
             DATE '2027-10-20', DATE '2027-10-23', NULL)`,
    [ED_LIMITED, ED_NO_LIMIT],
  );

  const insertOpportunity = `
    INSERT INTO opportunity (opportunity_code, company_id, contact_id, fair_edition_id, description,
                             amount_eur, status, legacy_status_raw, opened_on, stand_area_sqm,
                             client_budget_eur, requested_height_m, brief_notes)
    VALUES ($1,
            (SELECT id FROM company WHERE company_code = $2),
            (SELECT id FROM contact WHERE contact_code = $3),
            (SELECT id FROM fair_edition WHERE edition_code = $4),
            $5, $6, $7, $8, DATE '2026-01-15', $9, $10, $11, $12)`;

  await db.query(insertOpportunity, [OP_COMPLETE, CO, CT, ED_LIMITED, "Complete enquiry", "48000.00", "OPEN", "Open", "80.00", "50000.00", "4.00", "Plot confirmed."]);
  await db.query(insertOpportunity, [OP_INCOMPLETE, CO, CT, ED_LIMITED, "Incomplete enquiry", "31500.00", "OPEN", " open ", null, "30000.00", null, "Plot size still with the organiser; height undecided."]);
  await db.query(insertOpportunity, [OP_BREACH, CO, CT, ED_LIMITED, "High fascia enquiry", "76000.00", "OPEN", " OPEN ", "120.00", "80000.00", "6.00", "Client asks for a 6 m fascia."]);
  await db.query(insertOpportunity, [OP_NO_LIMIT, CO, CT, ED_NO_LIMIT, "Enquiry at an edition with no recorded limit", "40000.00", "OPEN", "Open", "60.00", "42000.00", "6.00", "No limit published yet."]);

  await db.query(
    `INSERT INTO activity (entry_id, company_id, opportunity_id, type, occurred_at, details, follow_up_on, is_completed, legacy_author)
     VALUES ('ZZTEST-AC-1',
             (SELECT id FROM company WHERE company_code = $1),
             (SELECT id FROM opportunity WHERE opportunity_code = $2),
             'task', TIMESTAMPTZ '2026-08-28 09:00+02', 'Customer to confirm floor area on Friday.',
             DATE '2026-09-04', FALSE, 'mconti'),
            ('ZZTEST-AC-2',
             (SELECT id FROM company WHERE company_code = $1),
             NULL,
             'note', TIMESTAMPTZ '2026-08-29 09:00+02', 'Company-level chatter that belongs to no enquiry.',
             NULL, NULL, 'mconti')`,
    [CO, OP_INCOMPLETE],
  );

  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM opportunity WHERE opportunity_code = 'OP000005') AS present`,
  );
  archiveImported = rows[0]?.present ?? false;
});

after(async () => {
  // Append-only in production; rolled back here. Nothing this suite wrote survives.
  await db.query("ROLLBACK");
  db.release();
  await pool.end();
});

describe("persistence", () => {
  test("a run appends exactly one row, with the snapshot, both role outputs and the policy version", async () => {
    const record = await runHandoff({ opportunityCode: OP_COMPLETE }, { db });

    assert.equal(record.decision, "ACCEPTED");
    assert.equal(record.policy_version, POLICY_VERSION);
    assert.equal(record.opportunity_code, OP_COMPLETE);
    assert.ok(record.decision_reason.length > 0);

    const stored = await getHandoffRun(record.id, { db });
    assert.ok(stored !== null);
    assert.equal(stored.decision, "ACCEPTED");
    assert.equal(stored.decision_reason, record.decision_reason);
    assert.equal(stored.context_snapshot.opportunity.opportunity_code, OP_COMPLETE);
    assert.equal(stored.brief.prepared_by, "preparer");
    assert.equal(stored.review.reviewed_by, "checker");
    assert.equal(stored.review.height_check.status, "WITHIN_LIMIT");
  });

  test("the context snapshot holds only this enquiry's activity", async () => {
    const record = await runHandoff({ opportunityCode: OP_INCOMPLETE }, { db });
    const entryIds = record.context_snapshot.recent_activity.map((entry) => entry.entry_id);
    assert.deepEqual(entryIds, ["ZZTEST-AC-1"]);
    assert.deepEqual(
      record.context_snapshot.open_follow_ups.map((entry) => entry.entry_id),
      ["ZZTEST-AC-1"],
    );
  });

  test("editing the brief and re-running appends; the earlier run stays readable", async () => {
    const before = await runHandoff({ opportunityCode: OP_INCOMPLETE }, { db });
    assert.equal(before.decision, "PROVISIONAL");
    assert.equal(before.context_snapshot.opportunity.stand_area_sqm, null);

    // The edit the salesperson makes on the enquiry, exactly as the UI would write it.
    await db.query(
      `UPDATE opportunity SET stand_area_sqm = 60.00, requested_height_m = 4.00
        WHERE opportunity_code = $1`,
      [OP_INCOMPLETE],
    );

    const after_ = await runHandoff({ opportunityCode: OP_INCOMPLETE }, { db });
    assert.equal(after_.decision, "ACCEPTED");

    const reread = await getHandoffRun(before.id, { db });
    assert.ok(reread !== null);
    assert.equal(reread.decision, "PROVISIONAL", "the earlier run was overwritten");
    assert.equal(reread.context_snapshot.opportunity.stand_area_sqm, null, "the earlier snapshot was mutated");
    assert.equal(reread.decision_reason, before.decision_reason);

    const runs = await listHandoffRuns(after_.opportunity_id, { db });
    assert.ok(runs.length >= 3, `expected at least three runs, got ${runs.length}`);
    assert.equal(runs[0]?.id, after_.id, "runs are not listed newest first");
    assert.ok(runs.some((run) => run.id === before.id));
  });

  test("two runs over an unchanged enquiry store byte-identical role outputs", async () => {
    const first = await runHandoff({ opportunityCode: OP_BREACH }, { db });
    const second = await runHandoff({ opportunityCode: OP_BREACH }, { db });

    const { rows } = await db.query<{ same_brief: boolean; same_review: boolean; same_snapshot: boolean }>(
      `SELECT a.brief::text = b.brief::text                       AS same_brief,
              a.review::text = b.review::text                     AS same_review,
              a.context_snapshot::text = b.context_snapshot::text AS same_snapshot
         FROM handoff_run a, handoff_run b
        WHERE a.id = $1 AND b.id = $2`,
      [first.id, second.id],
    );

    assert.equal(rows[0]?.same_brief, true, "stored briefs differ between identical runs");
    assert.equal(rows[0]?.same_review, true, "stored reviews differ between identical runs");
    assert.equal(rows[0]?.same_snapshot, true, "stored snapshots differ between identical runs");
    assert.equal(first.decision_reason, second.decision_reason);
    assert.notEqual(first.id, second.id, "the second run overwrote the first instead of appending");
  });

  test("a missing edition limit is persisted as a non-acceptance, not an approval", async () => {
    const record = await runHandoff({ opportunityCode: OP_NO_LIMIT }, { db });
    assert.notEqual(record.decision, "ACCEPTED");
    assert.equal(record.decision, "PROVISIONAL");
    assert.equal(record.review.height_check.status, "LIMIT_UNKNOWN");
    assert.equal(record.context_snapshot.fair_edition?.max_stand_height_m, null);
  });

  test("a height breach is persisted as BLOCKED with both numbers in the stored reason", async () => {
    const record = await runHandoff({ opportunityCode: OP_BREACH }, { db });
    assert.equal(record.decision, "BLOCKED");
    assert.match(record.decision_reason, /6\.0 m/);
    assert.match(record.decision_reason, /5\.0 m/);
  });
});

describe("the archive walkthrough (skipped until the import has run)", () => {
  test("OP000001 -> ACCEPTED, 80 m² at 4.0 m against a 4.5 m limit", async (t) => {
    if (!archiveImported) return t.skip("archive not imported yet");
    const record = await runHandoff({ opportunityCode: "OP000001" }, { db });
    assert.equal(record.decision, "ACCEPTED");
    assert.equal(record.context_snapshot.opportunity.stand_area_sqm, "80.00");
    assert.equal(record.context_snapshot.opportunity.requested_height_m, "4.00");
    assert.equal(record.context_snapshot.fair_edition?.max_stand_height_m, "4.50");
  });

  test("OP000003 -> PROVISIONAL, with area and height both named as outstanding", async (t) => {
    if (!archiveImported) return t.skip("archive not imported yet");
    const record = await runHandoff({ opportunityCode: "OP000003" }, { db });
    assert.equal(record.decision, "PROVISIONAL");
    const fields = record.review.outstanding.map((item) => item.field);
    assert.ok(fields.includes("opportunity.stand_area_sqm"));
    assert.ok(fields.includes("opportunity.requested_height_m"));
  });

  test("OP000005 -> BLOCKED, citing 6.0 m against the 5.0 m limit for PACK-2026", async (t) => {
    if (!archiveImported) return t.skip("archive not imported yet");
    const record = await runHandoff({ opportunityCode: "OP000005" }, { db });
    assert.equal(record.decision, "BLOCKED");
    assert.match(record.decision_reason, /6\.0 m/);
    assert.match(record.decision_reason, /5\.0 m/);
    assert.match(record.decision_reason, /PACK-2026/);
  });

  test("OP000003 with area and height supplied -> ACCEPTED, earlier run still readable", async (t) => {
    if (!archiveImported) return t.skip("archive not imported yet");
    const before = await runHandoff({ opportunityCode: "OP000003" }, { db });
    await db.query(
      `UPDATE opportunity SET stand_area_sqm = 64.00, requested_height_m = 4.00
        WHERE opportunity_code = 'OP000003'`,
    );
    const after_ = await runHandoff({ opportunityCode: "OP000003" }, { db });

    assert.equal(after_.decision, "ACCEPTED");
    const reread = await getHandoffRun(before.id, { db });
    assert.equal(reread?.decision, "PROVISIONAL");
    assert.equal(reread?.context_snapshot.opportunity.stand_area_sqm, null);
  });
});
