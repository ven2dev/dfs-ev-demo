import "server-only";

import { sliceOddsByMarket, mergeOddsSlices, type CachedMarketPayload } from "./oddsProjection";

import { randomUUID } from "node:crypto";
import { getSql } from "./db";
import {
  fetchEventOdds,
  type EventOddsResponse,
  type OddsApiFetch,
  type OddsApiQuota,
} from "./oddsApi";
import { persistRawOddsObservation } from "./oddsObservation";
import { getSharedMarketOdds } from "./sharedOddsRepo";
import { selectOddsCachePath } from "./oddsCacheStartup";

// Discovery costs real credits (1 per market requested), so re-fetching
// a market that was checked moments ago -- even by a different request
// for a different player -- would be pure waste. 5 minutes matches the
// "prices genuinely move, but not so fast that a 5-minute-old number is
// useless" call from the #27 roadmap discussion.
const CACHE_TTL_MS = 5 * 60 * 1000;

// forceRefresh (a manual "refresh odds" UI action) is allowed to ignore
// CACHE_TTL_MS, but NOT to bypass freshness checking entirely -- without
// a floor under it, one impatient click-spammer (or a scripted retry
// loop) could re-fetch the same market on every request with zero
// server-side limit, burning the whole monthly credit budget in
// seconds. This cooldown is a hard floor even forceRefresh can't cross:
// a market fetched more recently than this is served from cache
// regardless of the flag. Deliberately per-(event, market), not a
// global/per-user limiter -- refreshing one player's line must never
// block access to a DIFFERENT player's or market's data.
const FORCE_REFRESH_COOLDOWN_MS = 20 * 1000;

// Concurrent requests for the exact same (event, market-set) combo,
// landing on the same warm serverless instance before either has
// written to the Postgres cache yet, would otherwise each independently
// decide "missing" and each fire their own real, credit-costing API
// call. Deduping in-process (rather than a DB-level lock) is a
// deliberate, bounded choice for DISCOVERY: the neon serverless driver is stateless
// (one query = one HTTP request, no persistent session), so a lock
// can't be held across the external fetch() call the way
// creatorSubmissionsRepo.ts's transaction-scoped advisory lock holds
// across pure-SQL statements. This only dedupes requests hitting the
// SAME instance. Unlike the live stream's database-backed refresh lease,
// this discovery cache does not make a cross-instance guarantee; it
// covers the realistic burst case at this app's current internal scale.
type FreshEventOdds = OddsApiFetch<EventOddsResponse> & {
  observationId: string;
  observationPersisted: boolean;
};

const inFlightFetches = new Map<string, Promise<FreshEventOdds>>();

const dedupedFetchEventOdds = (
  sportKey: string,
  eventId: string,
  marketKeys: string[]
): Promise<FreshEventOdds> => {
  const dedupeKey = `${sportKey}::${eventId}::${[...marketKeys].sort().join(",")}`;
  const inFlight = inFlightFetches.get(dedupeKey);
  if (inFlight) return inFlight;

  const observationId = randomUUID();
  const fetchPromise = fetchEventOdds(sportKey, eventId, marketKeys, undefined, "discovery")
    .then(async (fetched) => {
      const observationPersisted = await persistRawOddsObservation(
        sportKey,
        eventId,
        marketKeys,
        fetched,
        observationId
      );
      return { ...fetched, observationId, observationPersisted };
    })
    .finally(() => {
      inFlightFetches.delete(dedupeKey);
    });
  inFlightFetches.set(dedupeKey, fetchPromise);
  return fetchPromise;
};

type CacheRow = {
  market_key: string;
  payload: CachedMarketPayload;
  fetched_at: string;
};

export type MarketOddsOrigin = {
  origin: "cache" | "upstream";
  capturedAt: string | null;
  observationId: string | null;
  observationPersisted: boolean;
  quota: OddsApiQuota | null;
  status?: "fresh" | "upstream" | "stale" | "unavailable";
};

export type MarketOddsResult = {
  odds: EventOddsResponse;
  origins: Record<string, MarketOddsOrigin>;
};

