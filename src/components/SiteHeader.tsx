import Link from "next/link";
import { ARCHIVE_REFERENCE_LABEL } from "@/app/_lib/format";

/**
 * Every screen is reachable from here, so a reviewer never has to type a URL. The reference
 * clock is in the header because every "overdue" on the follow-up screen is measured against
 * it rather than against the machine's wall clock.
 */
export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand">
          Exhibition Sales CRM
        </Link>
        <nav className="site-header__nav">
          <Link href="/">Search</Link>
          <Link href="/follow-ups">Follow-ups</Link>
        </nav>
        <span className="site-header__clock">Reference time: {ARCHIVE_REFERENCE_LABEL}</span>
      </div>
    </header>
  );
}
