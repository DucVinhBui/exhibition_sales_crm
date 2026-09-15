/**
 * Numbered paging without ever counting the whole result set.
 *
 * A pager that offers "10, 11, 12 … 19" has to know which of those pages exist, and the
 * obvious way to find out -- COUNT(*) over the match -- is the one thing this application
 * will not do: at 100,000 contacts a count over a trigram match costs as much as the search
 * itself, on every page load, forever.
 *
 * So the screens fetch a BLOCK instead of a page. One query asks for ten pages' worth of
 * rows starting at the block boundary, and the page being rendered is sliced out of that in
 * memory. How many rows came back says exactly how many pages the block holds, and the
 * existing LIMIT n+1 lookahead says whether anything follows it. The extra rows are bounded
 * -- ten pages, never more, whatever the table grows to -- so the cost of the pager does not
 * scale with the archive. That is the whole trade: a few hundred extra rows over the wire in
 * exchange for never scanning the table to produce a page number.
 */
import type { Page } from "./queries";

/** Pages offered as numbered links at once. Blocks are aligned: 1-10, then 11-20. */
export const PAGE_BLOCK = 10;

export interface Block<T> {
  /** The rows of the requested page alone. */
  rows: T[];
  /** 0-based index of the first page in this block. */
  start: number;
  /** How many pages this block actually holds; at least 1, at most PAGE_BLOCK. */
  pages: number;
  /** Whether at least one further page exists after this block. */
  more: boolean;
}

/** 0-based index of the first page in the block containing `page`. */
export function blockStart(page: number): number {
  return Math.floor(page / PAGE_BLOCK) * PAGE_BLOCK;
}

/** Rows a query must ask for to cover a whole block at this page size. */
export function blockSpan(size: number): number {
  return size * PAGE_BLOCK;
}

/**
 * Cuts the requested page out of a fetched block.
 *
 * `fetched` must come from a query called with `blockSpan(size)` as its limit and
 * `blockStart(page) * size` as its offset. Asking for a page past the end of the data is not
 * an error -- it yields an empty page with the pager still able to send the reader back.
 */
export function sliceBlock<T>(fetched: Page<T>, page: number, size: number): Block<T> {
  const start = blockStart(page);
  const from = (page - start) * size;
  return {
    rows: fetched.rows.slice(from, from + size),
    start,
    pages: Math.max(1, Math.ceil(fetched.rows.length / size)),
    more: fetched.hasMore,
  };
}
