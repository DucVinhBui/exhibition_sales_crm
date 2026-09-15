/**
 * Archive identity: the dataset version from manifest.json and a SHA-256 per source file.
 *
 * Together they answer one question — "is this exact archive already in the database?" —
 * which is what makes a second `./dev.sh` a no-op that preserves user edits.
 *
 * The manifest is advisory, never authoritative. The reviewer replaces the whole `data/`
 * folder with their own copy; a checksum that disagrees with the manifest, or a manifest
 * that is missing outright, WARNS and proceeds. The checksums we store are always the ones
 * we actually computed from the bytes on disk, never the ones the manifest claims.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_FILES = [
  "companies_and_contacts.csv",
  "fair_editions.csv",
  "opportunities.csv",
  "activity_log.csv",
] as const;

export type SourceFile = (typeof SOURCE_FILES)[number];

export interface Manifest {
  readonly dataset_version: string;
  /** Declared sha256 per file, when the manifest supplies one. */
  readonly declaredChecksums: Readonly<Record<string, string>>;
  /** Declared data_rows per file, when the manifest supplies one. */
  readonly declaredRowCounts: Readonly<Record<string, number>>;
  /** `entities` block: expected row counts per entity, used for the post-import assertions. */
  readonly declaredEntities: Readonly<Record<string, number>>;
}

const UNKNOWN_VERSION = "unknown";

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
}

/** Reads manifest.json if present. A missing or unreadable manifest is a warning. */
export async function readManifest(dir: string): Promise<Manifest> {
  const file = path.join(dir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    console.warn(
      `[import] WARNING: no readable manifest.json in ${dir}. Proceeding with dataset_version '${UNKNOWN_VERSION}'; the computed checksums still identify the archive.`,
    );
    return {
      dataset_version: UNKNOWN_VERSION,
      declaredChecksums: {},
      declaredRowCounts: {},
      declaredEntities: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[import] WARNING: manifest.json is not valid JSON (${String(error)}). Proceeding.`);
    return {
      dataset_version: UNKNOWN_VERSION,
      declaredChecksums: {},
      declaredRowCounts: {},
      declaredEntities: {},
    };
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const version = typeof obj.dataset_version === "string" ? obj.dataset_version : UNKNOWN_VERSION;

  const declaredChecksums: Record<string, string> = {};
  const declaredRowCounts: Record<string, number> = {};
  const files = obj.files;
  if (files && typeof files === "object") {
    for (const [name, value] of Object.entries(files as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.sha256 === "string") declaredChecksums[name] = entry.sha256;
      if (typeof entry.data_rows === "number") declaredRowCounts[name] = entry.data_rows;
    }
  }

  const declaredEntities: Record<string, number> = {};
  const entities = obj.entities;
  if (entities && typeof entities === "object") {
    for (const [name, value] of Object.entries(entities as Record<string, unknown>)) {
      if (typeof value === "number") declaredEntities[name] = value;
    }
  }

  return { dataset_version: version, declaredChecksums, declaredRowCounts, declaredEntities };
}

export interface LoadedSource {
  readonly name: SourceFile;
  readonly text: string;
  readonly sha256: string;
}

/** Reads a source file and hashes the exact bytes on disk. */
export async function readSource(dir: string, name: SourceFile): Promise<LoadedSource> {
  const bytes = await readFile(path.join(dir, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Hash the bytes, decode afterwards: a hash of a re-encoded string is not the file's hash.
  return { name, text: bytes.toString("utf8"), sha256 };
}

/**
 * Compares computed checksums with the manifest's. Never throws: a mismatch means the
 * reviewer swapped in their own archive, which must import, not abort.
 */
export function reportChecksums(
  manifest: Manifest,
  sources: readonly LoadedSource[],
): Record<string, string> {
  const computed: Record<string, string> = {};
  for (const source of sources) {
    computed[source.name] = source.sha256;
    const declared = manifest.declaredChecksums[source.name];
    if (declared === undefined) {
      console.warn(`[import] WARNING: manifest.json declares no checksum for ${source.name}.`);
    } else if (declared !== source.sha256) {
      console.warn(
        `[import] WARNING: checksum mismatch for ${source.name}\n` +
          `           manifest: ${declared}\n` +
          `           on disk:  ${source.sha256}\n` +
          "           Importing the file on disk. This is expected when data/ has been replaced.",
      );
    } else {
      console.log(`[import] ${source.name}: sha256 ${source.sha256} (matches manifest)`);
    }
  }
  return computed;
}
