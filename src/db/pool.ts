import { Pool } from "pg";

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
