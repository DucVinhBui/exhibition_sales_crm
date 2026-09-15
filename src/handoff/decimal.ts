/**
 * Exact decimal helpers for the handoff assistant.
 *
 * NUMERIC columns arrive from node-pg as strings ('4.00', '80.00', '50000.00') and they stay
 * strings all the way to the screen. Parsing a height or a euro amount into a JS float
 * reintroduces exactly the error NUMERIC exists to prevent, and a height comparison decided
 * by binary rounding is not something anyone should defend to a technical coordinator.
 *
 * So: compare by scaling both operands to a common number of decimal places and comparing
 * BigInts. Format by string surgery. No Number(), no parseFloat(), no toLocaleString() —
 * the last one is ICU-dependent and would make the output vary by environment, which would
 * break the determinism guarantee the whole assistant rests on.
 */
import type { Decimal } from "../db/schema";

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

interface ParsedDecimal {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parseDecimal(value: string): ParsedDecimal {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) {
    throw new Error(`Not a decimal value: ${JSON.stringify(value)}`);
  }
  const [, sign = "", integer = "0", fraction = ""] = match;
  return { negative: sign === "-", integer, fraction };
}

/** True when `value` is a decimal this module can read. Never throws. */
export function isDecimal(value: string): boolean {
  return DECIMAL_RE.test(value.trim());
}

/**
 * Exact three-way comparison. Returns -1 when a < b, 0 when a is numerically equal to b
 * (so '4.0' equals '4.00'), and 1 when a > b.
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const left = parseDecimal(a);
  const right = parseDecimal(b);

  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftScaled = BigInt(left.integer + left.fraction.padEnd(scale, "0")) * (left.negative ? -1n : 1n);
  const rightScaled = BigInt(right.integer + right.fraction.padEnd(scale, "0")) * (right.negative ? -1n : 1n);

  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

/** Drops trailing zeros from the fraction, keeping at least `minDecimals` of them. */
function trimFraction(value: string, minDecimals: number): string {
  const { negative, integer, fraction } = parseDecimal(value);
  let trimmed = fraction;
  while (trimmed.length > minDecimals && trimmed.endsWith("0")) {
    trimmed = trimmed.slice(0, -1);
  }
  while (trimmed.length < minDecimals) {
    trimmed += "0";
  }
  const body = trimmed.length > 0 ? `${integer}.${trimmed}` : integer;
  return negative ? `-${body}` : body;
}

/**
 * A height, in metres, for prose: '6.00' -> '6.0 m', '4.50' -> '4.5 m', '4.25' -> '4.25 m'.
 * One decimal is always shown so a limit reads as a measurement rather than a count.
 */
export function formatMetres(value: Decimal): string {
  return `${trimFraction(value, 1)} m`;
}

/** An area, in square metres: '80.00' -> '80 m²', '47.50' -> '47.5 m²'. */
export function formatSquareMetres(value: Decimal): string {
  return `${trimFraction(value, 0)} m²`;
}

/**
 * A euro amount: '50000.00' -> '€50,000.00'. Grouping is done by hand rather than with
 * Intl, which varies with the runtime's ICU data.
 */
export function formatEuro(value: Decimal): string {
  const { negative, integer, fraction } = parseDecimal(value);
  const cents = (fraction + "00").slice(0, 2);

  let grouped = "";
  for (let i = 0; i < integer.length; i += 1) {
    const fromEnd = integer.length - i;
    grouped += integer.charAt(i);
    if (fromEnd > 1 && fromEnd % 3 === 1) grouped += ",";
  }

  return `${negative ? "-" : ""}€${grouped}.${cents}`;
}

/** A calendar date, 'YYYY-MM-DD' -> 'DD/MM/YYYY', the spelling the archive and the team use. */
export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}
