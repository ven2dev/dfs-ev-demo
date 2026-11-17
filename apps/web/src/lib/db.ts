import "server-only";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { serverConfig, sanitizedFailure } from "./config.server";

// Same pattern as firebaseAdmin.ts: lazy init, cached, throws on a
// missing connection string rather than degrading silently -- a real
// server misconfiguration, not something callers should have to
// null-check for.
let cachedSql: NeonQueryFunction<false, false> | undefined;

export const getSql = (): NeonQueryFunction<false, false> => {
  // Validate through the boundary even when the adapter already exists.
  const connectionString = serverConfig.database();
  if (cachedSql) return cachedSql;
  try { cachedSql = neon(connectionString); }
  catch (error) { throw sanitizedFailure(error); }
  return cachedSql;
};
