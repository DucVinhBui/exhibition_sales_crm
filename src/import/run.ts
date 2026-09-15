/**
 * Archive import. Owned by the `importer` agent — this is the Phase 0 stub that keeps the
 * startup path whole; it is replaced by the real COPY-and-transform implementation.
 *
 * Contract that must not change: runImport() is idempotent. If this exact archive has
 * already been imported it returns without touching a row, so a second `./dev.sh`
 * preserves user edits instead of duplicating the import.
 */
import { pool } from "../db/pool";

export async function runImport(): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'import_state'
     ) AS exists`,
  );

  if (!rows[0]?.exists) {
    console.log("[import] import_state table not created yet — skipping (Phase 0 stub)");
    return;
  }

  console.log("[import] not implemented yet — skipping archive import");
}
