import "server-only";

import { getSql } from "./db";

export type OddsCacheMode = "legacy" | "shared";
type SchemaQuery = (text: string, params: unknown[]) => Promise<unknown>;

// One capability query per server instance; never put this on a request path.
export const oddsCacheSchemaQuery = `SELECT
  (SELECT count(*) = 3
   FROM pg_attribute a
   JOIN pg_class c ON c.oid = a.attrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'event_market_odds_cache'
     AND NOT a.attisdropped AND NOT a.attnotnull
     AND ((a.attname = 'refresh_owner' AND a.atttypid = 'text'::regtype)
       OR (a.attname IN ('refresh_lease_until', 'refresh_claimed_at')
           AND a.atttypid = 'timestamptz'::regtype)))
  AND to_regprocedure('public.claim_shared_odds_batch(text,text[],text,integer,integer)') IS NOT NULL
  AND to_regprocedure('public.renew_shared_odds_batch(text,text[],text,integer)') IS NOT NULL
  AND to_regprocedure('public.publish_shared_odds_batch(text,text[],text,jsonb)') IS NOT NULL
  AND to_regprocedure('public.release_shared_odds_batch(text,text[],text)') IS NOT NULL AS ready`;

export const createOddsCacheStartup = (query?: SchemaQuery) => {
  let pending: Promise<OddsCacheMode> | undefined;
  let mode: OddsCacheMode | undefined;
  const initialize = (): Promise<OddsCacheMode> => {
    pending ??= (async () => {
      if (!query) return (mode = "legacy"); // Keep database-free local setup usable.
      const rows = await query(oddsCacheSchemaQuery, []);
      if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.ready !== "boolean") {
        throw new Error("Invalid odds-cache schema capability result");
      }
      return (mode = rows[0].ready ? "shared" : "legacy");
    })();
    // Retain rejection: a metadata failure cannot silently enable legacy sends.
    return pending;
  };
  return {
    initialize,
    select<T>(legacy: T, shared: T): T {
      if (!mode) throw new Error("Odds-cache startup has not completed");
      return mode === "shared" ? shared : legacy;
    },
  };
};

let startup: ReturnType<typeof createOddsCacheStartup> | undefined;
export const initializeOddsCache = (): Promise<OddsCacheMode> => {
  startup ??= createOddsCacheStartup(
    process.env.DATABASE_URL ? (text, params) => getSql().query(text, params) : undefined
  );
  return startup.initialize();
};

export const selectOddsCachePath = <T>(legacy: T, shared: T): T => {
  if (!startup && !process.env.DATABASE_URL) return legacy;
  if (!startup) throw new Error("Odds-cache startup has not completed");
  return startup.select(legacy, shared);
};
