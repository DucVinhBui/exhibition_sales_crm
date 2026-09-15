/**
 * Staging layer: every source file lands in an UNLOGGED, all-TEXT table that mirrors the
 * CSV column for column, including columns the model drops.
 *
 * Why all TEXT: a typed landing table would have to decide what `''` means at parse time,
 * in four different places. Keeping the raw text means exactly one place — the transform
 * SQL — decides empty -> NULL, decimal comma -> dot and DD/MM/YYYY -> DATE, set-based, for
 * every row at once.
 *
 * Why UNLOGGED: staging is scratch. It is written once, read once and dropped inside the
 * same transaction as the import, so paying WAL for it is pure overhead.
 *
 * Why `unnest($1::text[], ...)` rather than `COPY ... FROM STDIN`: node-pg cannot drive a
 * COPY without the `pg-copy-streams` add-on, and package.json / package-lock.json are not
 * this module's to change. `unnest` of per-column arrays is the same shape of operation —
 * one statement per batch of thousands of rows, a single set-based insert, no per-row
 * round trip. The whole 75,020-row archive loads in one transaction in a few seconds.
 */
import type { PoolClient } from "pg";

/** Rows per INSERT. Bounded so a large archive does not build one huge array literal. */
const BATCH_ROWS = 5_000;

/** PostgreSQL text cannot contain this; caught here to give a legible error. */
const NUL = String.fromCharCode(0);

export interface StagingTable {
  readonly table: string;
  /** Column names, in CSV order. Must equal the file's header. */
  readonly columns: readonly string[];
}

export async function createStagingTable(client: PoolClient, spec: StagingTable): Promise<void> {
  const columns = spec.columns.map((c) => `${quoteIdent(c)} TEXT`).join(",\n    ");
  await client.query(`DROP TABLE IF EXISTS ${quoteIdent(spec.table)}`);
  await client.query(`CREATE UNLOGGED TABLE ${quoteIdent(spec.table)} (\n    ${columns}\n  )`);
}

export async function dropStagingTable(client: PoolClient, spec: StagingTable): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${quoteIdent(spec.table)}`);
}

/**
 * Bulk-loads parsed CSV rows into a staging table.
 *
 * Cells are inserted byte-for-byte as they appear in the file: no trimming, no empty ->
 * NULL, no defaults. Every transformation happens later, in SQL.
 */
export async function bulkLoad(
  client: PoolClient,
  spec: StagingTable,
  rows: readonly (readonly string[])[],
): Promise<number> {
  const columnList = spec.columns.map(quoteIdent).join(", ");
  const unnestArgs = spec.columns.map((_, i) => `$${i + 1}::text[]`).join(", ");
  const sql = `INSERT INTO ${quoteIdent(spec.table)} (${columnList}) SELECT * FROM unnest(${unnestArgs})`;

  let loaded = 0;
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const batch = rows.slice(start, start + BATCH_ROWS);
    const params: string[][] = spec.columns.map(() => new Array<string>(batch.length));

    for (let r = 0; r < batch.length; r += 1) {
      const row = batch[r] as readonly string[];
      for (let c = 0; c < spec.columns.length; c += 1) {
        const cell = row[c] as string;
        if (cell.includes(NUL)) {
          throw new Error(
            `${spec.table}: NUL byte in column ${spec.columns[c]} at data row ${start + r + 1}; PostgreSQL text cannot store it`,
          );
        }
        (params[c] as string[])[r] = cell;
      }
    }

    await client.query(sql, params);
    loaded += batch.length;
  }
  return loaded;
}

/** Identifiers here are module constants, but quoting keeps the generated SQL honest. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
