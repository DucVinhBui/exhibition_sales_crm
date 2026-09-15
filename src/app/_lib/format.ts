/**
 * Display formatting. Two rules drive everything in this file.
 *
 * 1. NULL means UNKNOWN, and unknown is never rendered as 0, '' or a bare dash that reads
 *    like zero. Every formatter here returns `null` for a null input and lets the caller
 *    render the <Unknown> component, which spells the word out.
 *
 * 2. NUMERIC arrives from node-pg as an exact decimal STRING. It is never parsed into a JS
 *    float here -- not for display and not for comparison. A binary float cannot hold a
 *    decimal-comma euro amount exactly, which is the whole reason the columns are NUMERIC.
 *    So the helpers below do string arithmetic.
 *
 * Output uses the archive's own conventions: decimal comma, DD/MM/YYYY, Europe/Rome.
 */

import type { Decimal, IsoDate } from "@/db/schema";

/* --------------------------------------------------------------------------------------
 * The archive reference clock
 * ------------------------------------------------------------------------------------ */

/**
 * data/README.md: "Archive reference time: 2026-09-01 09:00 Europe/Rome". The follow-up
 * queue is judged overdue against this, not against the wall clock of whoever is running
 * the app -- otherwise the queue's contents change meaning over time and the screen cannot
 * be reviewed. Displayed on the follow-up screen so the basis is never implicit.
 */
export const ARCHIVE_REFERENCE_DATE: IsoDate = "2026-09-01";
export const ARCHIVE_REFERENCE_LABEL = "1 September 2026, 09:00 (Europe/Rome)";

/* --------------------------------------------------------------------------------------
 * Exact decimal handling -- strings in, strings out, no float anywhere
 * ------------------------------------------------------------------------------------ */

interface DecimalParts {
  negative: boolean;
  int: string;
  frac: string;
}

function splitDecimal(value: string): DecimalParts | null {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(trimmed);
  if (!match) return null;
  const sign = match[1] ?? "";
  const int = match[2] ?? "";
  const frac = match[3] ?? "";
  if (int === "" && frac === "") return null;
  return { negative: sign === "-", int: int === "" ? "0" : int, frac };
}

/**
 * Compares two NUMERIC strings exactly. Used for the height breach, where getting the
 * comparison wrong would either hide a conflict or invent one.
 * Returns <0, 0 or >0, or null if either side is not a decimal.
 */
export function compareDecimal(a: string, b: string): number | null {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  if (!left || !right) return null;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;

  const intWidth = Math.max(left.int.length, right.int.length);
  const fracWidth = Math.max(left.frac.length, right.frac.length);
  const leftKey = left.int.padStart(intWidth, "0") + left.frac.padEnd(fracWidth, "0");
  const rightKey = right.int.padStart(intWidth, "0") + right.frac.padEnd(fracWidth, "0");

  const magnitude = leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
  return left.negative ? -magnitude : magnitude;
}

/** Groups the integer part in threes with '.' and joins the fraction with ',' (it-IT). */
function renderDecimal(parts: DecimalParts, fractionDigits: number | null): string {
  const grouped = parts.int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  let frac = parts.frac;
  if (fractionDigits !== null) {
    frac = frac.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  }
  const body = frac.length > 0 ? `${grouped},${frac}` : grouped;
  return parts.negative ? `-${body}` : body;
}

function formatNumeric(value: Decimal | null, fractionDigits: number): string | null {
  if (value === null) return null;
  const parts = splitDecimal(value);
  if (!parts) return null;
  return renderDecimal(parts, fractionDigits);
}

/** '48000.00' -> '48.000,00 €'. null -> null (unknown; the caller renders <Unknown>). */
export function formatEuro(value: Decimal | null): string | null {
  const body = formatNumeric(value, 2);
  return body === null ? null : `${body} €`;
}

/** '80.00' -> '80,00 m²'. Never '0 m²' for a missing area. */
export function formatArea(value: Decimal | null): string | null {
  const body = formatNumeric(value, 2);
  return body === null ? null : `${body} m²`;
}

/** '4.00' -> '4,00 m'. An absent height is unknown, never an approval. */
export function formatHeight(value: Decimal | null): string | null {
  const body = formatNumeric(value, 2);
  return body === null ? null : `${body} m`;
}

/* --------------------------------------------------------------------------------------
 * Dates and instants
 * ------------------------------------------------------------------------------------ */

/**
 * 'YYYY-MM-DD' -> 'DD/MM/YYYY' by string surgery. Deliberately NOT via `new Date(...)`:
 * constructing a Date from a calendar date and reading it back applies a timezone that the
 * value does not have, which is how a follow-up due Friday starts displaying as Thursday.
 */
export function formatDate(value: IsoDate | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

const ROME_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** TIMESTAMPTZ instant -> wall clock in Europe/Rome, the timezone the archive was written in. */
export function formatDateTime(value: Date | null): string | null {
  if (value === null) return null;
  return ROME_DATE_TIME.format(value).replace(",", "");
}

/** 'YYYY-MM-DDTHH:mm' for a datetime-local input, rendered in Europe/Rome. */
export function toRomeInputValue(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Calendar arithmetic, timezone-free. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000);
}

export type FollowUpUrgency = "overdue" | "today" | "soon" | "later";

/** Classifies a follow-up date against the archive reference date, not against "now". */
export function classifyFollowUp(dueOn: IsoDate): FollowUpUrgency {
  const offset = daysBetween(ARCHIVE_REFERENCE_DATE, dueOn);
  if (offset < 0) return "overdue";
  if (offset === 0) return "today";
  if (offset <= 7) return "soon";
  return "later";
}

export function describeFollowUpOffset(dueOn: IsoDate): string {
  const offset = daysBetween(ARCHIVE_REFERENCE_DATE, dueOn);
  if (offset < 0) return `${Math.abs(offset)} day${Math.abs(offset) === 1 ? "" : "s"} overdue`;
  if (offset === 0) return "due today";
  return `in ${offset} day${offset === 1 ? "" : "s"}`;
}

/* --------------------------------------------------------------------------------------
 * Fair edition dates
 * ------------------------------------------------------------------------------------ */

export function formatEditionRun(startsOn: IsoDate, endsOn: IsoDate): string {
  return `${formatDate(startsOn)} – ${formatDate(endsOn)}`;
}

/* --------------------------------------------------------------------------------------
 * Search input handling
 * ------------------------------------------------------------------------------------ */

/**
 * The shortest term the trigram indexes can serve. A pattern of one or two characters
 * contains no complete trigram, so `%ab%` cannot be answered from
 * company_name_trgm_idx / contact_full_name_trgm_idx and degrades to a sequential scan --
 * a defect at 100,000 contacts. The UI asks for a third character instead of running it.
 */
export const MIN_SEARCH_LENGTH = 3;

/**
 * Escapes the LIKE metacharacters in a user's term. This is NOT injection defence -- every
 * query is parameterised -- it stops a typed '%' from matching the entire table.
 */
export function toLikePattern(term: string): string {
  const escaped = term.replace(/([\\%_])/g, "\\$1");
  return `%${escaped}%`;
}
