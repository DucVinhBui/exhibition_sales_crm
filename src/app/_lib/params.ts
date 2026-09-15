/** Query-string reading. Next gives every parameter as string | string[] | undefined. */

export type SearchParams = Record<string, string | string[] | undefined>;

export function one(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function text(params: SearchParams, key: string): string {
  return (one(params[key]) ?? "").trim();
}

/**
 * `?page=1` is the first page, and the value returned here is the zero-based index.
 * Anything unparseable falls back to the first page rather than erroring: a mangled URL
 * should show results, not a stack trace.
 */
export function pageIndex(params: SearchParams, key = "page"): number {
  const raw = one(params[key]);
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  // A sane ceiling. Nobody pages 10,000 deep, and it bounds the OFFSET the database sees.
  return Math.min(parsed - 1, 999);
}