export type GetOrFetchMarketOddsOptions = {
  // Shortens the freshness window from CACHE_TTL_MS down to
  // FORCE_REFRESH_COOLDOWN_MS -- NOT an unconditional bypass. Wired to a
  // manual "refresh odds" UI control; still refuses to re-hit the API
  // for a market refreshed within the cooldown, no matter how many times
  // this is set.
  forceRefresh?: boolean;
};

export const getLegacyMarketOdds = async (
  sportKey: string,
  eventId: string,
  marketKeys: string[],
  options: GetOrFetchMarketOddsOptions = {}
): Promise<MarketOddsResult> => {
  const uniqueMarketKeys = Array.from(new Set(marketKeys));
  if (uniqueMarketKeys.length === 0) {
    return { odds: { id: eventId, bookmakers: [] }, origins: {} };
  }

  const sql = getSql();

  // Always read the cache, even under forceRefresh -- forceRefresh needs
  // fetched_at itself to enforce the cooldown floor above, so there's
  // nothing left to skip by not querying.
  const cachedRows = (await sql.query(
    `SELECT market_key, payload, fetched_at
     FROM event_market_odds_cache
     WHERE event_id = $1 AND market_key = ANY($2)`,
    [eventId, uniqueMarketKeys]
  )) as CacheRow[];

  // forceRefresh shortens the freshness window, it doesn't remove it --
  // this is what turns "always refetch" into "refetch at most once per
  // cooldown," while still letting a genuinely stale-relative-to-normal-
  // TTL row (older than the cooldown) get force-refreshed on demand.
  const freshnessThresholdMs = options.forceRefresh ? FORCE_REFRESH_COOLDOWN_MS : CACHE_TTL_MS;

  const freshRowsByMarket = new Map<string, CachedMarketPayload>();
  const origins: Record<string, MarketOddsOrigin> = {};
  for (const row of cachedRows) {
    const ageMs = Date.now() - new Date(row.fetched_at).getTime();
    if (ageMs < freshnessThresholdMs) {
      freshRowsByMarket.set(row.market_key, row.payload);
      origins[row.market_key] = {
        origin: "cache",
        capturedAt: new Date(row.fetched_at).toISOString(),
        observationId: null,
        observationPersisted: false,
        quota: null,
      };
    }
  }

  const missingMarketKeys = uniqueMarketKeys.filter((key) => !freshRowsByMarket.has(key));

  const freshlyFetchedSlices = new Map<string, CachedMarketPayload>();
  if (missingMarketKeys.length > 0) {
    const fetched = await dedupedFetchEventOdds(sportKey, eventId, missingMarketKeys);

    for (const marketKey of missingMarketKeys) {
      freshlyFetchedSlices.set(marketKey, sliceOddsByMarket(fetched.data, marketKey));
      origins[marketKey] = {
        origin: "upstream",
        capturedAt: fetched.capturedAt,
        observationId: fetched.observationId,
        observationPersisted: fetched.observationPersisted,
        quota: fetched.quota,
      };
    }

    // Cache writes are independent per market -- one failing must not
    // block the others from being persisted, and none of them block
    // returning the already-fetched data to the caller either way.
    const cacheWrites = Array.from(freshlyFetchedSlices.entries());
    const writeResults = await Promise.allSettled(
      cacheWrites.map(([marketKey, slice]) =>
        sql.query(
          `INSERT INTO event_market_odds_cache (event_id, market_key, payload, fetched_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (event_id, market_key)
           DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
          [eventId, marketKey, JSON.stringify(slice), fetched.capturedAt]
        )
      )
    );

    writeResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `[oddsCacheRepo] failed to cache event "${eventId}" market "${cacheWrites[index][0]}":`,
          result.reason
        );
      }
    });
  }

  return {
    odds: mergeOddsSlices(eventId, [
      ...Array.from(freshRowsByMarket.values()),
      ...Array.from(freshlyFetchedSlices.values()),
    ]),
    origins,
  };
};

export const getOrFetchMarketOdds: typeof getLegacyMarketOdds = (...args) =>
  selectOddsCachePath(getLegacyMarketOdds, getSharedMarketOdds)(...args);
