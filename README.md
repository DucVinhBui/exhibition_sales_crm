# Exhibition sales CRM

A CRM for an exhibition stand builder's sales team, over the supplied archive of 10,000
exhibitors, 20,000 contacts, 15,000 enquiries and 40,000 activity entries — plus a handoff
assistant that decides whether an enquiry is ready to go to the technical team.

```bash
./dev.sh          # migrate, import, serve on http://localhost:3000
./reset.sh        # drop the data and start over
./verify.sh       # check it responds
```

Nothing but Docker is needed on the host. The first start on a clean volume applies the
migrations, imports the whole archive (~4 s) and serves; later starts preserve your edits and
do not re-import.

## Stack

| | |
|---|---|
| Runtime | `node:22.22.0-bookworm-slim` |
| Database | `postgres:17.6-alpine3.22` |
| Framework | Next.js 15.5.25, React 19.3.0 (App Router, server components) |
| Language | TypeScript 5.9.3 |
| Driver | `pg` 8.23.0 — no ORM |
| Tests | `node:test` via `tsx` 4.23.13 |

Every version is pinned exactly, `package-lock.json` is committed, installs use `npm ci`, and
the image builds for both `linux/amd64` and `linux/arm64`.

**Time spent:** about 4 hours.

## The competing requests

Three people wanted different things, and the disagreement is the actual design problem.

- The **sales director** wants an enquiry passed over as soon as the customer names a fair and
  gives a budget. Waiting for the rest costs time.
- The **technical coordinator** wants nothing passed over until the stand area and requested
  height are known and checked against the fair's rules, because the team keeps starting work
  on requests it cannot deliver.
- The **sales coordinator** wants an enquiry's history to be that enquiry's history, not
  everything the company has ever said.

Both of the first two positions are right about something real: delay costs money, and so does
starting work that has to be thrown away. Treating this as a single yes/no would have meant
picking a winner. Instead the policy (`src/handoff/policy.ts`, version `handoff-policy-1.0.0`)
has **two gates and three outcomes**:

| Outcome | When | What it means |
|---|---|---|
| `PROVISIONAL` | Gate A — a fair and a budget are on file | Technical can start scoping. The brief lists exactly what is still outstanding. |
| `ACCEPTED` | Gate B — area and height are also known, and the height checks out | Ready for handover. Nothing outstanding. |
| `BLOCKED` | A conflict with the edition's rules | Not a missing-information problem. Someone has to talk to the customer. |

`PROVISIONAL` is the compromise: the sales director gets the early handover, and the technical
coordinator gets an explicit, itemised list of what is not yet known, rather than a brief that
looks complete and is not. A breach of the edition's height limit is **not** downgradable to
provisional — no exception to an edition limit is recorded anywhere in the archive, so there is
nothing to appeal to.

The sales coordinator's request is handled in the data model rather than the policy: activity
is attached to an opportunity, and the opportunity is scoped to one fair *edition*. The
timeline on an enquiry shows only that edition's conversations, and says so on the page.
The 5,001 company-level entries stay on the company, where they belong.

The account managers' request has a structural answer too. A contact hangs off the company and
is reused by every enquiry, so nobody re-keys a person per fair; and a returning exhibitor is a
**new enquiry against the same company row**, opened from the company page against whichever
edition they are coming back for. Nothing is copied forward and last year's record is not
edited, which is precisely how the coordinator's complaint is prevented rather than merely
discouraged.

### Rules the assistant will not break

- **An absent height is not an approval.** A missing value blocks or qualifies; it never helps.
- **An absent area is not zero square metres.** Unknown is unknown.
- **A missing edition limit is not permission.** It reads: *"The request cannot be checked —
  that is not permission to build it."*
- **Commercial status records no technical approval.** A `WON` enquiry with no area is still
  not technically ready.

## Trying the assistant

Start the app and open an opportunity; the assistant panel is at the bottom of the page. Three
archive enquiries give the three different outcomes:

