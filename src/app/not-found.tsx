import Link from "next/link";

/**
 * Reached when a company_code or opportunity_code in the URL does not exist. It says which
 * kind of identifier the app uses, because guessing at a company NAME in the URL will never
 * work here: names are not unique and are not identity.
 */
export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p className="lede">
        No record with that code. Exhibitors are addressed by their company code (for example{" "}
        <span className="code">CO000001</span>) and enquiries by their opportunity code (for
        example <span className="code">OP000001</span>) — never by name, because exhibitor
        names in this archive are not unique.
      </p>
      <p>
        <Link className="button secondary" href="/">
          Back to search
        </Link>
      </p>
    </main>
  );
}
