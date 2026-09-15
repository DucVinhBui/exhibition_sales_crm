/**
 * The policy tiers, and the null semantics the assignment grades.
 *
 * Run: docker compose run --rm --no-deps -v "$PWD/src:/app/src" \
 *        --entrypoint npx app tsx --test src/handoff/tests/
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { checkHeight, evaluatePolicy } from "../policy";
import { prepare } from "../roles/preparer";
import { check } from "../roles/checker";
import { coordinate } from "../roles/coordinator";
import {
  completeContext,
  conflictingContext,
  incompleteContext,
  unknownLimitContext,
  wonWithoutAreaContext,
} from "./fixtures";
import type { HandoffContext } from "../types";

function decide(context: HandoffContext) {
  const brief = prepare(context);
  const review = check(brief, context);
  return { brief, review, decision: coordinate(brief, review, context) };
}

describe("height check — computed at read time from two values that are both kept", () => {
  test("within the limit", () => {
    const result = checkHeight("4.00", "4.50", "BEAUTY-2027");
    assert.equal(result.status, "WITHIN_LIMIT");
    assert.equal(result.requested_m, "4.00");
    assert.equal(result.limit_m, "4.50");
  });

  test("equal to the limit is within it", () => {
    assert.equal(checkHeight("5.00", "5.00", "PACK-2026").status, "WITHIN_LIMIT");
  });

  test("above the limit is a breach, and both numbers survive", () => {
    const result = checkHeight("6.00", "5.00", "PACK-2026");
    assert.equal(result.status, "BREACH");
    assert.equal(result.requested_m, "6.00");
    assert.equal(result.limit_m, "5.00");
    assert.match(result.statement, /6\.0 m/);
    assert.match(result.statement, /5\.0 m/);
  });

  test("an absent requested height is not an approval", () => {
    const result = checkHeight(null, "5.00", "PACK-2026");
    assert.equal(result.status, "REQUEST_UNKNOWN");
    assert.match(result.statement, /not an approval/);
  });

  test("an absent limit means the breach cannot be evaluated — not that it is permitted", () => {
    const result = checkHeight("6.00", null, "PACK-2026");
    assert.equal(result.status, "LIMIT_UNKNOWN");
    assert.match(result.statement, /cannot be checked/);
    assert.match(result.statement, /not permission/);
  });

  test("comparison is exact, not floating point", () => {
    assert.equal(checkHeight("4.00", "4.0", null).status, "WITHIN_LIMIT");
    assert.equal(checkHeight("4.01", "4.00", null).status, "BREACH");
  });
});

describe("Gate A — the sales director's condition", () => {
  test("passes when a fair is named and a figure is on file", () => {
    assert.equal(evaluatePolicy(incompleteContext()).gate_a.passes, true);
  });

  test("fails, naming the field, when no fair edition is named", () => {
    const context = incompleteContext();
    context.fair_edition = null;
    const policy = evaluatePolicy(context);
    assert.equal(policy.gate_a.passes, false);
    assert.deepEqual(
      policy.gate_a.unmet.map((item) => item.field),
      ["opportunity.fair_edition_id"],
    );
  });
});

describe("Gate B — the technical coordinator's condition", () => {
  test("passes only when area and height are known and the height is within the limit", () => {
    assert.equal(evaluatePolicy(completeContext()).gate_b.passes, true);
  });

  test("fails on a missing area, and the area is never read as zero", () => {
    const context = completeContext();
    context.opportunity.stand_area_sqm = null;
    const policy = evaluatePolicy(context);
    assert.equal(policy.gate_b.passes, false);
    assert.ok(policy.outstanding.some((item) => item.field === "opportunity.stand_area_sqm"));
    assert.match(
      policy.outstanding.find((item) => item.field === "opportunity.stand_area_sqm")?.message ?? "",
      /not zero square metres/,
    );
  });

  test("fails on a missing height", () => {
    const context = completeContext();
    context.opportunity.requested_height_m = null;
    assert.equal(evaluatePolicy(context).gate_b.passes, false);
  });
});

describe("the three decisions", () => {
  test("complete and compliant -> ACCEPTED", () => {
    const { decision } = decide(completeContext());
    assert.equal(decision.decision, "ACCEPTED");
    assert.equal(decision.proceed, true);
    assert.deepEqual(decision.outstanding, []);
    assert.deepEqual(decision.blockers, []);
  });

  test("fair and budget but no area or height -> PROVISIONAL, naming both", () => {
    const { decision } = decide(incompleteContext());
    assert.equal(decision.decision, "PROVISIONAL");
    assert.equal(decision.proceed, true);

    const fields = decision.outstanding.map((item) => item.field);
    assert.ok(fields.includes("opportunity.stand_area_sqm"), `area not named: ${fields.join(", ")}`);
    assert.ok(fields.includes("opportunity.requested_height_m"), `height not named: ${fields.join(", ")}`);
    assert.match(decision.reason, /Provisional/);
    assert.match(decision.reason, /stand area/i);
    assert.match(decision.reason, /requested height/i);
  });

  test("requested height above the edition limit -> BLOCKED, citing both numbers", () => {
    const { decision, review } = decide(conflictingContext());
    assert.equal(decision.decision, "BLOCKED");
    assert.equal(decision.proceed, false);
    assert.equal(review.height_check.status, "BREACH");
    assert.match(decision.reason, /6\.0 m/);
    assert.match(decision.reason, /5\.0 m/);
    assert.match(decision.reason, /PACK-2026/);
    assert.ok(
      review.blockers.some((finding) => finding.code === "HEIGHT_EXCEEDS_EDITION_LIMIT"),
      "the breach is not a blocker",
    );
  });

  test("a breach is not downgradable: everything else being present does not soften it", () => {
    const context = conflictingContext();
    context.opportunity.stand_area_sqm = "120.00";
    context.opportunity.client_budget_eur = "80000.00";
    const { decision } = decide(context);
    assert.equal(decision.decision, "BLOCKED");
  });

  test("an unknown edition limit is not permission — it cannot reach ACCEPTED", () => {
    const { decision, review } = decide(unknownLimitContext());
    assert.equal(review.height_check.status, "LIMIT_UNKNOWN");
    assert.notEqual(decision.decision, "ACCEPTED");
    assert.equal(decision.decision, "PROVISIONAL");
    assert.ok(
      decision.outstanding.some((item) => item.field === "fair_edition.max_stand_height_m"),
      "the missing limit is not listed as outstanding",
    );
  });

  test("WON is a commercial state and grants no technical approval", () => {
    const { decision, review } = decide(wonWithoutAreaContext());
    assert.equal(decision.decision, "PROVISIONAL");
    assert.ok(review.findings.some((finding) => finding.code === "WON_BUT_NOT_TECHNICALLY_READY"));
  });

  test("no fair edition at all -> BLOCKED, not PROVISIONAL", () => {
    const context = incompleteContext();
    context.fair_edition = null;
    const { decision } = decide(context);
    assert.equal(decision.decision, "BLOCKED");
    assert.equal(decision.proceed, false);
  });
});

describe("missing information changes the outcome", () => {
  test("the same enquiry yields three different decisions as facts are removed", () => {
    const accepted = decide(completeContext()).decision.decision;

    const withoutArea = completeContext();
    withoutArea.opportunity.stand_area_sqm = null;
    const provisional = decide(withoutArea).decision.decision;

    const overHeight = completeContext();
    overHeight.opportunity.requested_height_m = "6.00"; // limit is 4.50
    const blocked = decide(overHeight).decision.decision;

    assert.deepEqual([accepted, provisional, blocked], ["ACCEPTED", "PROVISIONAL", "BLOCKED"]);
  });
});

describe("every finding names a field", () => {
  for (const [name, context] of [
    ["complete", completeContext()],
    ["incomplete", incompleteContext()],
    ["conflicting", conflictingContext()],
    ["unknown limit", unknownLimitContext()],
  ] as const) {
    test(name, () => {
      const { review } = decide(context);
      assert.ok(review.findings.length > 0);
      for (const finding of review.findings) {
        assert.ok(finding.field.length > 0, `${finding.code} names no field`);
        assert.ok(["INFO", "MISSING", "BLOCKER"].includes(finding.severity));
      }
    });
  }
});
