/**
 * "/" — the front door: one box that searches exhibitors and contacts together.
 *
 * Two things about this file are load-bearing beyond the rendering.
 *
 * 1. It must return a real HTTP 200. verify.sh curls "/" WITHOUT following redirects, so
 *    there is no redirect here, not even to a default search. An unreachable database is
 *    caught and reported inside a 200 page rather than thrown, because a reviewer starting
 *    the stack should see an explanation, not a 500.
 *
 * 2. Every query it runs is index-backed (see _lib/queries.ts). A term shorter than three
 *    characters is refused rather than run, because a one- or two-character LIKE pattern
 *    contains no whole trigram and would sequentially scan every company and contact — the
 *    exact defect the 100,000-contact requirement rules out.
 */
import Link from "next/link";
import {
  getArchiveTotals,
  listCompanies,
  searchCompanies,
  searchContacts,
  type ArchiveTotals,
  type CompanyHit,
  type ContactHit,
  type Page as ResultPage,
} from "./_lib/queries";
import { MIN_SEARCH_LENGTH } from "./_lib/format";
import { pageIndex, text, type SearchParams } from "./_lib/params";
import { Pagination } from "@/components/Pagination";
import { Value } from "@/components/Unknown";

export const dynamic = "force-dynamic";

const PREVIEW_SIZE = 8;
const FULL_PAGE_SIZE = 25;

type Only = "companies" | "contacts" | null;

/** "≈ 10,000 exhibitors", or nothing at all when the estimate is not available yet. */
function approx(value: number | null, noun: string): string {
  return value === null ? `${noun} (size not yet measured)` : `≈ ${value.toLocaleString("en-GB")} ${noun}`;
}

