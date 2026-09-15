import type { OpportunityStatus } from "@/db/schema";

const TONE: Record<OpportunityStatus, string> = {
  OPEN: "pill--accent",
  QUALIFIED: "pill--accent",
  PROPOSAL: "pill--warn",
  WON: "pill--ok",
  LOST: "pill",
};

/**
 * The normalised commercial status, with the raw legacy spelling kept available rather than
 * thrown away: the archive writes it 13 ways and the normalisation has to stay auditable.
 * The raw value is in the title and, on the detail screen, printed in full.
 *
 * Commercial status records NO technical approval. WON does not mean the stand is buildable,
 * so the badge never carries a tick or any other completion signal.
 */
export function StatusBadge({
  status,
  raw,
}: {
  status: OpportunityStatus;
  /** null on an enquiry opened in the CRM: there is no legacy spelling to report. */
  raw: string | null;
}) {
  const normalisedFromRaw = raw === null ? status : raw.trim().toUpperCase();
  const title =
    raw === null
      ? "Opened in this CRM — no legacy spelling to normalise."
      : normalisedFromRaw === status
        ? `Legacy spelling: "${raw}"`
        : `Legacy spelling: "${raw}" (normalised by trim + upper)`;
  return (
    <span className={`pill ${TONE[status]}`} title={title}>
      {status}
    </span>
  );
}
