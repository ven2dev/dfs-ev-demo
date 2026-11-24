import "server-only";

import { getSql } from "./db";
import { serverConfig } from "./config.server";

export type OddsCacheMode = "legacy" | "shared";
export type OddsCacheStatus = OddsCacheMode | "not-initialized" | "unavailable";
type SchemaQuery = (text: string, params: unknown[]) => Promise<unknown>;

// Successful capability selection is latched. Only failed checks retry,
// so transient database errors do not permanently disable odds on an instance.
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

const RETRY_INTERVAL_MS = 5_000;

export const createOddsCacheStartup = (
  query?: SchemaQuery,
  monotonicNow: () => number = () => performance.now()
) => {
  let state: OddsCacheStatus = "not-initialized";
  let pending: Promise<OddsCacheMode> | undefined;
  let retryAfter = Number.NEGATIVE_INFINITY;
  let failure: unknown;
  const initialize = (): Promise<OddsCacheMode> => {
    if (pending) return pending; // Coalesce checks and retain verified modes.
    if (monotonicNow() < retryAfter) return Promise.reject(failure);
    const attempt = Promise.resolve().then(async (): Promise<OddsCacheMode> => {
      if (!query) { state = "legacy"; return state; } // Keep database-free local setup usable.
      const rows = await query(oddsCacheSchemaQuery, []);
      if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.ready !== "boolean") {
        throw new Error("Invalid odds-cache schema capability result");
      }
      state = rows[0].ready ? "shared" : "legacy";
      return state;
    });
    pending = attempt;
    void attempt.catch(error => {
      // Keep refusing during the cooldown; a failure is never a legacy result.
      state = "unavailable";
      failure = error;
      retryAfter = monotonicNow() + RETRY_INTERVAL_MS;
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
  return {
    initialize,
    status: (): OddsCacheStatus => state,
    async select<T>(legacy: T, shared: T): Promise<T> {
      return (await initialize()) === "shared" ? shared : legacy;
    },
  };
};

let startup: ReturnType<typeof createOddsCacheStartup> | undefined;
const getStartup = () => {
  const configured = serverConfig.databaseConfigured();
  startup ??= createOddsCacheStartup(
    configured ? (text, params) => getSql().query(text, params) : undefined
  );
  return startup;
};

export const initializeOddsCache = (): Promise<OddsCacheMode> => getStartup().initialize();

export const selectOddsCachePath = <T>(legacy: T, shared: T): Promise<T> =>
  getStartup().select(legacy, shared);

// Read-only observation: does not construct startup, validate inputs or query.
export const oddsCacheStatus = (): OddsCacheStatus => startup?.status() ?? "not-initialized";
