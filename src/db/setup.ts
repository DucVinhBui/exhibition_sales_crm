/**
 * One-shot startup entrypoint, run by the `migrate` compose service.
 *
 *   1. apply every pending migration in db/migrations, in filename order
 *   2. import the archive, unless an earlier run already imported this exact archive
 *
 * Both steps are idempotent: a second `./dev.sh` must preserve user edits and must not
 * re-import. `./reset.sh` drops the volume, so the next start imports again.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool";
import { runImport } from "../import/run";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");

async function applyMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  let entries: string[];
  try {
    entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.log("[setup] no db/migrations directory yet — nothing to apply");
    return;
  }

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migration",
  );
  const applied = new Set(rows.map((r) => r.filename));

  for (const filename of entries) {
    if (applied.has(filename)) {
      console.log(`[setup] migration already applied: ${filename}`);
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`[setup] applied migration: ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${filename} failed: ${String(error)}`);
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  await applyMigrations();
  await runImport();
  await pool.end();
  console.log("[setup] done");
}

main().catch((error) => {
  console.error("[setup] failed:", error);
  process.exit(1);
});
