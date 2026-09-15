/**
 * A list of log entries, newest first.
 *
 * The tri-state is rendered as three distinct things, because it is three distinct things:
 *
 *   is_completed = true   -> Completed
 *   is_completed = false  -> Pending  (this is what the follow-up queue is made of)
 *   is_completed = null   -> Not applicable — typically a note, which is neither done nor
 *                            pending. Showing it as "not completed" would be a lie about
 *                            ~7,948 archive rows.
 *
 * The caller decides WHICH entries to pass in. This component never fetches, so it can
 * never widen the scope of a timeline by accident.
 */
import Link from "next/link";
import type { ActivityType } from "@/db/schema";
import type { ActivityRow } from "@/app/_lib/queries";
import { classifyFollowUp, describeFollowUpOffset, formatDate, formatDateTime } from "@/app/_lib/format";

const TYPE_LABEL: Record<ActivityType, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
  task: "Task",
};

function CompletionMark({ value }: { value: boolean | null }) {
  if (value === true) return <span className="pill pill--ok">Completed</span>;
  if (value === false) return <span className="pill pill--warn">Pending</span>;
  return (
    <span
      className="pill"
      title="The archive leaves the completion marker empty here: not applicable. Neither done nor pending, and deliberately not counted as either."
    >
      Not applicable
    </span>
  );
}

export function ActivityTimeline({
  entries,
  emptyMessage,
}: {
  entries: ActivityRow[];
  emptyMessage: string;
}) {
  if (entries.length === 0) {
    return <p className="empty">{emptyMessage}</p>;
  }

  return (
    <ul className="timeline">
      {entries.map((entry) => {
        const pending = entry.is_completed === false && entry.follow_up_on !== null;
        const urgency = entry.follow_up_on === null ? null : classifyFollowUp(entry.follow_up_on);
        const overdue = pending && urgency === "overdue";
        const className = [
          "timeline__item",
          pending ? "timeline__item--pending" : "",
          overdue ? "timeline__item--overdue" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <li key={entry.id} className={className}>
            <div className="timeline__head">
              <span className="pill">{TYPE_LABEL[entry.type]}</span>
              <span>{formatDateTime(entry.occurred_at)}</span>
              <span>· {entry.legacy_author}</span>
              <CompletionMark value={entry.is_completed} />
              <span className="code muted">{entry.entry_id}</span>
            </div>
            <p className="timeline__details">{entry.details}</p>
            {entry.follow_up_on !== null ? (
              <div className="timeline__foot">
                Follow-up {formatDate(entry.follow_up_on)}
                {pending ? (
                  <>
                    {" "}
                    ({describeFollowUpOffset(entry.follow_up_on)}) —{" "}
                    <Link href="/follow-ups">in the follow-up queue</Link>
                  </>
                ) : entry.is_completed === true ? (
                  " — already handled, so it is not in the follow-up queue"
                ) : (
                  " — completion is not applicable to this entry, so it is not in the follow-up queue"
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
