/**
 * Hand-built contexts for the unit tests.
 *
 * They mirror the archive rows the README walks through (OP000001, OP000003, OP000005) but
 * are constructed in code, so the pure tests pass on an empty database and never race the
 * importer. The database-backed test inserts its own rows and rolls them back.
 */
import type { HandoffContext } from "../types";

export const BEAUTY_2027 = {
  edition_code: "BEAUTY-2027",
  fair_name: "Beauty Trade Forum",
  city: "Bologna",
  venue: "East Exhibition Centre",
  starts_on: "2027-06-24",
  ends_on: "2027-06-27",
  max_stand_height_m: "4.50",
} as const;

export const PACK_2026 = {
  edition_code: "PACK-2026",
  fair_name: "Packaging Industry Week",
  city: "Milan",
  venue: "North Exhibition Centre",
  starts_on: "2026-10-20",
  ends_on: "2026-10-23",
  max_stand_height_m: "5.00",
} as const;

/** Same edition with no limit on file — used to prove that "no limit" is not "permitted". */
export const PACK_2026_NO_LIMIT = { ...PACK_2026, max_stand_height_m: null } as const;

function base(): HandoffContext {
  return {
    snapshot_version: "handoff-context-1",
    opportunity_id: "1",
    company: {
      company_code: "CO000001",
      name: "Aurora Cosmetics Srl",
      province_code: "MI",
      region: "Lombardia",
      sales_rep_name: "G. Ferri",
    },
    contact: {
      contact_code: "CO000001-P01",
      first_name: "Elena",
      last_name: "Rossi",
      email: "elena.rossi@example.com",
      phone: "+39 02 1234567",
    },
    opportunity: {
      opportunity_code: "OP000001",
      description: "Next edition: product launch stand",
      amount_eur: "48000.00",
      client_budget_eur: "50000.00",
      status: "OPEN",
      legacy_status_raw: "Open",
      opened_on: "2026-01-15",
      expected_close_on: "2026-11-30",
      stand_area_sqm: "80.00",
      requested_height_m: "4.00",
      brief_notes:
        "Reception, two open meeting tables, demo counter and locked store. Plot confirmed; artwork supplied.",
    },
    fair_edition: { ...BEAUTY_2027 },
    recent_activity: [
      {
        entry_id: "AC000010",
        type: "call",
        occurred_at: "2026-08-20T07:30:00.000Z",
        details: "Confirmed plot and artwork for the 2027 edition.",
        follow_up_on: null,
        is_completed: true,
        legacy_author: "gferri",
      },
    ],
    open_follow_ups: [],
  };
}

/** OP000001 — 80 m² at 4.0 m against a 4.5 m limit. Complete and compliant. */
export function completeContext(): HandoffContext {
  return base();
}

/** OP000003 — a fair and a budget, but no area and no height. The PROVISIONAL case. */
export function incompleteContext(): HandoffContext {
  const context = base();
  context.opportunity_id = "3";
  context.company = {
    company_code: "CO000002",
    name: "Borgo Packaging SpA",
    province_code: "BO",
    region: "Emilia-Romagna",
    sales_rep_name: "M. Conti",
  };
  context.contact = {
    contact_code: "CO000002-P01",
    first_name: "Marco",
    last_name: "Bianchi",
    email: "marco.bianchi@example.com",
    phone: "+39 051 998877",
  };
  context.opportunity = {
    opportunity_code: "OP000003",
    description: "Packaging launch stand",
    amount_eur: "31500.00",
    client_budget_eur: "30000.00",
    status: "OPEN",
    legacy_status_raw: " open ",
    opened_on: "2026-01-01",
    expected_close_on: "2026-10-15",
    stand_area_sqm: null,
    requested_height_m: null,
    brief_notes:
      "Sales wants a technical handoff today. Plot size is still with the organiser; client has not decided the height.",
  };
  context.fair_edition = { ...PACK_2026 };
  context.recent_activity = [
    {
      entry_id: "AC000031",
      type: "task",
      occurred_at: "2026-08-28T09:00:00.000Z",
      details: "Customer to confirm floor area on Friday.",
      follow_up_on: "2026-09-04",
      is_completed: false,
      legacy_author: "mconti",
    },
  ];
  context.open_follow_ups = [context.recent_activity[0]!];
  return context;
}

/** OP000005 — 6.0 m requested where the edition allows 5.0 m. The BLOCKED case. */
export function conflictingContext(): HandoffContext {
  const context = base();
  context.opportunity_id = "5";
  context.company = {
    company_code: "CO000004",
    name: "Mecfold Machinery Srl",
    province_code: "TO",
    region: "Piemonte",
    sales_rep_name: "L. Neri",
  };
  context.contact = {
    contact_code: "CO000004-P01",
    first_name: "Giulia",
    last_name: "Marino",
    email: "giulia.marino@example.com",
    phone: null,
  };
  context.opportunity = {
    opportunity_code: "OP000005",
    description: "Machinery display stand with high fascia",
    amount_eur: "76000.00",
    client_budget_eur: "80000.00",
    status: "OPEN",
    legacy_status_raw: " OPEN ",
    opened_on: "2026-06-01",
    expected_close_on: "2026-10-01",
    stand_area_sqm: "120.00",
    requested_height_m: "6.00",
    brief_notes:
      "Client asks for a 6 m fascia so the stand is visible across the hall. No exception to the edition limit is recorded.",
  };
  context.fair_edition = { ...PACK_2026 };
  context.recent_activity = [];
  context.open_follow_ups = [];
  return context;
}

/** Everything known except the edition's limit. The check cannot be performed at all. */
export function unknownLimitContext(): HandoffContext {
  const context = conflictingContext();
  context.fair_edition = { ...PACK_2026_NO_LIMIT };
  return context;
}

/** WON commercially, with no area on file. Commercial status is not technical approval. */
export function wonWithoutAreaContext(): HandoffContext {
  const context = completeContext();
  context.opportunity.opportunity_code = "OP000002";
  context.opportunity.status = "WON";
  context.opportunity.legacy_status_raw = "Won";
  context.opportunity.stand_area_sqm = null;
  return context;
}
