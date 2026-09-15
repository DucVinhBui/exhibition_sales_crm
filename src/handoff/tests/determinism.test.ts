/**
 * The determinism guarantee, asserted rather than claimed.
 *
 * The stand-in has to produce byte-identical output for identical input, because a run is
 * stored and revisited: a reviewer must be able to re-run a brief and see the same words, and
 * a diff between two runs must mean the FACTS changed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";

import { executeHandoff } from "../run";
import { prepare } from "../roles/preparer";
import { check } from "../roles/checker";
import { coordinate } from "../roles/coordinator";
import {
  completeContext,
  conflictingContext,
  incompleteContext,
  unknownLimitContext,
} from "./fixtures";
import type { HandoffContext } from "../types";

const CONTEXTS: ReadonlyArray<[string, () => HandoffContext]> = [
  ["complete", completeContext],
  ["incomplete", incompleteContext],
  ["conflicting", conflictingContext],
  ["unknown limit", unknownLimitContext],
];

describe("the same context run twice produces identical role outputs", () => {
  for (const [name, make] of CONTEXTS) {
    test(name, () => {
      const first = executeHandoff(make());
      const second = executeHandoff(make());

      assert.equal(JSON.stringify(first.brief), JSON.stringify(second.brief));
      assert.equal(JSON.stringify(first.review), JSON.stringify(second.review));
      assert.equal(JSON.stringify(first.decision), JSON.stringify(second.decision));
      // Byte-identical across the whole result, not merely deep-equal field by field:
      // key ORDER matters too, because the run is stored as JSONB and read back as text.
      assert.equal(JSON.stringify(first), JSON.stringify(second));
    });
  }

  test("and again after a round trip through JSON, as the snapshot takes", () => {
    const context = incompleteContext();
    const direct = executeHandoff(context);
    const roundTripped = executeHandoff(JSON.parse(JSON.stringify(context)) as HandoffContext);
    assert.equal(JSON.stringify(direct), JSON.stringify(roundTripped));
  });

  test("each role is individually deterministic", () => {
    const context = conflictingContext();
    const briefA = prepare(context);
    const briefB = prepare(context);
    assert.equal(JSON.stringify(briefA), JSON.stringify(briefB));

    const reviewA = check(briefA, context);
    const reviewB = check(briefB, context);
    assert.equal(JSON.stringify(reviewA), JSON.stringify(reviewB));

    assert.equal(
      JSON.stringify(coordinate(briefA, reviewA, context)),
      JSON.stringify(coordinate(briefB, reviewB, context)),
    );
  });

  test("a different context produces different output — the assistant is not a constant", () => {
    const outputs = CONTEXTS.map(([, make]) => JSON.stringify(executeHandoff(make())));
    assert.equal(new Set(outputs).size, outputs.length);

    const decisions = CONTEXTS.map(([, make]) => executeHandoff(make()).decision.decision);
    assert.ok(new Set(decisions).size >= 3, `only ${new Set(decisions).size} distinct decisions`);
  });
});

/* =======================================================================================
 * Purity, checked at the source level: a deterministic stand-in that grows a clock read or
 * a network call later would still pass the tests above on the day it was written.
 * ===================================================================================== */

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, including the file header
    .replace(/(^|[^:])\/\/.*$/gm, "$1 "); // line comments
}

function sourceWithoutCommentsOrStrings(relative: string): string {
  const raw = withoutComments(readFileSync(path.join(SOURCE_ROOT, relative), "utf8"));
  return raw
    .replace(/`(?:[^`\\]|\\.)*`/g, "``") // template literals
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/Math\s*\.\s*random/, "randomness"],
  [/\bnew\s+Date\b/, "a clock read"],
  [/Date\s*\.\s*now/, "a clock read"],
  [/performance\s*\.\s*now/, "a clock read"],
  [/process\s*\.\s*hrtime/, "a clock read"],
  [/\bfetch\s*\(/, "a network call"],
  [/\brequire\s*\(/, "a dynamic load"],
  [/\bimport\s*\(/, "a dynamic import"],
  [/node:fs|node:http|node:net|node:child_process/, "I/O"],
  [/process\s*\.\s*env/, "environment-dependent behaviour"],
  [/toLocaleString|toLocaleDateString|Intl\./, "ICU-dependent formatting"],
];

describe("source-level purity of the deterministic path", () => {
  for (const file of [
    "model.ts",
    "policy.ts",
    "decimal.ts",
    "roles/preparer.ts",
    "roles/checker.ts",
    "roles/coordinator.ts",
  ]) {
    test(file, () => {
      const source = sourceWithoutCommentsOrStrings(file);
      for (const [pattern, why] of FORBIDDEN) {
        assert.ok(!pattern.test(source), `${file} contains ${why} (${pattern})`);
      }
    });
  }

  test("model.ts declares itself a stand-in and exports the label the UI renders", async () => {
    const raw = readFileSync(path.join(SOURCE_ROOT, "model.ts"), "utf8");
    assert.match(raw, /STAND-IN/i);
    const { MODEL_STAND_IN, MODEL_STAND_IN_BADGE, MODEL_STAND_IN_LABEL } = await import("../model");
    assert.match(MODEL_STAND_IN_BADGE, /stand-in/i);
    assert.match(MODEL_STAND_IN_LABEL, /stand-in/i);
    assert.match(MODEL_STAND_IN_LABEL, /no model call/i);
    assert.equal(MODEL_STAND_IN.badge, MODEL_STAND_IN_BADGE);
  });

  test("no module in src/handoff imports a network or model client", () => {
    for (const file of [
      "model.ts",
      "policy.ts",
      "decimal.ts",
      "types.ts",
      "run.ts",
      "queries.ts",
      "index.ts",
      "roles/preparer.ts",
      "roles/checker.ts",
      "roles/coordinator.ts",
    ]) {
      const raw = withoutComments(readFileSync(path.join(SOURCE_ROOT, file), "utf8"));
      const imports = [...raw.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const specifier of imports) {
        const local = specifier.startsWith(".") || specifier === "pg" || specifier.startsWith("node:");
        assert.ok(local, `${file} imports ${specifier}`);
      }
    }
  });
});
