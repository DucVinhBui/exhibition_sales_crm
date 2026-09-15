import Link from "next/link";

/**
 * Previous / next over a fixed page size. The page never asks the database for a total
 * count of matching rows: a COUNT(*) over a trigram match at 100,000 contacts costs as much
 * as the search itself. Instead each query asks for one row more than it shows, and the
 * presence of that extra row is what enables "Next".
 */
export function Pagination({
  basePath,
  params,
  page,
  hasMore,
  shown,
}: {
  basePath: string;
  /** Query parameters to carry across, excluding `page`. */
  params: Record<string, string | undefined>;
  page: number;
  hasMore: boolean;
  shown: number;
}) {
  if (page === 0 && !hasMore) {
    return null;
  }

  const href = (target: number): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, value);
    }
    if (target > 0) search.set("page", String(target + 1));
    const query = search.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
  };

  return (
    <nav className="pager">
      {page > 0 ? (
        <Link className="button secondary" href={href(page - 1)}>
          ← Previous
        </Link>
      ) : (
        <span className="button secondary" aria-disabled="true" style={{ opacity: 0.4 }}>
          ← Previous
        </span>
      )}
      {hasMore ? (
        <Link className="button secondary" href={href(page + 1)}>
          Next →
        </Link>
      ) : (
        <span className="button secondary" aria-disabled="true" style={{ opacity: 0.4 }}>
          Next →
        </span>
      )}
      <span className="muted small">
        Page {page + 1} · showing {shown} {shown === 1 ? "row" : "rows"}
      </span>
    </nav>
  );
}
