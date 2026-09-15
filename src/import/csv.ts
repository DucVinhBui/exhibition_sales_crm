/**
 * Minimal RFC 4180 reader for the archive's dialect: UTF-8 (no BOM), `;` delimiter,
 * `"` quoting with `""` as an escaped quote, LF line endings.
 *
 * Hand-written on purpose. The committed package-lock.json is the reproducibility
 * contract, and a CSV dialect this narrow does not justify adding a dependency to a
 * lockfile this module does not own. It is still a real parser, not a `split(';')`:
 * `activity_log.csv` and `opportunities.csv` quote free text that contains the
 * delimiter, and a naive split would shift every column after `details`.
 *
 * The parser never invents values. An empty field arrives here as `''` and stays `''`
 * all the way into the TEXT staging tables; the empty -> NULL decision belongs to the
 * transform SQL, in one place, where it is auditable.
 */

const QUOTE = '"';
const CR = "\r";
const LF = "\n";

export interface CsvFile {
  readonly header: readonly string[];
  /** Data rows only, in file order. Every cell is the raw source text. */
  readonly rows: readonly (readonly string[])[];
}

/** Parses a whole CSV document. Throws on an unterminated quoted field. */
export function parseCsv(text: string, delimiter = ";"): string[][] {
  // Defensive: the contract says "UTF-8 without BOM", but a stray BOM would otherwise
  // end up glued to the first header name and break header validation with a confusing
  // message.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;

    if (quoted) {
      if (ch === QUOTE) {
        if (source[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === QUOTE && field === "") {
      quoted = true;
      sawAnyChar = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }

    if (ch === LF || ch === CR) {
      if (ch === CR && source[i + 1] === LF) i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }

    field += ch;
    sawAnyChar = true;
  }

  if (quoted) {
    throw new Error("unterminated quoted field: the file ends inside a quoted value");
  }
  // A trailing newline leaves an empty pending row; a file with no trailing newline
  // leaves a real final row. Distinguish them.
  if (field !== "" || sawAnyChar || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parses and validates the header against the columns the transforms rely on.
 *
 * A header mismatch is fatal rather than a warning: silently importing a file whose
 * columns moved would write plausible-looking rubbish into typed columns.
 */
export function parseCsvFile(
  fileName: string,
  text: string,
  expectedHeader: readonly string[],
  delimiter = ";",
): CsvFile {
  const all = parseCsv(text, delimiter);
  const header = all[0];
  if (!header) {
    throw new Error(`${fileName}: file is empty`);
  }
  if (header.length !== expectedHeader.length || header.some((h, i) => h !== expectedHeader[i])) {
    throw new Error(
      `${fileName}: unexpected header.\n  expected: ${expectedHeader.join(";")}\n  actual:   ${header.join(";")}`,
    );
  }

  const rows = all.slice(1);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as string[];
    if (r.length !== expectedHeader.length) {
      throw new Error(
        `${fileName}: line ${i + 2} has ${r.length} fields, expected ${expectedHeader.length}`,
      );
    }
  }

  return { header, rows };
}
