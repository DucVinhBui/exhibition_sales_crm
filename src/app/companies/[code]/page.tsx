/**
 * "/companies/[code]" — the exhibitor's whole life on one screen.
 *
 * The route key is the company_code, never the name: company names are NOT unique in this
 * archive, so a name-keyed URL would sooner or later show the wrong exhibitor.
 *
 * The page answers the account managers' ask — everything about an exhibitor in one place,
 * with contacts entered once and reused — while keeping the sales coordinator's separation
 * intact: enquiries are grouped by fair and then by edition, and company-wide log entries
 * are shown in their own section, explicitly labelled as belonging to no enquiry.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCompanyActivitySplit,
  getCompanyContacts,
  getCompanyLevelActivity,
  getCompanyOpportunities,
  getCompanyByCode,
  type CompanyOpportunity,
} from "@/app/_lib/queries";
import { formatDate, formatEditionRun, formatEuro, formatArea, formatHeight } from "@/app/_lib/format";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { HeightAgainstLimit } from "@/components/HeightCheck";
import { StatusBadge } from "@/components/StatusBadge";
import { Fact, Value } from "@/components/Unknown";

export const dynamic = "force-dynamic";

const COMPANY_ACTIVITY_LIMIT = 40;

interface EditionGroup {
  edition_code: string;
  city: string | null;
  starts_on: string;
  ends_on: string;
  max_stand_height_m: string | null;
  opportunities: CompanyOpportunity[];
}

interface FairGroup {
  fair_id: string;
  fair_name: string;
  editions: EditionGroup[];
}

/**
 * Groups the rows the database already returned in (fair, edition start DESC) order. The
 * grouping key for a fair is fair_id and for an edition is edition_code — identifiers, not
 * the repeated fair_name string.
 */
function groupByFair(rows: CompanyOpportunity[]): FairGroup[] {
  const fairs: FairGroup[] = [];
  for (const row of rows) {
    let fair = fairs.at(-1);
    if (fair === undefined || fair.fair_id !== row.fair_id) {
      fair = { fair_id: row.fair_id, fair_name: row.fair_name, editions: [] };
      fairs.push(fair);
    }
    let edition = fair.editions.at(-1);
    if (edition === undefined || edition.edition_code !== row.edition_code) {
      edition = {
        edition_code: row.edition_code,
        city: row.edition_city,
        starts_on: row.edition_starts_on,
        ends_on: row.edition_ends_on,
        max_stand_height_m: row.max_stand_height_m,
        opportunities: [],
      };
      fair.editions.push(edition);
    }
    edition.opportunities.push(row);
  }
  return fairs;
}

function countEnquiries(fair: FairGroup): number {
  return fair.editions.reduce((total, edition) => total + edition.opportunities.length, 0);
}

