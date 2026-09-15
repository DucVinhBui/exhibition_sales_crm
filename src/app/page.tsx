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
} from "./_lib/queries";
import { blockSpan, blockStart, sliceBlock, type Block } from "./_lib/paging";
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
  companies: Block<CompanyHit> | null;
  contacts: Block<ContactHit> | null;
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
  // Two layouts share this route. The SEARCH PREVIEW stacks a short companies table above a
  // short contacts table and offers "see all" links instead of a pager, so it is the one and
  // only case that cuts the page short and pins the offset to zero. Every other layout -- the
  // default "All exhibitors" browse, and either single-entity result list -- is a full paged
  // listing. Keying that off `only === null` alone silently caught the browse listing too: it
  // kept the preview's eight rows, and "Next" paged a URL parameter while the query went on
  // asking for OFFSET 0, so every page showed the same eight exhibitors.
  const isPreview = searching && only === null;
  const size = isPreview ? PREVIEW_SIZE : FULL_PAGE_SIZE;
  // A paged listing asks for a whole block of pages at once and slices the one it renders out
  // of it, which is what lets the pager print real page numbers without counting the match.
  // The preview has no pager, so it asks for its single short page and stays on it.
  const viewPage = isPreview ? 0 : page;
  const fetchSize = isPreview ? size : blockSpan(size);
  const fetchOffset = isPreview ? 0 : blockStart(page) * size;

  let loaded: Loaded | null = null;
  let failure: string | null = null;

  try {
    const totals = await getArchiveTotals();
    if (searching) {
      const [companies, contacts] = await Promise.all([
        only === "contacts" ? Promise.resolve(null) : searchCompanies(term, fetchSize, fetchOffset),
        only === "companies" ? Promise.resolve(null) : searchContacts(term, fetchSize, fetchOffset),
      ]);
      loaded = {
        totals,
        companies: companies && sliceBlock(companies, viewPage, size),
        contacts: contacts && sliceBlock(contacts, viewPage, size),
      };
    } else if (termTooShort) {
      loaded = { totals, companies: null, contacts: null };
    } else {
      const companies = await listCompanies(fetchSize, fetchOffset);
      loaded = { totals, companies: sliceBlock(companies, viewPage, size), contacts: null };
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
        <section id="exhibitors">
          <div className="group-heading">
            <h2 style={{ margin: 0 }}>
              {searching ? "Exhibitors matching " : "All exhibitors"}
              {searching ? <em>“{term}”</em> : null}
            </h2>
            {searching && only === null && loaded.companies.more ? (
              <Link
                className="small"
                href={`/?q=${encodeURIComponent(term)}&only=companies`}
              >
                see all matching exhibitors →
              </Link>
            ) : null}
          </div>
          {loaded.companies.rows.length === 0 ? (
            <p className="empty">
              {page > 0
                ? "That page is past the end of this listing."
                : "No exhibitor name contains that fragment."}
            </p>
          ) : (
            <CompanyTable rows={loaded.companies.rows} />
          )}
          {only !== null || !searching ? (
            <Pagination
              basePath="/"
              params={{ q: term, only: only ?? undefined }}
              anchor="exhibitors"
              page={page}
              start={loaded.companies.start}
              pages={loaded.companies.pages}
              more={loaded.companies.more}
              shown={loaded.companies.rows.length}
            />
          ) : null}
        </section>
      ) : null}

      {loaded?.contacts ? (
        <section id="contacts">
          <div className="group-heading">
            <h2 style={{ margin: 0 }}>
              Contacts matching <em>“{term}”</em>
            </h2>
            {only === null && loaded.contacts.more ? (
              <Link className="small" href={`/?q=${encodeURIComponent(term)}&only=contacts`}>
                see all matching contacts →
              </Link>
            ) : null}
          </div>
          {loaded.contacts.rows.length === 0 ? (
            <p className="empty">
              {page > 0
                ? "That page is past the end of this listing."
                : "No contact name contains that fragment."}
            </p>
          ) : (
            <ContactTable rows={loaded.contacts.rows} />
          )}
          {only !== null ? (
            <Pagination
              basePath="/"
              params={{ q: term, only }}
              anchor="contacts"
              page={page}
              start={loaded.contacts.start}
              pages={loaded.contacts.pages}
              more={loaded.contacts.more}
              shown={loaded.contacts.rows.length}
            />
          ) : null}
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
