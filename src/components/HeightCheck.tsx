/**
 * requested_height_m against the edition's max_stand_height_m.
 *
 * Both numbers are stored and BOTH are shown. The comparison is done here, at read time,
 * on the exact decimal strings -- never clamped in the importer, never normalised away, and
 * never parsed into a float. OP000005 asks for 6,00 m at PACK-2026, whose limit is 5,00 m;
 * that row is in the database unchanged and this component is what makes the conflict
 * visible to a salesperson.
 *
 * Two absences matter and are NOT the same as "fine":
 *   - no requested height on file -> unknown, and an absent height is not an approval;
 *   - no limit on file for the edition -> the breach cannot be evaluated, which is not
 *     permission to build any height.
 */
import type { Decimal } from "@/db/schema";
import { compareDecimal, formatHeight } from "@/app/_lib/format";
import { Unknown } from "./Unknown";

export type HeightVerdict = "within" | "breach" | "request-unknown" | "limit-unknown";

export function heightVerdict(
  requested: Decimal | null,
  limit: Decimal | null,
): HeightVerdict {
  if (requested === null) return "request-unknown";
  if (limit === null) return "limit-unknown";
  const comparison = compareDecimal(requested, limit);
  if (comparison === null) return "limit-unknown";
  return comparison > 0 ? "breach" : "within";
}

/** Compact form for a table cell or a header line. */
export function HeightAgainstLimit({
  requested,
  limit,
}: {
  requested: Decimal | null;
  limit: Decimal | null;
}) {
  const verdict = heightVerdict(requested, limit);
  const requestedText = formatHeight(requested);
  const limitText = formatHeight(limit);

  if (verdict === "request-unknown") {
    return (
      <>
        <Unknown
          blocking
          note="No requested height on file. An absent height is not an approval — technical cannot check it."
        />{" "}
        <span className="small muted">
          (edition limit {limitText ?? "not recorded"})
        </span>
      </>
    );
  }

  if (verdict === "limit-unknown") {
    return (
      <>
        {requestedText} requested{" "}
        <span className="pill pill--warn" title="No height limit recorded for this edition, so the request cannot be checked. That is not permission.">
          limit not recorded
        </span>
      </>
    );
  }

  if (verdict === "breach") {
    return (
      <>
        <strong>{requestedText}</strong> requested against a {limitText} limit{" "}
        <span className="pill pill--alarm" title="The requested height exceeds the edition limit. Both values are kept; nothing is clamped.">
          over limit
        </span>
      </>
    );
  }

  return (
    <>
      {requestedText} requested, {limitText} allowed{" "}
      <span className="pill pill--ok">within limit</span>
    </>
  );
}

/** Full-width form for the opportunity header, where the conflict must be impossible to miss. */
export function HeightCheckNotice({
  requested,
  limit,
  editionCode,
}: {
  requested: Decimal | null;
  limit: Decimal | null;
  editionCode: string;
}) {
  const verdict = heightVerdict(requested, limit);
  const requestedText = formatHeight(requested);
  const limitText = formatHeight(limit);

  if (verdict === "breach") {
    return (
      <p className="notice notice--alarm">
        <strong>Height conflict.</strong> The customer has requested {requestedText}. The
        limit for {editionCode} is {limitText}, and the archive records no exceptions. Both
        figures are kept exactly as they are — the request has not been reduced to fit.
        Technical cannot take this enquiry until the brief changes or the organiser confirms
        an exception in writing.
      </p>
    );
  }

  if (verdict === "request-unknown") {
    return (
      <p className="notice notice--warn">
        <strong>Requested height unknown.</strong> Nothing is on file, so it cannot be
        checked against the {limitText ?? "unrecorded"} limit for {editionCode}. An absent
        height is not an approval: ask the customer before the enquiry goes to technical.
      </p>
    );
  }

  if (verdict === "limit-unknown") {
    return (
      <p className="notice notice--warn">
        <strong>No height limit recorded for {editionCode}.</strong> The customer&apos;s{" "}
        {requestedText} request cannot be checked against anything. Absence of a limit is not
        permission — confirm the edition rules with the organiser.
      </p>
    );
  }

  return (
    <p className="notice notice--ok">
      <strong>Height within the edition limit.</strong> {requestedText} requested,{" "}
      {limitText} allowed at {editionCode}. This is a dimensional check only; it is not a
      technical approval.
    </p>
  );
}
