/** Exact decimal comparison and formatting — the arithmetic a height check rests on. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareDecimal, formatDate, formatEuro, formatMetres, formatSquareMetres } from "../decimal";

describe("compareDecimal", () => {
  test("compares by value, not by string", () => {
    assert.equal(compareDecimal("4.00", "4.0"), 0);
    assert.equal(compareDecimal("10.00", "9.00"), 1);
    assert.equal(compareDecimal("4.50", "6.00"), -1);
  });

  test("is exact where a float is not", () => {
    // 0.1 + 0.2 > 0.3 in binary floating point. Here it does not arise at all.
    assert.equal(compareDecimal("0.30", "0.3"), 0);
    assert.equal(compareDecimal("4999999.99", "5000000.00"), -1);
  });
});

describe("formatting", () => {
  test("metres always read as a measurement", () => {
    assert.equal(formatMetres("6.00"), "6.0 m");
    assert.equal(formatMetres("4.50"), "4.5 m");
    assert.equal(formatMetres("4.25"), "4.25 m");
  });

  test("area drops empty decimals", () => {
    assert.equal(formatSquareMetres("80.00"), "80 m²");
    assert.equal(formatSquareMetres("47.50"), "47.5 m²");
  });

  test("euros group without Intl", () => {
    assert.equal(formatEuro("50000.00"), "€50,000.00");
    assert.equal(formatEuro("999.00"), "€999.00");
    assert.equal(formatEuro("1234567.89"), "€1,234,567.89");
  });

  test("dates keep the team's spelling and never move a day", () => {
    assert.equal(formatDate("2026-09-04"), "04/09/2026");
  });
});
