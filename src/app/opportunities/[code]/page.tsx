/**
 * "/opportunities/[code]" — one enquiry, one fair edition.
 *
 * The scoping is the design decision on this screen, not an implementation detail, so it is
 * stated on the page: the header names the edition, its dates and its height limit, and the
 * timeline below contains ONLY entries whose opportunity_id is this enquiry. Not the
 * company's general log, not last year's edition of the same fair. People have been treating
 * a previous edition's agreement as if it still applied; this page is the answer to that.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { listHandoffRuns, MODEL_STAND_IN, POLICY_SUMMARY } from "@/handoff";
import {
  getOpportunityActivity,
  getOpportunityByCode,
  getSiblingOpportunities,
} from "@/app/_lib/queries";
import {
  compareDecimal,
  formatArea,
  formatDate,
  formatDateTime,
  formatEditionRun,
  formatEuro,
  formatHeight,
  toRomeInputValue,
} from "@/app/_lib/format";
import { text, type SearchParams } from "@/app/_lib/params";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { HandoffPanel } from "@/components/HandoffPanel";
import { HeightCheckNotice } from "@/components/HeightCheck";
import { StatusBadge } from "@/components/StatusBadge";
import { Fact, Value } from "@/components/Unknown";
import { OPPORTUNITY_STATUSES } from "@/db/schema";
import { changeStatusAction, logActivityAction, runHandoffAction, saveBriefAction } from "./actions";

export const dynamic = "force-dynamic";

const TIMELINE_LIMIT = 50;

/** Plain-text value for a form input: the edit form shows the decimal comma people type. */
function inputValue(value: string | null): string {
  return value === null ? "" : value.replace(".", ",");
}

