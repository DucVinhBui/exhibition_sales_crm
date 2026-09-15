/**
 * The four source files, their staging tables and the exact header each must have.
 *
 * The column lists are the CSV headers verbatim — including `legacy_print_layout`, which
 * `data/README.md` calls obsolete presentation metadata and which the model therefore has
 * no column for. It is still staged: staging mirrors the file, and a column that is read
 * by nobody is cheaper than a header check that has to know about exceptions.
 */
import type { StagingTable } from "./staging";
import type { SourceFile } from "./manifest";

export const COMPANIES_AND_CONTACTS: StagingTable = {
  table: "stg_companies_and_contacts",
  columns: [
    "legacy_row_id",
    "company_code",
    "company_name",
    "province_code",
    "region",
    "sales_rep",
    "contact_code",
    "contact_first_name",
    "contact_last_name",
    "email",
    "phone",
    "fax",
    "legacy_print_layout",
  ],
};

export const FAIR_EDITIONS: StagingTable = {
  table: "stg_fair_editions",
  columns: [
    "fair_edition_code",
    "fair_name",
    "city",
    "venue",
    "starts_on",
    "ends_on",
    "max_stand_height_m",
  ],
};

export const OPPORTUNITIES: StagingTable = {
  table: "stg_opportunities",
  columns: [
    "opportunity_code",
    "company_code",
    "contact_code",
    "description",
    "amount_eur",
    "legacy_status",
    "opened_on",
    "expected_close_on",
    "historical_campaign_code",
    "fair_edition_code",
    "stand_area_sqm",
    "client_budget_eur",
    "requested_height_m",
    "brief_notes",
  ],
};

export const ACTIVITY_LOG: StagingTable = {
  table: "stg_activity_log",
  columns: [
    "entry_id",
    "company_code",
    "opportunity_code",
    "activity_type",
    "occurred_at",
    "details",
    "follow_up_on",
    "completion_marker",
    "legacy_author",
  ],
};

/** Load order is dependency order: companies -> contacts -> fairs -> editions -> opportunities -> activities. */
export const SOURCE_SPECS: ReadonlyArray<{ file: SourceFile; spec: StagingTable }> = [
  { file: "companies_and_contacts.csv", spec: COMPANIES_AND_CONTACTS },
  { file: "fair_editions.csv", spec: FAIR_EDITIONS },
  { file: "opportunities.csv", spec: OPPORTUNITIES },
  { file: "activity_log.csv", spec: ACTIVITY_LOG },
];