function CompanyTable({ rows }: { rows: CompanyHit[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Exhibitor</th>
            <th>Code</th>
            <th>Province</th>
            <th>Region</th>
            <th>Account owner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/companies/${encodeURIComponent(row.company_code)}`}>{row.name}</Link>
              </td>
              {/*
                The code is a column of its own, not a tooltip. Company NAMES ARE NOT UNIQUE
                in this archive: two different exhibitors can be called the same thing, and
                the only way to tell which one you are looking at is the company_code.
              */}
              <td className="code">{row.company_code}</td>
              <td>
                <Value text={row.province_code} />
              </td>
              <td>
                <Value text={row.region} />
              </td>
              <td>
                <Value text={row.sales_rep_name} unknownLabel="No owner recorded" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactTable({ rows }: { rows: ContactHit[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contact</th>
            <th>Exhibitor</th>
            <th>Region</th>
            <th>Account owner</th>
            <th>Email</th>
            <th>Phone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.first_name} {row.last_name}
                <div className="code muted">{row.contact_code}</div>
              </td>
              <td>
                <Link href={`/companies/${encodeURIComponent(row.company_code)}`}>
                  {row.company_name}
                </Link>
                <div className="code muted">{row.company_code}</div>
              </td>
              <td>
                <Value text={row.region} />
              </td>
              <td>
                <Value text={row.sales_rep_name} unknownLabel="No owner recorded" />
              </td>
              <td>
                {row.email === null ? (
                  <Value text={null} unknownLabel="No address on file" />
                ) : (
                  <a href={`mailto:${row.email}`}>{row.email}</a>
                )}
              </td>
              <td>
                <Value text={row.phone} unknownLabel="No number on file" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Loaded {
  totals: ArchiveTotals;
  companies: ResultPage<CompanyHit> | null;
  contacts: ResultPage<ContactHit> | null;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const term = text(params, "q");
  const onlyRaw = text(params, "only");
  const only: Only = onlyRaw === "companies" ? "companies" : onlyRaw === "contacts" ? "contacts" : null;
  const page = pageIndex(params);

  const searching = term.length >= MIN_SEARCH_LENGTH;
  const termTooShort = term.length > 0 && !searching;
  const size = only === null ? PREVIEW_SIZE : FULL_PAGE_SIZE;
  const offset = only === null ? 0 : page * size;

  let loaded: Loaded | null = null;
  let failure: string | null = null;

  try {
    const totals = await getArchiveTotals();
    if (searching) {
      const [companies, contacts] = await Promise.all([
        only === "contacts" ? Promise.resolve(null) : searchCompanies(term, size, offset),
        only === "companies" ? Promise.resolve(null) : searchContacts(term, size, offset),
      ]);
      loaded = { totals, companies, contacts };
    } else if (termTooShort) {
      loaded = { totals, companies: null, contacts: null };
    } else {
      loaded = { totals, companies: await listCompanies(size, offset), contacts: null };
    }
  } catch (error) {
    // Kept inside a 200 response on purpose — see the note at the top of the file.
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <h1>Find an exhibitor or a contact</h1>
      <p className="lede">
        One box, both. Search matches exhibitor names and contact names at the same time, so
        you can start from whatever you happen to remember.
      </p>

      <form className="searchbar" action="/" method="get" role="search">
        <input
          type="search"
          name="q"
          defaultValue={term}
          placeholder="Exhibitor or contact name, at least three characters"
          aria-label="Search exhibitors and contacts"
        />
        {only !== null ? <input type="hidden" name="only" value={only} /> : null}
        <button type="submit">Search</button>
        {term.length > 0 ? (
          <Link className="button secondary" href="/">
            Clear
          </Link>
        ) : null}
      </form>

      {termTooShort ? (
        <p className="notice notice--warn">
          Type at least {MIN_SEARCH_LENGTH} characters. A shorter fragment cannot be answered
          from the trigram indexes and would have to read every company and contact row — too
          slow to be worth running at this archive&apos;s intended size.
        </p>
      ) : null}

      {failure !== null ? (
        <p className="notice notice--alarm">
          <strong>The archive could not be read.</strong> {failure}
          <br />
          If the stack has just started, the import may still be running — reload in a moment.
        </p>
      ) : null}

      {loaded !== null && !loaded.totals.has_data && failure === null ? (
        <p className="notice notice--warn">
          <strong>No data yet.</strong> The schema is in place but the archive has not been
          imported. Run <span className="code">./dev.sh</span> and wait for the import to
          finish, then reload.
        </p>
      ) : null}

      {loaded !== null && loaded.totals.has_data ? (
        <p
          className="small muted"
          title="Table sizes are planner estimates: an exact count of every table would mean a sequential scan on every page load. The follow-up figure is exact."
        >
          {approx(loaded.totals.companies, "exhibitors")} ·{" "}
          {approx(loaded.totals.contacts, "contacts")} ·{" "}
          {approx(loaded.totals.opportunities, "enquiries")} ·{" "}
          <Link href="/follow-ups">
            {loaded.totals.open_follow_ups.toLocaleString("en-GB")} pending follow-ups
          </Link>
        </p>
      ) : null}

      {loaded !== null && only !== null ? (
        <div className="filters">
          <Link href={`/?q=${encodeURIComponent(term)}`}>← Back to both result lists</Link>
        </div>
      ) : null}

      {loaded?.companies ? (
        <section>
          <div className="group-heading">
            <h2 style={{ margin: 0 }}>
              {searching ? "Exhibitors matching " : "All exhibitors"}
              {searching ? <em>“{term}”</em> : null}
            </h2>
            {searching && only === null && loaded.companies.hasMore ? (
              <Link
                className="small"
                href={`/?q=${encodeURIComponent(term)}&only=companies`}
              >
                see all matching exhibitors →
              </Link>
            ) : null}
          </div>
          {loaded.companies.rows.length === 0 ? (
            <p className="empty">No exhibitor name contains that fragment.</p>
          ) : (
            <>
              <CompanyTable rows={loaded.companies.rows} />
              {only !== null || !searching ? (
                <Pagination
                  basePath="/"
                  params={{ q: term, only: only ?? undefined }}
                  page={page}
                  hasMore={loaded.companies.hasMore}
                  shown={loaded.companies.rows.length}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {loaded?.contacts ? (
        <section>
          <div className="group-heading">
            <h2 style={{ margin: 0 }}>
              Contacts matching <em>“{term}”</em>
            </h2>
            {only === null && loaded.contacts.hasMore ? (
              <Link className="small" href={`/?q=${encodeURIComponent(term)}&only=contacts`}>
                see all matching contacts →
              </Link>
            ) : null}
          </div>
          {loaded.contacts.rows.length === 0 ? (
            <p className="empty">No contact name contains that fragment.</p>
          ) : (
            <>
              <ContactTable rows={loaded.contacts.rows} />
              {only !== null ? (
                <Pagination
                  basePath="/"
                  params={{ q: term, only }}
                  page={page}
                  hasMore={loaded.contacts.hasMore}
                  shown={loaded.contacts.rows.length}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {!searching && !termTooShort && failure === null ? (
        <p className="small muted" style={{ marginTop: "1.5rem" }}>
          A contact is entered once and reused across every fair and edition — searching by a
          person&apos;s name finds the exhibitor they belong to, not a copy of them per enquiry.
        </p>
      ) : null}
    </main>
  );
}
