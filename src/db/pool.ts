import { Pool, types } from "pg";

// A calendar date has no timezone. node-pg's default DATE parser builds a JS Date at the
// server's LOCAL midnight, so a follow_up_on of Friday read in a westward timezone becomes
// Thursday -- silently moving every date in the follow-up queue by a day. Hand back the raw
// 'YYYY-MM-DD' string instead, which is what schema.ts types as IsoDate.
const PG_OID_DATE = 1082;
types.setTypeParser(PG_OID_DATE, (value: string) => value);

// NUMERIC (OID 1700) is already returned as a string by node-pg and must stay that way:
// parsing a euro amount into a binary float defeats the point of using NUMERIC at all.

declare global {
  // Next's dev server re-evaluates modules; without this the pool leaks connections.
  var __crmPool: Pool | undefined;
}

// Construction is LAZY and DATABASE_URL is read on first use, never at module scope.
//
// `next build` imports every route module to collect page data, in a process that has no
// DATABASE_URL and no database. Validating the environment at import time therefore failed
// the production build -- not because anything was misconfigured, but because merely loading
// the module demanded a live connection string. Deferring to first query keeps the check
// (a missing URL still throws, loudly, with the same message) while letting the build import
// the module freely.
function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Compose supplies it for every service.");
  }

  const created = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__crmPool = created;
  }

  return created;
}

export function getPool(): Pool {
  return (globalThis.__crmPool ??= createPool());
}

// Back-compatible named export. Every property access forwards to the real pool, which is
// built on first touch -- so `pool.query(...)` behaves exactly as before, but importing this
// module costs nothing and needs no environment.
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, property, receiver) {
    const real = getPool();
    const value = Reflect.get(real, property, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
  set(_target, property, value) {
    return Reflect.set(getPool(), property, value);
  },
  has(_target, property) {
    return Reflect.has(getPool(), property);
  },
});
