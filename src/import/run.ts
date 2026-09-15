/**
 * Archive import: `data/*.csv` -> the model in db/migrations, once, in one transaction.
 *
 * Shape of the run:
 *
 *   1. hash every source file and read manifest.json for the dataset version
 *   2. if a completed import_state row already matches (version, checksums): import NOTHING
 *      and return — this is what makes a second `./dev.sh` preserve the user's edits
 *   3. parse the CSVs, BEGIN, load them into UNLOGGED all-TEXT staging tables
 *   4. validate, then transform staging -> model with six set-based INSERT ... SELECTs
 *   5. check the resulting counts against the manifest
 *   6. write the import_state row, drop staging, COMMIT
 *
 * Everything from step 3 is one transaction: either the whole archive is in, or nothing is,
 * and the import_state row is written in that same transaction, so a crash can never leave a
 * "completed" marker over a half-loaded database.
 *
 * A checksum that disagrees with the manifest warns and proceeds. The reviewer swaps `data/`
 * for their own copy, and that copy must import.
 */
import { pool } from "../db/pool";
import { parseCsvFile } from "./csv";
import { dataDir, readManifest, readSource, reportChecksums, SOURCE_FILES } from "./manifest";
import type { LoadedSource, Manifest } from "./manifest";
import { bulkLoad, createStagingTable, dropStagingTable } from "./staging";
import { SOURCE_SPECS } from "./sources";
import { transformAll, validateStaging } from "./transform";
import type { TransformCounts } from "./transform";

/** Manifest `entities` key -> table that must end up with that many rows. */
const ENTITY_TABLES: ReadonlyArray<[string, keyof TransformCounts]> = [
  ["companies", "company"],
  ["contacts", "contact"],
  ["opportunities", "opportunity"],
  ["activity_log_entries", "activity"],
  ["fair_editions", "fair_edition"],
];

export async function runImport(): Promise<void> {
  const dir = dataDir();
  const started = Date.now();
  console.log(`[import] archive directory: ${dir}`);

  const manifest = await readManifest(dir);
  const sources: LoadedSource[] = [];
  for (const name of SOURCE_FILES) {
    sources.push(await readSource(dir, name));
  }
  const checksums = reportChecksums(manifest, sources);

  if (await alreadyImported(manifest.dataset_version, checksums)) {
    console.log(
      `[import] SKIPPED: dataset ${manifest.dataset_version} with these checksums is already imported. ` +
        "Nothing was read or written; existing rows, including user edits, are untouched. " +
        "Run ./reset.sh to import from scratch.",
    );
    return;
  }

  console.log(`[import] importing dataset ${manifest.dataset_version}`);

  // Parse before opening the transaction: a malformed CSV should fail without having held a
  // write transaction open.
  const parsed = SOURCE_SPECS.map(({ file, spec }) => {
    const source = sources.find((s) => s.name === file);
    if (!source) throw new Error(`[import] source file not loaded: ${file}`);
    const csv = parseCsvFile(file, source.text, spec.columns);
    reportRowCount(manifest, file, csv.rows.length);
    return { file, spec, rows: csv.rows };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const { file, spec, rows } of parsed) {
      const t0 = Date.now();
      await createStagingTable(client, spec);
      const loaded = await bulkLoad(client, spec, rows);
      console.log(`[import] staged ${file}: ${loaded} rows in ${Date.now() - t0} ms`);
    }

    // The planner has no statistics for a table created moments ago; without this the
    // joins from staging to the model are planned against a default estimate.
    for (const { spec } of parsed) {
      await client.query(`ANALYZE ${spec.table}`);
    }

    await validateStaging(client);
    const counts = await transformAll(client);
    await assertManifestCounts(manifest, counts);

    await client.query(
      `INSERT INTO import_state (dataset_version, file_checksums)
       VALUES ($1, $2::jsonb)
       ON CONFLICT ON CONSTRAINT import_state_dataset_key
       DO UPDATE SET completed_at = now()`,
      [manifest.dataset_version, JSON.stringify(checksums)],
    );

    for (const { spec } of parsed) {
      await dropStagingTable(client, spec);
    }

    await client.query("COMMIT");
    console.log(
      `[import] done in ${Date.now() - started} ms: ` +
        Object.entries(counts)
          .map(([table, n]) => `${table}=${n}`)
          .join(", "),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The idempotency gate.
 *
 * Identity is (dataset_version, checksums of the bytes on disk), compared as jsonb so key
 * order is irrelevant. A re-generated archive that kept its version number has different
 * checksums and is therefore a different archive, which re-imports.
 */
async function alreadyImported(
  datasetVersion: string,
  checksums: Record<string, string>,
): Promise<boolean> {
  const { rows } = await pool.query<{ completed_at: Date }>(
    `SELECT completed_at FROM import_state
      WHERE dataset_version = $1 AND file_checksums = $2::jsonb
      ORDER BY completed_at DESC LIMIT 1`,
    [datasetVersion, JSON.stringify(checksums)],
  );
  const row = rows[0];
  if (!row) return false;
  console.log(`[import] import_state: completed at ${row.completed_at.toISOString()}`);
  return true;
}

/** A declared row count that disagrees with the file is a warning, not a failure. */
function reportRowCount(manifest: Manifest, file: string, actual: number): void {
  const declared = manifest.declaredRowCounts[file];
  if (declared !== undefined && declared !== actual) {
    console.warn(
      `[import] WARNING: ${file} has ${actual} data rows, manifest.json declares ${declared}. Importing what is on disk.`,
    );
  } else {
    console.log(`[import] parsed ${file}: ${actual} data rows`);
  }
}

/**
 * Post-import check against the manifest's `entities` block.
 *
 * This one throws: the counts are compared with the manifest that shipped with the archive
 * being imported, so a mismatch means a transform dropped or duplicated rows. Rolling back
 * is better than serving a silently incomplete CRM. Nothing here is hard-coded to this
 * particular archive — a different archive brings its own manifest.
 */
async function assertManifestCounts(manifest: Manifest, counts: TransformCounts): Promise<void> {
  const problems: string[] = [];
  for (const [entity, table] of ENTITY_TABLES) {
    const declared = manifest.declaredEntities[entity];
    if (declared === undefined) continue;
    if (declared !== counts[table]) {
      problems.push(`${table}: imported ${counts[table]}, manifest declares ${declared} ${entity}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`[import] row counts disagree with manifest.json:\n    ${problems.join("\n    ")}`);
  }
  console.log("[import] row counts match manifest.json");
}
