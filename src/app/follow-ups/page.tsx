/**
 * "/follow-ups" — what am I waiting for.
 *
 * "If a customer promises to confirm the floor area on Friday, that needs to turn into
 * something they can find and act on." This is that screen.
 *
 * The queue is exactly `is_completed = FALSE AND follow_up_on IS NOT NULL`, which is both
 * the correct reading of the tri-state and the predicate of the partial index the query
 * runs on. `is_completed IS NULL` means NOT APPLICABLE — around 7,948 archive entries,
 * mostly notes, which are neither done nor pending. They are not in this queue, and the
 * counts below say so out loud rather than leaving the exclusion invisible.
 *
 * "Overdue" is measured against the archive reference time, 2026-09-01 09:00 Europe/Rome,
 * not against the clock of whoever opens the page.
 */
import Link from "next/link";
import {
  getFollowUpCounts,
  getFollowUps,
  type FollowUpScope,
} from "@/app/_lib/queries";
import {
  ARCHIVE_REFERENCE_DATE,
  ARCHIVE_REFERENCE_LABEL,
  classifyFollowUp,
  describeFollowUpOffset,
  formatDate,
  formatDateTime,
} from "@/app/_lib/format";
import { pageIndex, text, type SearchParams } from "@/app/_lib/params";
import { blockSpan, blockStart, sliceBlock } from "@/app/_lib/paging";
import { Pagination } from "@/components/Pagination";
import { Value } from "@/components/Unknown";
import { markDoneAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const SCOPES: { key: FollowUpScope; label: string }[] = [
  { key: "all", label: "All pending" },
  { key: "overdue", label: "Overdue" },
  { key: "week", label: "Due within 7 days" },
];

const URGENCY_PILL: Record<string, string> = {
  overdue: "pill--alarm",
  today: "pill--warn",
  soon: "pill--warn",
  later: "pill",
};

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const scopeRaw = text(params, "scope");
  const scope: FollowUpScope =
    scopeRaw === "overdue" ? "overdue" : scopeRaw === "week" ? "week" : "all";
  const page = pageIndex(params);

  const [fetched, counts] = await Promise.all([
    getFollowUps(scope, ARCHIVE_REFERENCE_DATE, blockSpan(PAGE_SIZE), blockStart(page) * PAGE_SIZE),
    getFollowUpCounts(ARCHIVE_REFERENCE_DATE),
  ]);
  const queue = sliceBlock(fetched, page, PAGE_SIZE);

  const backTo = `/follow-ups?scope=${scope}${page > 0 ? `&page=${page + 1}` : ""}`;

  return (
    <main>
      <p className="crumbs">
        <Link href="/">Search</Link> › Follow-ups
      </p>

      <h1>What am I waiting for</h1>
      <p className="lede">
        Every pending task that has a follow-up date, soonest first. Overdue is measured
        against the archive reference time, {ARCHIVE_REFERENCE_LABEL}.
      </p>

      <div className="facts panel">
        <div>
          <div className="fact__label">Pending with a date</div>
          <div className="fact__value">{counts.total.toLocaleString("en-GB")}</div>
          <div className="fact__note">is_completed = false and a follow-up date exists</div>
        </div>
        <div>
          <div className="fact__label">Overdue</div>
          <div className="fact__value" style={{ color: counts.overdue > 0 ? "var(--alarm)" : undefined }}>
            {counts.overdue.toLocaleString("en-GB")}
          </div>
          <div className="fact__note">due before {formatDate(ARCHIVE_REFERENCE_DATE)}</div>
        </div>
        <div>
          <div className="fact__label">Due within 7 days</div>
          <div className="fact__value">{counts.due_this_week.toLocaleString("en-GB")}</div>
          <div className="fact__note">from the reference date onwards</div>
        </div>
        <div>
          <div className="fact__label">Deliberately excluded</div>
          <div className="fact__value small">
            {counts.completed_with_date.toLocaleString("en-GB")} completed ·{" "}
            {counts.not_applicable_with_date.toLocaleString("en-GB")} not applicable
          </div>
          <div className="fact__note">
            Entries that carry a date but are done, or whose completion marker is empty. An
            empty marker is not “not done”: it means the question does not apply, so the row
            is not work anyone owes.
          </div>
        </div>
      </div>

      <div className="filters">
        {SCOPES.map((option) => (
          <Link
            key={option.key}
            href={option.key === "all" ? "/follow-ups" : `/follow-ups?scope=${option.key}`}
            aria-current={option.key === scope ? "true" : undefined}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <div id="queue" />

      {queue.rows.length === 0 ? (
        <p className="empty">
          {page > 0 ? (
            "That page is past the end of this queue."
          ) : (
            <>
              Nothing pending in this view. That is an empty queue, not an absent one —
              entries whose completion marker does not apply are never counted here.
            </>
          )}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>What is owed</th>
                <th>Exhibitor</th>
                <th>Belongs to</th>
                <th>Owner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.rows.map((row) => {
                const urgency = classifyFollowUp(row.follow_up_on);
                return (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <strong>{formatDate(row.follow_up_on)}</strong>
                      <div>
                        <span className={`pill ${URGENCY_PILL[urgency] ?? "pill"}`}>
                          {describeFollowUpOffset(row.follow_up_on)}
                        </span>
                      </div>
                    </td>
                    <td>
                      {row.details}
                      <div className="small muted">
                        {row.type} logged {formatDateTime(row.occurred_at)} ·{" "}
                        <span className="code">{row.entry_id}</span>
                      </div>
                    </td>
                    <td>
                      <Link href={`/companies/${encodeURIComponent(row.company_code)}`}>
                        {row.company_name}
                      </Link>
                      <div className="code muted">{row.company_code}</div>
                    </td>
                    <td>
                      {row.opportunity_code === null ? (
                        <span className="small muted">
                          The exhibitor as a whole — not tied to any enquiry or edition
                        </span>
                      ) : (
                        <>
                          <Link
                            href={`/opportunities/${encodeURIComponent(row.opportunity_code)}`}
                          >
                            {row.opportunity_description}
                          </Link>
                          <div className="small muted">
                            <span className="code">{row.opportunity_code}</span>
                            {row.edition_code === null ? null : (
                              <>
                                {" · "}
                                {row.fair_name} <span className="code">{row.edition_code}</span>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      <Value text={row.sales_rep_name} unknownLabel="No owner recorded" />
                      <div className="small muted">{row.legacy_author}</div>
                    </td>
                    <td>
                      <form action={markDoneAction}>
                        <input type="hidden" name="entry_id" value={row.entry_id} />
                        <input type="hidden" name="back" value={backTo} />
                        <button className="secondary" type="submit">
                          Mark done
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        basePath="/follow-ups"
        params={{ scope: scope === "all" ? undefined : scope }}
        anchor="queue"
        page={page}
        start={queue.start}
        pages={queue.pages}
        more={queue.more}
        shown={queue.rows.length}
      />
    </main>
  );
}