export default async function OpportunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { code } = await params;
  const query = await searchParams;
  const opportunity = await getOpportunityByCode(decodeURIComponent(code));
  if (opportunity === null) {
    notFound();
  }

  const [activity, runs, siblings] = await Promise.all([
    getOpportunityActivity(opportunity.id, TIMELINE_LIMIT),
    listHandoffRuns(opportunity.id, { limit: 20 }),
    getSiblingOpportunities(opportunity.company_id, opportunity.id),
  ]);

  const error = text(query, "error");
  const saved = text(query, "saved");
  const ran = text(query, "ran");

  // The two money columns mean different things and are allowed to differ. A difference is
  // worth pointing at, not reconciling: amount_eur is what sales expects to invoice,
  // client_budget_eur is what the customer said they would spend.
  // Either figure missing means there is no gap to describe -- not a gap of zero.
  const budgetGap =
    opportunity.client_budget_eur === null || opportunity.amount_eur === null
      ? null
      : compareDecimal(opportunity.client_budget_eur, opportunity.amount_eur);

  return (
    <main>
      <p className="crumbs">
        <Link href="/">Search</Link> ›{" "}
        <Link href={`/companies/${encodeURIComponent(opportunity.company_code)}`}>
          {opportunity.company_name}
        </Link>{" "}
        › Enquiry
      </p>

      <h1>{opportunity.description}</h1>
      <p className="lede">
        <span className="code">{opportunity.opportunity_code}</span> ·{" "}
        <Link href={`/companies/${encodeURIComponent(opportunity.company_code)}`}>
          {opportunity.company_name}
        </Link>{" "}
        <span className="code">{opportunity.company_code}</span> · account owner{" "}
        <Value text={opportunity.sales_rep_name} unknownLabel="not recorded" />
      </p>

      {error !== "" ? <p className="notice notice--alarm">{error}</p> : null}
      {saved === "created" ? (
        <p className="notice notice--ok">
          Enquiry opened against this edition. The stand area and requested height are still
          unknown — fill in the brief below, then run the assistant.
        </p>
      ) : null}
      {saved.startsWith("status:") ? (
        <p className="notice notice--ok">
          Moved to <strong>{saved.slice("status:".length)}</strong>. The change is recorded on
          the timeline below with who made it — commercial status only, no technical approval.
        </p>
      ) : null}
      {saved === "brief" ? (
        <p className="notice notice--ok">Brief saved. Empty fields were stored as unknown.</p>
      ) : null}
      {saved === "activity" ? <p className="notice notice--ok">Entry recorded against this enquiry.</p> : null}
      {saved === "activity-follow-up" ? (
        <p className="notice notice--ok">
          Entry recorded, and the follow-up is now in the{" "}
          <Link href="/follow-ups">follow-up queue</Link>.
        </p>
      ) : null}
      {ran !== "" ? (
        <p className="notice notice--ok">
          The assistant ran and returned <strong>{ran}</strong>. The run is saved below with
          the facts it used.
        </p>
      ) : null}

      {/* -------------------------------------------------------------- edition header */}
      <section className="panel">
        <div className="group-heading" style={{ marginTop: 0 }}>
          <h2 style={{ margin: 0 }}>
            {opportunity.fair_name}{" "}
            <span className="code">{opportunity.edition_code}</span>
          </h2>
          <span className="pill pill--accent">This edition only</span>
        </div>
        <div className="facts">
          <Fact label="Runs">
            {formatEditionRun(opportunity.edition_starts_on, opportunity.edition_ends_on)}
          </Fact>
          <Fact label="City">
            <Value text={opportunity.edition_city} />
          </Fact>
          <Fact label="Venue">
            <Value text={opportunity.edition_venue} />
          </Fact>
          <Fact
            label="Max stand height"
            note="No exceptions are recorded anywhere in the archive."
          >
            <Value
              text={formatHeight(opportunity.max_stand_height_m)}
              unknownLabel="Not recorded"
              note="No limit on file for this edition. That is not unlimited height and not an approval."
            />
          </Fact>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Everything on this page belongs to this edition. Agreements, measurements and
          conversations from another edition of {opportunity.fair_name} do not carry over,
          and are not shown here.
        </p>
      </section>

      <HeightCheckNotice
        requested={opportunity.requested_height_m}
        limit={opportunity.max_stand_height_m}
        editionCode={opportunity.edition_code}
      />

      {/* ------------------------------------------------------------ commercial facts */}
      <h2>The enquiry</h2>
      <section className="panel">
        <div className="facts">
          <Fact
            label="Status"
            note={
              opportunity.legacy_status_raw === null
                ? "Opened in this CRM — this enquiry was never in the old system."
                : `Legacy spelling in the export: "${opportunity.legacy_status_raw}"`
            }
          >
            <StatusBadge status={opportunity.status} raw={opportunity.legacy_status_raw} />{" "}
            <span className="small muted">commercial only — not a technical approval</span>
          </Fact>
          <Fact label="Primary contact">
            {opportunity.contact_code === null ? (
              <Value
                text={null}
                unknownLabel="None recorded"
                note="No contact is named on this enquiry. Unknown — it does not mean the company itself."
              />
            ) : (
              <>
                {opportunity.contact_first_name} {opportunity.contact_last_name}
                <div className="small muted">
                  {opportunity.contact_email === null ? (
                    <Value text={null} unknownLabel="no address on file" />
                  ) : (
                    <a href={`mailto:${opportunity.contact_email}`}>{opportunity.contact_email}</a>
                  )}
                  {" · "}
                  <Value text={opportunity.contact_phone} unknownLabel="no number on file" />
                </div>
              </>
            )}
          </Fact>
          <Fact label="Opportunity value" note="What sales expects to invoice, excluding VAT.">
            <Value
              text={formatEuro(opportunity.amount_eur)}
              unknownLabel="Not yet recorded"
              note="Sales has put no figure on this enquiry. Unknown, not zero — and with no customer budget either, it sits below Gate A."
            />
          </Fact>
          <Fact
            label="Customer budget"
            note={
              budgetGap === null
                ? "What the customer said they would spend."
                : budgetGap < 0
                  ? "Below the recorded opportunity value — a gap worth raising, not reconciling."
                  : budgetGap > 0
                    ? "Above the recorded opportunity value."
                    : "Matches the recorded opportunity value."
            }
          >
            <Value
              text={formatEuro(opportunity.client_budget_eur)}
              unknownLabel="Not stated"
              note="The customer has not stated a budget. Unknown, never zero."
            />
          </Fact>
          <Fact label="Stand area">
            <Value
              text={formatArea(opportunity.stand_area_sqm)}
              blocking
              unknownLabel="Unknown — blocks technical"
              note="No plot area on file. Unknown, not zero square metres: technical will not start without it."
            />
          </Fact>
          <Fact label="Requested height" note="What the customer asked for. Not an approved height.">
            <Value
              text={formatHeight(opportunity.requested_height_m)}
              blocking
              unknownLabel="Unknown — blocks technical"
              note="No requested height on file. An absent height is not an approval."
            />
          </Fact>
          <Fact label="Opened">{formatDate(opportunity.opened_on)}</Fact>
          <Fact label="Expected close" note="The date of the sales decision.">
            <Value
              text={formatDate(opportunity.expected_close_on)}
              unknownLabel="Not recorded"
              note="No expected close date. That does not mean closed, overdue or imminent."
            />
          </Fact>
          <Fact label="Campaign">
            <Value
              text={opportunity.historical_campaign_code}
              unknownLabel="None attributed"
            />
          </Fact>
        </div>
      </section>

      <form action={changeStatusAction} className="panel">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="status">Move this enquiry to</label>
            <select id="status" name="status" defaultValue={opportunity.status}>
              {OPPORTUNITY_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <span className="field__hint">
              No order is enforced. Real enquiries skip stages and go backwards, and a CRM that
              refused to record that would disagree with what happened.
            </span>
          </div>
          <div className="field">
            <label htmlFor="status_reason">Why (optional)</label>
            <input id="status_reason" name="reason" placeholder="e.g. Signed at the Milan meeting" />
          </div>
          <div className="field">
            <label htmlFor="status_author">Changed by</label>
            <input
              id="status_author"
              name="legacy_author"
              defaultValue={opportunity.sales_rep_name ?? ""}
              placeholder="Your name"
            />
          </div>
        </div>
        <input type="hidden" name="opportunity_code" value={opportunity.opportunity_code} />
        <div className="form-actions">
          <button type="submit" className="secondary">
            Change status
          </button>
          <span className="small muted">
            The move is written to the timeline in the same transaction — the status never
            changes without a record of who moved it. WON records that the customer signed,
            never that the stand can be built.
          </span>
        </div>
      </form>

      {/* ------------------------------------------------------------------ edit brief */}
      <h2>Update the brief</h2>
      <form action={saveBriefAction} className="panel">
        <input type="hidden" name="opportunity_code" value={opportunity.opportunity_code} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="stand_area_sqm">Stand area (m²)</label>
            <input
              id="stand_area_sqm"
              name="stand_area_sqm"
              defaultValue={inputValue(opportunity.stand_area_sqm)}
              inputMode="decimal"
              placeholder="e.g. 80,00"
            />
            <span className="field__hint">Leave empty if unknown. Empty is stored as unknown, not 0.</span>
          </div>
          <div className="field">
            <label htmlFor="requested_height_m">Requested height (m)</label>
            <input
              id="requested_height_m"
              name="requested_height_m"
              defaultValue={inputValue(opportunity.requested_height_m)}
              inputMode="decimal"
              placeholder="e.g. 4,00"
            />
            <span className="field__hint">
              What the customer asked for. A figure over the{" "}
              <Value text={formatHeight(opportunity.max_stand_height_m)} unknownLabel="unrecorded" />{" "}
              limit is saved as asked and flagged — it is never trimmed to fit.
            </span>
          </div>
          <div className="field">
            <label htmlFor="client_budget_eur">Customer budget (EUR)</label>
            <input
              id="client_budget_eur"
              name="client_budget_eur"
              defaultValue={inputValue(opportunity.client_budget_eur)}
              inputMode="decimal"
              placeholder="e.g. 50000,00"
            />
            <span className="field__hint">Excluding VAT. Empty means the customer has not said.</span>
          </div>
          <div className="field field--wide">
            <label htmlFor="brief_notes">Brief notes</label>
            <textarea id="brief_notes" name="brief_notes" defaultValue={opportunity.brief_notes} />
            <span className="field__hint">
              What the stand needs and what is still outstanding. The assistant reads these
              notes but never treats them as a substitute for a missing area or height.
            </span>
          </div>
        </div>
        <div className="form-actions">
          <button type="submit">Save brief</button>
          <span className="small muted">
            Editing here and running the assistant again adds a new run; earlier runs stay as
            they were.
          </span>
        </div>
      </form>

      {/* ------------------------------------------------------------------- timeline */}
      <h2>This enquiry&apos;s conversations</h2>
      <p className="small muted">
        {activity.length === 0
          ? "Scoped to this enquiry alone."
          : `${activity.length} ${activity.length === 1 ? "entry" : "entries"}, scoped to this enquiry alone.`}{" "}
        The exhibitor&apos;s company-wide log and any other edition&apos;s entries are deliberately
        not shown here — see{" "}
        <Link href={`/companies/${encodeURIComponent(opportunity.company_code)}`}>
          {opportunity.company_name}
        </Link>{" "}
        for those.
      </p>
      <div className="panel">
        <ActivityTimeline
          entries={activity}
          emptyMessage="Nothing has been logged against this enquiry yet."
        />
      </div>

      {/* -------------------------------------------------------------- record an entry */}
      <h3>Record a conversation or a task</h3>
      <form action={logActivityAction} className="panel">
        <input type="hidden" name="opportunity_code" value={opportunity.opportunity_code} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="type">Type</label>
            <select id="type" name="type" defaultValue="call">
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="note">Note (internal)</option>
              <option value="task">Task (work still to do)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="occurred_at">When (Europe/Rome)</label>
            <input
              id="occurred_at"
              name="occurred_at"
              type="datetime-local"
              defaultValue={toRomeInputValue(new Date())}
            />
          </div>
          <div className="field">
            <label htmlFor="legacy_author">Logged by</label>
            <input
              id="legacy_author"
              name="legacy_author"
              defaultValue={opportunity.sales_rep_name ?? "crm.user"}
            />
          </div>
          <div className="field field--wide">
            <label htmlFor="details">What was said</label>
            <textarea
              id="details"
              name="details"
              placeholder="e.g. Customer will confirm the floor area on Friday"
            />
          </div>
          <div className="field">
            <label htmlFor="follow_up_on">Follow-up date</label>
            <input id="follow_up_on" name="follow_up_on" type="date" />
            <span className="field__hint">
              Leave empty if nothing is owed. With a date and “pending”, it appears in the
              follow-up queue.
            </span>
          </div>
          <div className="field">
            <label htmlFor="completion">Completion</label>
            <select id="completion" name="completion" defaultValue="completed">
              <option value="completed">Completed — the contact happened</option>
              <option value="pending">Pending — still to do</option>
              <option value="not_applicable">Not applicable — e.g. an internal note</option>
            </select>
            <span className="field__hint">
              Three states, not two. “Not applicable” is stored as NULL and never counted as
              pending work.
            </span>
          </div>
        </div>
        <div className="form-actions">
          <button type="submit">Record entry</button>
          <span className="small muted">
            Saved against {opportunity.opportunity_code} only — never against the exhibitor
            in general.
          </span>
        </div>
      </form>

      {/* -------------------------------------------------------------------- handoff */}
      <HandoffPanel
        opportunityCode={opportunity.opportunity_code}
        runs={runs}
        action={runHandoffAction}
        model={MODEL_STAND_IN}
        policy={POLICY_SUMMARY}
      />

      {/* -------------------------------------------------------------------- siblings */}
      {siblings.length > 0 ? (
        <section>
          <h2>Other enquiries from this exhibitor</h2>
          <p className="small muted">
            Listed for context and linked, never merged into this one. Each is its own
            edition with its own brief.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Enquiry</th>
                  <th>Fair</th>
                  <th>Edition</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {siblings.map((row) => (
                  <tr key={row.opportunity_code}>
                    <td>
                      <Link href={`/opportunities/${encodeURIComponent(row.opportunity_code)}`}>
                        {row.opportunity_code}
                      </Link>
                    </td>
                    <td>{row.fair_name}</td>
                    <td>
                      <span className="code">{row.edition_code}</span>{" "}
                      <span className="small muted">{formatDate(row.edition_starts_on)}</span>
                    </td>
                    <td>
                      <span className="pill">{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="small muted" style={{ marginTop: "2rem" }}>
        Last read {formatDateTime(new Date())} (Europe/Rome).
      </p>
    </main>
  );
}