export default async function CompanyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const company = await getCompanyByCode(decodeURIComponent(code));
  if (company === null) {
    notFound();
  }

  const [contacts, opportunities, companyActivity, split] = await Promise.all([
    getCompanyContacts(company.id),
    getCompanyOpportunities(company.id),
    getCompanyLevelActivity(company.id, COMPANY_ACTIVITY_LIMIT),
    getCompanyActivitySplit(company.id),
  ]);

  const fairs = groupByFair(opportunities);
  const editionCount = new Set(opportunities.map((row) => row.edition_code)).size;

  return (
    <main>
      <p className="crumbs">
        <Link href="/">Search</Link> › Exhibitor
      </p>

      <h1>{company.name}</h1>
      <p className="lede">
        <span className="code">{company.company_code}</span> — the identifier this exhibitor
        is keyed on. Exhibitor names in this archive are not unique, so the code is what
        tells two same-named companies apart.
      </p>

      <section className="panel">
        <div className="facts">
          <Fact label="Account owner">
            <Value text={company.sales_rep_name} unknownLabel="No owner recorded" />
          </Fact>
          <Fact label="Region">
            <Value text={company.region} />
          </Fact>
          <Fact label="Province">
            <Value text={company.province_code} />
          </Fact>
          <Fact label="Enquiries">
            {opportunities.length} across {editionCount}{" "}
            {editionCount === 1 ? "edition" : "editions"}
          </Fact>
        </div>
      </section>

      {/* ------------------------------------------------------------------ contacts */}
      <h2>Contacts</h2>
      <p className="small muted">
        Entered once for the exhibitor and reused for every fair and every edition. Nobody
        re-keys a contact per enquiry.
      </p>
      {contacts.length === 0 ? (
        <p className="empty">No contacts recorded for this exhibitor.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Code</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Fax</th>
                <th className="num">Enquiries</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id}>
                  <td>
                    {contact.first_name} {contact.last_name}
                  </td>
                  <td className="code">{contact.contact_code}</td>
                  <td>
                    {contact.email === null ? (
                      <Value text={null} unknownLabel="No address on file" />
                    ) : (
                      <a href={`mailto:${contact.email}`}>{contact.email}</a>
                    )}
                  </td>
                  <td>
                    <Value text={contact.phone} unknownLabel="No number on file" />
                  </td>
                  <td>
                    {/* An empty fax is "not recorded", not "this person has no fax". */}
                    <Value text={contact.fax} unknownLabel="Not recorded" />
                  </td>
                  <td className="num">{contact.opportunity_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --------------------------------------------------------------- enquiries */}
      <h2>Enquiries by fair</h2>
      <p className="small muted">
        Grouped by fair and then by edition, so a returning exhibitor reads as a history.
        Each edition stands on its own: an agreement reached for one edition says nothing
        about the next.
      </p>

      {fairs.length === 0 ? (
        <p className="empty">No enquiries recorded for this exhibitor.</p>
      ) : (
        fairs.map((fair) => (
          <section key={fair.fair_id}>
            <div className="group-heading">
              <h3>{fair.fair_name}</h3>
              <span className="small muted">
                {fair.editions.length} {fair.editions.length === 1 ? "edition" : "editions"} ·{" "}
                {countEnquiries(fair)} {countEnquiries(fair) === 1 ? "enquiry" : "enquiries"}
              </span>
            </div>

            {fair.editions.map((edition) => (
              <div key={edition.edition_code} style={{ margin: "0.6rem 0 1.1rem" }}>
                <p className="small muted" style={{ margin: "0 0 0.3rem" }}>
                  <span className="code">{edition.edition_code}</span>
                  {edition.city === null ? null : <> · {edition.city}</>} ·{" "}
                  {formatEditionRun(edition.starts_on, edition.ends_on)} · height limit{" "}
                  <Value
                    text={formatHeight(edition.max_stand_height_m)}
                    unknownLabel="not recorded"
                    note="No limit on file for this edition. That is not an unlimited height and not an approval."
                  />
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Enquiry</th>
                        <th>Status</th>
                        <th>Contact</th>
                        <th className="num">Value</th>
                        <th className="num">Budget</th>
                        <th className="num">Area</th>
                        <th>Height vs limit</th>
                        <th>Opened</th>
                      </tr>
                    </thead>
                    <tbody>
                      {edition.opportunities.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <Link
                              href={`/opportunities/${encodeURIComponent(row.opportunity_code)}`}
                            >
                              {row.description}
                            </Link>
                            <div className="code muted">{row.opportunity_code}</div>
                          </td>
                          <td>
                            <StatusBadge status={row.status} raw={row.legacy_status_raw} />
                          </td>
                          <td>
                            {row.contact_code === null ? (
                              <Value
                                text={null}
                                unknownLabel="None recorded"
                                note="No primary contact on this enquiry. Unknown — not 'the company itself'."
                              />
                            ) : (
                              `${row.contact_first_name} ${row.contact_last_name}`
                            )}
                          </td>
                          <td className="num">{formatEuro(row.amount_eur)}</td>
                          <td className="num">
                            <Value
                              text={formatEuro(row.client_budget_eur)}
                              unknownLabel="Not stated"
                              note="The customer has not stated a budget. Unknown, not zero."
                            />
                          </td>
                          <td className="num">
                            <Value
                              text={formatArea(row.stand_area_sqm)}
                              blocking
                              unknownLabel="Unknown"
                              note="No plot area on file. Unknown — it is not a stand of zero square metres."
                            />
                          </td>
                          <td>
                            <HeightAgainstLimit
                              requested={row.requested_height_m}
                              limit={row.max_stand_height_m}
                            />
                          </td>
                          <td>{formatDate(row.opened_on)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        ))
      )}

      {/* ------------------------------------------------------- company-wide activity */}
      <h2>Company-wide activity — not tied to any fair edition</h2>
      <p className="small muted">
        {split.company_level === 0 ? (
          <>Nothing has been logged against this exhibitor as a whole. </>
        ) : (
          <>
            These {split.company_level.toLocaleString("en-GB")}{" "}
            {split.company_level === 1 ? "entry was" : "entries were"} logged against the
            exhibitor as a whole and belong to no single enquiry. They are shown here and
            nowhere else: attributing them to an enquiry is exactly how last year&apos;s
            conversation ends up being read as this year&apos;s agreement.{" "}
          </>
        )}
        {split.enquiry_level === 0 ? null : (
          <>
            The other {split.enquiry_level.toLocaleString("en-GB")}{" "}
            {split.enquiry_level === 1 ? "entry belongs" : "entries belong"} to specific
            enquiries and appear on those enquiry pages only.
          </>
        )}
      </p>
      <div className="panel">
        <ActivityTimeline
          entries={companyActivity}
          emptyMessage="No company-wide entries. Every log entry for this exhibitor belongs to a specific enquiry."
        />
        {split.company_level > COMPANY_ACTIVITY_LIMIT ? (
          <p className="small muted" style={{ marginTop: "0.75rem" }}>
            Showing the {COMPANY_ACTIVITY_LIMIT} most recent of{" "}
            {split.company_level.toLocaleString("en-GB")} company-wide entries.
          </p>
        ) : null}
      </div>
    </main>
  );
}
