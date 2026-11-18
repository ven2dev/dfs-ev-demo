import { getOrRefresh, type LivePropCacheOptions } from "./livePropRefresh.ts";

export type SharedOddsResource<T> = {
  state: "fresh" | "upstream" | "stale" | "unavailable" | "pending";
  payload: T | null;
  fetchedAt: string | null;
};
export type SharedOddsBatch<T> = Record<string, SharedOddsResource<T>>;
export type SharedOddsQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export type SharedOddsDependencies<T> = {
  query: SharedOddsQuery;
  fetch: (keys: string[], signal: AbortSignal, claim: { ownerId: string; deadline: number }) => Promise<Record<string, T>>;
  makeOwnerId: () => string;
  monotonicNow: () => number;
  wait: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onCacheWriteError?: (error: unknown) => void;
};

// A completed read/locked claim can include stale/unavailable cooldown keys.
// Carry it out of the existing lifecycle without inventing a fresh timestamp.
class CompletedBatch<T> {
  readonly resources: SharedOddsBatch<T>;
  constructor(resources: SharedOddsBatch<T>) { this.resources = resources; }
}

export const getSharedOddsBatch = async <T>(
  eventId: string,
  requestedKeys: readonly string[],
  deps: SharedOddsDependencies<T>,
  options: LivePropCacheOptions
): Promise<SharedOddsBatch<T>> => {
  const keys = [...new Set(requestedKeys)].sort();
  if (!keys.length) return {};
  if (keys.length > 12 || keys.some(k => !k) || !eventId || options.ttlMs < 1) {
    throw new Error("Invalid bounded odds batch");
  }
  let owned: string[] = [];
  let resources: SharedOddsBatch<T> = {};
  let claimStarted = 0;
  let claimOwner = "";
  const leaseMs = options.leaseMs ?? 30_000;
  try {
    return await getOrRefresh<SharedOddsBatch<T>>(
      // Opaque lifecycle argument, never persisted as a market-set identity.
      { sportKey: "americanfootball_nfl", eventId, marketKey: keys.join(","), playerName: "" },
      {
        read: async () => {
          deps.signal?.throwIfAborted();
          const rows = await deps.query(
            `SELECT market_key, payload, fetched_at,
                    fetched_at > clock_timestamp() - $3 * interval '1 millisecond' AS fresh
             FROM public.event_market_odds_cache
             WHERE event_id = $1 AND market_key = ANY($2) ORDER BY market_key`,
            [eventId, keys, options.ttlMs]
          );
          if (rows.length === keys.length && rows.every(row => row.fresh === true)) {
            throw new CompletedBatch(Object.fromEntries(rows.map(row => [row.market_key, {
              state: "fresh", payload: row.payload as T,
              fetchedAt: new Date(row.fetched_at as string).toISOString(),
            }])));
          }
          return null;
        },
        tryAcquireRefresh: async (_key, owner) => {
          deps.signal?.throwIfAborted();
          claimStarted = deps.monotonicNow();
          claimOwner = owner;
          const [claim] = await deps.query(
            "SELECT * FROM public.claim_shared_odds_batch($1,$2,$3,$4,$5)",
            [eventId, keys, owner, options.ttlMs, leaseMs]
          );
          if (!claim) throw new Error("Missing odds batch claim result");
          resources = claim.resources as SharedOddsBatch<T>;
          if (claim.outcome === "complete") throw new CompletedBatch(resources);
          if (claim.outcome === "follower") return false;
          if (claim.outcome !== "leader" || !Array.isArray(claim.owned_keys) || !claim.owned_keys.length) {
            throw new Error("Invalid odds batch claim result");
          }
          owned = claim.owned_keys as string[];
          return true;
        },
        fetchFresh: async (_key, signal) => {
          deps.signal?.throwIfAborted();
          if (signal.aborted || deps.monotonicNow() - claimStarted >= leaseMs) {
            throw new Error("Odds batch lease expired before provider send");
          }
          const payloads = await deps.fetch(owned, signal, { ownerId: claimOwner, deadline: claimStarted + leaseMs });
          if (owned.some(key => !Object.hasOwn(payloads, key))) {
            throw new Error("Incomplete odds batch: missing markets need explicit empty slices");
          }
          // Returned data can remain usable if publication fails; future sends
          // still respect the durable database claim time.
          return { ...resources, ...Object.fromEntries(owned.map(key => [key, {
            state: "upstream" as const, payload: payloads[key], fetchedAt: null,
          }])) };
        },
        renew: async (_key, owner, duration) => {
          const [row] = await deps.query("SELECT public.renew_shared_odds_batch($1,$2,$3,$4) AS renewed",
            [eventId, owned, owner, duration]);
          return row?.renewed === true;
        },
        write: async (_key, owner, value) => {
          await deps.query("SELECT public.publish_shared_odds_batch($1,$2,$3,$4)",
            [eventId, owned, owner, JSON.stringify(Object.fromEntries(owned.map(key => [key, value[key].payload])))]);
        },
        release: async (_key, owner) => {
          await deps.query("SELECT public.release_shared_odds_batch($1,$2,$3)", [eventId, owned, owner]);
        },
        makeOwnerId: deps.makeOwnerId, now: deps.monotonicNow, wait: deps.wait,
        onCacheWriteError: deps.onCacheWriteError,
      }, options
    );
  } catch (error) {
    if (error instanceof CompletedBatch) return error.resources;
    throw error;
  }
};
