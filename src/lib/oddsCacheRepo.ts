import "server-only";

import { getSql } from "./db";
import { fetchEventOdds, type EventOddsResponse, type OddsMarket } from "./oddsApi";

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
const inFlightFetches = new Map<string, Promise<EventOddsResponse>>();

const dedupedFetchEventOdds = (
  sportKey: string,
  eventId: string,
  marketKeys: string[]
): Promise<EventOddsResponse> => {
  const dedupeKey = `${eventId}::${[...marketKeys].sort().join(",")}`;
  const inFlight = inFlightFetches.get(dedupeKey);
  if (inFlight) return inFlight;

  const fetchPromise = fetchEventOdds(sportKey, eventId, marketKeys).finally(() => {
    inFlightFetches.delete(dedupeKey);
  });
  inFlightFetches.set(dedupeKey, fetchPromise);
  return fetchPromise;
};

type CachedMarketPayload = {
  bookmakers: { key: string; markets: OddsMarket[] }[];
};

type CacheRow = {
  market_key: string;
  payload: CachedMarketPayload;
  fetched_at: string;
};

// Slices a multi-market API response down to just one market's data --
// this is the shape actually written to (and read back from) the
// per-(event, market) cache row, so a request for a DIFFERENT subset of
// markets on the same event can reuse whichever of these it needs
// without re-fetching markets it already has fresh.
const sliceByMarket = (response: EventOddsResponse, marketKey: string): CachedMarketPayload => ({
  bookmakers: response.bookmakers
    .map((bookmaker) => ({
      key: bookmaker.key,
      markets: bookmaker.markets.filter((market) => market.key === marketKey),
    }))
    .filter((bookmaker) => bookmaker.markets.length > 0),
});

// Merges any number of per-market slices (some from the cache, some
// freshly fetched) back into one combined response -- bookmakers that
// offer more than one of the requested markets get their markets
// combined onto a single entry, rather than appearing once per market.
const mergeSlices = (eventId: string, slices: CachedMarketPayload[]): EventOddsResponse => {
  const bookmakersByKey = new Map<string, Map<string, OddsMarket>>();

  for (const slice of slices) {
    for (const bookmaker of slice.bookmakers) {
      const marketsByKey = bookmakersByKey.get(bookmaker.key) ?? new Map<string, OddsMarket>();
      for (const market of bookmaker.markets) {
        marketsByKey.set(market.key, market);
      }
      bookmakersByKey.set(bookmaker.key, marketsByKey);
    }
  }

  return {
    id: eventId,
    bookmakers: Array.from(bookmakersByKey.entries()).map(([key, marketsByKey]) => ({
      key,
      markets: Array.from(marketsByKey.values()),
    })),
  };
};

export type GetOrFetchMarketOddsOptions = {
  // Shortens the freshness window from CACHE_TTL_MS down to
  // FORCE_REFRESH_COOLDOWN_MS -- NOT an unconditional bypass. Wired to a
  // manual "refresh odds" UI control; still refuses to re-hit the API
  // for a market refreshed within the cooldown, no matter how many times
  // this is set.
  forceRefresh?: boolean;
};

export const getOrFetchMarketOdds = async (
  sportKey: string,
  eventId: string,
  marketKeys: string[],
  options: GetOrFetchMarketOddsOptions = {}
): Promise<EventOddsResponse> => {
  const uniqueMarketKeys = Array.from(new Set(marketKeys));
  if (uniqueMarketKeys.length === 0) {
    return { id: eventId, bookmakers: [] };
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
  for (const row of cachedRows) {
    const ageMs = Date.now() - new Date(row.fetched_at).getTime();
    if (ageMs < freshnessThresholdMs) {
      freshRowsByMarket.set(row.market_key, row.payload);
    }
  }

  const missingMarketKeys = uniqueMarketKeys.filter((key) => !freshRowsByMarket.has(key));

  const freshlyFetchedSlices = new Map<string, CachedMarketPayload>();
  if (missingMarketKeys.length > 0) {
    const response = await dedupedFetchEventOdds(sportKey, eventId, missingMarketKeys);

    for (const marketKey of missingMarketKeys) {
      freshlyFetchedSlices.set(marketKey, sliceByMarket(response, marketKey));
    }

    // Cache writes are independent per market -- one failing must not
    // block the others from being persisted, and none of them block
    // returning the already-fetched data to the caller either way.
    const cacheWrites = Array.from(freshlyFetchedSlices.entries());
    const writeResults = await Promise.allSettled(
      cacheWrites.map(([marketKey, slice]) =>
        sql.query(
          `INSERT INTO event_market_odds_cache (event_id, market_key, payload, fetched_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (event_id, market_key)
           DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
          [eventId, marketKey, JSON.stringify(slice)]
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

  return mergeSlices(eventId, [
    ...Array.from(freshRowsByMarket.values()),
    ...Array.from(freshlyFetchedSlices.values()),
  ]);
};
