/**
 * The single place this application renders a missing value.
 *
 * An empty field in the archive means UNKNOWN. It is never 0, never '', never a default,
 * and never a bare dash that a reader could take for "nothing" or "zero". So it is spelled
 * out as a word, with a title attribute saying what is actually absent.
 *
 * `blocking` is for a value whose absence stops something -- the technical coordinator will
 * not take an enquiry without an area and a height. That is said at the point the value is
 * missing, not only in the handoff panel further down the page.
 */
export function Unknown({
  label = "Unknown",
  note,
  blocking = false,
}: {
  label?: string;
  note?: string;
  blocking?: boolean;
}) {
  const title = note ?? "Not recorded in the archive. Unknown is not zero.";
  return (
    <span className={blocking ? "unknown unknown--blocking" : "unknown"} title={title}>
      {label}
    </span>
  );
}

/**
 * Renders `text` when the formatter produced something, and <Unknown> when it returned null.
 * Every formatter in _lib/format.ts returns null for a null column, so this is the only
 * branch a screen needs to write.
 */
export function Value({
  text,
  note,
  blocking = false,
  unknownLabel,
}: {
  text: string | null;
  note?: string;
  blocking?: boolean;
  unknownLabel?: string;
}) {
  if (text === null) {
    return <Unknown label={unknownLabel} note={note} blocking={blocking} />;
  }
  return <>{text}</>;
}

/** A labelled value in the .facts grid. */
export function Fact({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div>
      <div className="fact__label">{label}</div>
      <div className="fact__value">{children}</div>
      {note ? <div className="fact__note">{note}</div> : null}
    </div>
  );
}
