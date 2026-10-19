import "server-only";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Same pattern as firebaseAdmin.ts: lazy init, cached, throws on a
// missing connection string rather than degrading silently -- a real
// server misconfiguration, not something callers should have to
// null-check for.
let cachedSql: NeonQueryFunction<false, false> | undefined;

export const getSql = (): NeonQueryFunction<false, false> => {
  if (cachedSql) return cachedSql;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set -- Postgres client cannot initialize");
  }

  cachedSql = neon(connectionString);
  return cachedSql;
};