| | Opportunity | Outcome |
|---|---|---|
| **Complete** | [`/opportunities/OP000001`](http://localhost:3000/opportunities/OP000001) | `ACCEPTED` — 80 m² at 4.00 m against BEAUTY-2027's 4.50 m limit, budget recorded, nothing outstanding |
| **Incomplete** | [`/opportunities/OP000003`](http://localhost:3000/opportunities/OP000003) | `PROVISIONAL` — €30,000 budget so scoping can start, but area *and* height are both unknown |
| **Conflicting** | [`/opportunities/OP000005`](http://localhost:3000/opportunities/OP000005) | `BLOCKED` — 6.00 m requested against PACK-2026's 5.00 m limit |

A fourth outcome exists that no archive row can reach. Open a new enquiry from any exhibitor
page, leave the opportunity value empty, and run the assistant: it returns `BLOCKED` on a
*precondition* rather than a conflict, because neither a budget nor a value is on file and Gate
A has nothing commercial to stand on. Every archive row carries an `amount_eur`, so that branch
of the policy was unreachable until enquiries could be created — see
`db/migrations/004_new_enquiries.sql`. Add a budget, run it again, and it becomes
`PROVISIONAL`.

To watch the decision change: on `OP000003`, edit the brief, fill in a stand area and a height,
and run the assistant again. It moves to `ACCEPTED`, and the earlier `PROVISIONAL` run is still
there and still readable, with the snapshot of what it saw at the time. Runs are append-only —
editing the brief never rewrites history. Put `6.00` in as the height instead and it goes to
`BLOCKED`, with the conflict named in the reason.

### The model is a stand-in

There is **no model call, no API key and no network access**. `src/handoff/model.ts` composes
its text from CRM facts by template, deterministically: the same input produces byte-identical
output. It is labelled as a stand-in in the UI, on every run.

The three roles — **preparer**, **checker**, **coordinator** — are genuinely separate modules
over one frozen context, so the structure is what a real model would slot into: replace the
stand-in, keep the policy. A test strips comments and strings from the engine and fails on
`Math.random`, `Date.now`, `new Date`, `fetch`, dynamic `import`, `node:fs`/`http`/`net`,
`process.env`, and `toLocaleString`/`Intl` (ICU differences across machines would break
byte-identity).

## Data model

Surrogate `BIGINT` keys, with every legacy code kept as a `UNIQUE` natural key beside it. The
import upserts on the legacy code, never on the surrogate id, which is what makes it idempotent.

`fair` is normalised out of `fair_edition` so that "the same exhibitor at another edition of the
same fair" is a join, not a string comparison on a repeated name. An `opportunity` belongs to
one edition, so last edition's agreement never carries over implicitly.

Money is `NUMERIC(12,2)`, area `NUMERIC(8,2)`, height `NUMERIC(4,2)` — never float, and read
back as strings, because a binary float cannot hold a decimal-comma euro amount exactly.

Every column the archive can leave empty is nullable, with **no defaults anywhere**. The schema
carries its reasoning in `COMMENT ON` — including on the columns where the obvious change would
be wrong.

Migration `004` relaxes two `NOT NULL`s that were true of the archive but not of the product.
`amount_eur` is what sales expects to invoice, and a brand-new enquiry genuinely has no figure
yet; requiring one would force an invented number in front of technical. `legacy_status_raw` is
the spelling the *old system* used, and a row created here was never in the old system, so
writing `OPEN` into it would claim a provenance it does not have. Both are now `NULL` on
CRM-created rows and unchanged on all 15,000 imported ones. The positive-value `CHECK` needs no
amendment: `NULL > 0` is `NULL`, a `CHECK` only rejects `FALSE`, so a missing amount passes and
a zero still fails loudly.

Moving an enquiry along the funnel writes twice in **one transaction**: the new
`opportunity.status`, and a `note` activity on the same enquiry saying who moved it, from what
to what and why. `status` holds only the current value, so an `UPDATE` on its own would destroy
the answer to "who marked this won, and when?" — and half of the pair is worse than neither.
The note is `is_completed = NULL`, not applicable: it is a fact about what happened, not a task,
so it never reaches the follow-up queue. No order is enforced between the five statuses,
because real enquiries skip stages and go backwards and the archive records every status with
no path between them.

New enquiry codes are allocated inside the `INSERT`, from the highest `OP`-number present.
A sequence would have been wrong: the archive brings its own codes and a sequence seeded at 1
would collide with every one of them on the first insert after a reset. Two concurrent
creations can still race, so the `UNIQUE` constraint is the arbiter and the loser retries.

## Import decisions

**Nothing is excluded.** All 10,000 / 20,000 / 15,000 / 40,000 / 16 rows import, and the
importer asserts its own counts against `data/manifest.json` and rolls back on a mismatch.

Ambiguities that needed a decision:

- **Empty means unknown, everywhere.** Never `0`, never `''`, never a default. 406 enquiries
  have no stand area, 349 no requested height, 365 no budget, 882 no contact. A `CHECK` on each
  measurement column requires `> 0` rather than `>= 0`, so an importer bug that collapsed an
  empty field to zero would fail loudly instead of producing silent "0 m²" stands.
- **`completion_marker` is tri-state.** `Y` → true, `N` → false, **empty → NULL**, meaning *not
  applicable* — typically a note, which is neither done nor pending. That is 23,973 / 8,079 /
  7,948 rows. Collapsing empty to false would have dropped 1,129 dated-but-irrelevant rows into
  the follow-up queue and corrupted it.
- **13 status spellings collapse to 5 states** by `trim` + `upper`. The untouched original is
  kept in `opportunity.legacy_status_raw`, so the normalisation stays auditable and reversible.
- **`requested_height_m` is never clamped.** `OP000005` asks for 6.00 m at an edition whose
  limit is 5.00 m. Both numbers are stored and the breach is computed at read time. It is the
  only breach in the archive.
- **Company names are not identity.** They are not unique in the archive and are never used as
  a join or dedupe key; `company_code` is. One duplicated name survives as two companies,
  correctly.
- **Timestamps are localised from Europe/Rome** with `(date + time) AT TIME ZONE 'Europe/Rome'`,
  so the container's timezone cannot affect the stored instant. **Six rows sit in a DST
  discontinuity:** `AC0021875`, `AC0024608` and `AC0028136` give a wall-clock time that never
  existed (spring forward — Postgres resolves them forward by an hour), and `AC0018293`,
  `AC0006284` and `AC0009385` fall in the ambiguous autumn fold (resolved to the
  post-transition reading). These are the only rows where the archive does not uniquely
  determine an instant.
- **`legacy_print_layout` is staged and dropped** as obsolete presentation metadata.
- **A checksum mismatch warns and proceeds.** The computed checksums, not the declared version,
  decide identity — so a regenerated archive that kept version `2.0.0` still re-imports.

**"Overdue" and "due this week" are measured against 1 September 2026, 09:00 Europe/Rome**, the
archive's `reference_time`, not the wall clock — otherwise the whole dataset would read as
years overdue. The date is shown in the site header. It is currently a constant in
`src/app/_lib/format.ts` rather than read from the manifest, because the app service does not
mount `data/`.

## Scale

The archive is expected to reach 100,000 contacts with proportional volumes. Search and the
follow-up queue are the paths that matter, and both are index-backed — verified with `EXPLAIN
ANALYZE` against the live archive:

| Path | Plan | Time |
|---|---|---|
| Company search | `Bitmap Index Scan on company_name_trgm_idx` | 0.07 ms |
| Contact search | `Bitmap Index Scan on contact_full_name_trgm_idx` | 6.2 ms |
| Follow-up queue | `Index Scan using activity_follow_up_queue_idx` | 0.02 ms |
| Queue counters | `Index Only Scan using activity_dated_completion_idx` | 0.38 ms |

The queue counters are an index-only scan. Straight after a cold import they still show a
handful of heap fetches, because the visibility map is not populated until autovacuum has run;
it settles to zero once it has.

The contact figure is a worst case: `de luca` matches 1,000 of the 20,000 contacts, and the
cost is in ranking those matches, not in finding them. Name search uses trigram GIN indexes, so
it is not anchored to the start of a name. Searches
under three characters are refused with an explanation rather than run, because a one- or
two-character pattern contains no whole trigram and cannot use the index.

Three query plans were rewritten after `EXPLAIN` showed sequential scans: contact search now
matches, ranks and `LIMIT`s in a subquery before joining, so the join is at most one page of
primary-key lookups however many rows the term matches; the front-page totals read
`pg_class.reltuples` instead of three `count(*)`s; and the queue counters got a partial index
(`003_followup_counts_index.sql`) after the audit found them scanning the whole table.

## Tests

```bash
npm test                        # 44 tests, no database needed
docker compose exec app npm test  # 54 tests, including the database-backed ones
```

Covering the policy's decision boundaries, determinism, exact decimal handling, append-only
persistence, and the three archive enquiries above.

## What is not done

- **The 100,000-contact claim is reasoned, not measured.** No data was generated at volume —
  an earlier attempt to do exactly that filled the host disk. The argument rests on the query
  plans above, all of which are bounded by matched rows and page size rather than table size.
  That is a sound argument, but it is an argument, not a benchmark.
- **No authentication.** The archive carries no user table and the brief describes an internal
  tool, so `sales_rep_name` and `legacy_author` are kept as text. There is no login, and every
  visitor can edit everything.
- **Company-level activity is read-only.** New entries can only be created from an enquiry,
  which guarantees they can never leak into the company-wide log. There is no UI for adding a
  company-level entry.
- **Exhibitors and contacts cannot be created in the CRM.** Enquiries can — the company page
  opens one against any edition, which is what a returning exhibitor actually is — but the
  company and contact rows themselves still come only from the archive. A genuinely new
  customer, or a new person at an existing one, cannot be entered. Both are the same shape of
  work as the enquiry form (a validated insert against an existing table, with empty fields
  stored as unknown) and neither needs a schema change; they were left out to keep the first
  version to the three operations the brief names. It is the gap I would close first.
- **Nothing can be deleted or archived.** There is no way to withdraw an enquiry opened by
  mistake, and no soft-delete column to carry the reason if there were.
- **Status history is prose, not structure.** The move is recorded as a timeline note, which a
  person can read but a query cannot group by. "How long does an enquiry sit in PROPOSAL?"
  needs a `status_change` table with typed from/to columns; the note carries the facts to
  reconstruct one, but nothing reads them back.
- **The assistant reads a fixed context.** It sees the opportunity, its company and contact,
  the fair edition and the enquiry's recent activity. It does not read the company's other
  enquiries or prior editions, which would be the obvious next step.
- **No pagination on the company detail page.** An exhibitor with hundreds of enquiries would
  render them all. The archive's maximum is small enough that it does not bite. The search,
  result and follow-up listings *are* paged, with numbered pages drawn from a bounded ten-page
  block fetch rather than a `COUNT(*)` over the match — see `src/app/_lib/paging.ts`.
