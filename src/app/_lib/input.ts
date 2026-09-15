/**
 * Form input parsing. Two jobs, both of which the rest of the app depends on getting right.
 *
 * 1. AN EMPTY FIELD MEANS UNKNOWN. It parses to `null`, which is written to the database as
 *    NULL — the same meaning the archive's empty CSV field carries. It never becomes 0, ''
 *    or a default, and clearing a value back to unknown is a legitimate edit rather than a
 *    no-op. (The CHECK constraints in 001_init.sql would reject a 0 anyway, which is how a
 *    bug here would surface loudly instead of silently producing a 0 m² stand.)
 *
 * 2. NUMBERS STAY STRINGS. A euro amount is validated and normalised by string operations
 *    and handed to Postgres as text for the NUMERIC cast. Nothing here goes through
 *    parseFloat: a binary float cannot hold a decimal-comma amount exactly.
 */

export type ParseResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Accepts '80', '80,5', '80.50' — the archive writes a decimal comma and so do the people
 * using this. Rejects anything else rather than guessing.
 */
export function parseDecimalInput(
  raw: string,
  field: { label: string; precision: number; scale: number },
): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  const normalised = trimmed.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalised)) {
    return {
      ok: false,
      error: `${field.label}: "${trimmed}" is not a number. Use digits with an optional decimal comma, for example 80,00. Leave it empty if it is unknown — empty means unknown, not zero.`,
    };
  }

  const [intPart = "", fracPart = ""] = normalised.split(".");
  if (fracPart.length > field.scale) {
    return {
      ok: false,
      error: `${field.label}: at most ${field.scale} decimal places.`,
    };
  }
  if (intPart.replace(/^0+/, "").length > field.precision - field.scale) {
    return {
      ok: false,
      error: `${field.label}: too large for this field.`,
    };
  }
  if (/^0*$/.test(intPart) && /^0*$/.test(fracPart)) {
    return {
      ok: false,
      error: `${field.label}: zero is not a value this field can hold. If the figure is not known, leave it empty — that records it as unknown.`,
    };
  }

  return { ok: true, value: `${intPart}.${fracPart.padEnd(field.scale, "0")}` };
}

/** 'YYYY-MM-DD' from a date input, or null when the field was left empty. */
export function parseDateInput(raw: string, label: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: `${label}: expected a calendar date.` };
  }
  return { ok: true, value: trimmed };
}

/* --------------------------------------------------------------------------------------
 * Europe/Rome wall clock -> instant
 * ------------------------------------------------------------------------------------ */

/** How far Europe/Rome is ahead of UTC at a given instant, in milliseconds. */
function romeOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - instant.getTime();
}

/**
 * Turns 'YYYY-MM-DDTHH:mm' typed by someone sitting in Italy into the instant it denotes.
 *
 * The archive's date-times are Europe/Rome wall-clock readings and the column is
 * TIMESTAMPTZ, so the conversion has to be explicit: relying on the process timezone would
 * move every entry the day the container's TZ changes. The offset is resolved twice so that
 * a time written on a DST changeover day lands on the right side of the jump.
 */
export function romeWallClockToInstant(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw.trim())) return null;
  const withSeconds = raw.trim().length === 16 ? `${raw.trim()}:00` : raw.trim();
  const naive = new Date(`${withSeconds}Z`);
  if (Number.isNaN(naive.getTime())) return null;
  const firstGuess = new Date(naive.getTime() - romeOffsetMs(naive));
  return new Date(naive.getTime() - romeOffsetMs(firstGuess));
}
