import { Pool, types } from "pg";

// A calendar date has no timezone. node-pg's default DATE parser builds a JS Date at the
// server's LOCAL midnight, so a follow_up_on of Friday read in a westward timezone becomes
// Thursday -- silently moving every date in the follow-up queue by a day. Hand back the raw
// 'YYYY-MM-DD' string instead, which is what schema.ts types as IsoDate.
const PG_OID_DATE = 1082;
types.setTypeParser(PG_OID_DATE, (value: string) => value);

// NUMERIC (OID 1700) is already returned as a string by node-pg and must stay that way:
// parsing a euro amount into a binary float defeats the point of using NUMERIC at all.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Compose supplies it for every service.");
}

declare global {
  // Next's dev server re-evaluates modules; without this the pool leaks connections.
  var __crmPool: Pool | undefined;
}

export const pool: Pool =
  globalThis.__crmPool ??
  new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__crmPool = pool;
}
