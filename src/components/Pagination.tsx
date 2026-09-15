import Link from "next/link";

/**
 * First / previous / a block of numbered pages / next.
 *
 * Two behaviours here are deliberate.
 *
 * The numbers come from a bounded block fetch (see app/_lib/paging.ts), never from a
 * COUNT(*) over the match. The pager therefore knows exactly which pages this block holds,
 * and knows only that *something* follows it -- which is all a reader needs to keep moving,
 * and all the database can be asked for cheaply at this archive's intended size.
 *
 * Every link sets scroll={false}. The pager sits underneath a long table, so restoring the
 * viewport to the top of the document on each click means scrolling all the way down again
 * to reach the control you just pressed. The href still carries the results anchor, so the
 * same click with JavaScript switched off lands on the table rather than on the masthead.
 */
export function Pagination({
  basePath,
  params,
  anchor,
  page,
  start,
  pages,
  more,
  shown,
}: {
  basePath: string;
  /** Query parameters to carry across, excluding `page`. */
  params: Record<string, string | undefined>;
  /** id of the element the results start at, for the no-JavaScript path. */
  anchor?: string;
  page: number;
  /** 0-based first page of the numbered block. */
  start: number;
  /** How many pages the block holds. */
  pages: number;
  /** Whether a further page exists after the block. */
  more: boolean;
  shown: number;
}) {
  const last = start + pages - 1;
  const hasNext = page < last || more;

  if (page === 0 && !hasNext) {
    return null;
  }

  const href = (target: number): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, value);
    }
    if (target > 0) search.set("page", String(target + 1));
    const query = search.toString();
    const path = query.length > 0 ? `${basePath}?${query}` : basePath;
    return anchor === undefined ? path : `${path}#${anchor}`;
  };

  const step = (target: number, label: string, enabled: boolean) =>
    enabled ? (
      <Link className="button secondary" href={href(target)} scroll={false}>
        {label}
      </Link>
    ) : (
      <span className="button secondary is-disabled" aria-disabled="true">
        {label}
      </span>
    );

  const numbers: number[] = [];
  for (let n = start; n <= last; n += 1) numbers.push(n);

  return (
    <nav className="pager" aria-label="Pagination">
      {step(0, "« First", page > 0)}
      {step(page - 1, "← Previous", page > 0)}

      <ol className="pager__pages">
        {numbers.map((n) => (
          <li key={n}>
            {n === page ? (
              <span className="pager__page is-current" aria-current="page">
                {n + 1}
              </span>
            ) : (
              <Link className="pager__page" href={href(n)} scroll={false}>
                {n + 1}
              </Link>
            )}
          </li>
        ))}
        {more ? (
          <li aria-hidden="true">
            <span className="pager__more">…</span>
          </li>
        ) : null}
      </ol>

      {step(page + 1, "Next →", hasNext)}

      <span className="muted small">
        Page {page + 1} · showing {shown} {shown === 1 ? "row" : "rows"}
      </span>
    </nav>
  );
}
