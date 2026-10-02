import "server-only";

import { randomUUID } from "node:crypto";
import { getSql } from "./db";
import {
  getOrRefreshLivePropInputs,
  type LivePropCacheEntry,
  type LivePropCacheKey,
  type LivePropInputs,
} from "./livePropCache";
import { fetchPlayerPropMarketOdds } from "./oddsApi";
import { persistOddsObservation } from "./oddsSnapshotRepo";
import { POLL_INTERVAL_MS } from "./streamConfig";
import { fetchGameWeather } from "./weather";

export type LivePropFetchContext = {
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  venueLat: number;
  venueLon: number;
};

type CacheRow = {
  payload: LivePropInputs | null;
  fetched_at: string | null;
};

const keyParams = (key: LivePropCacheKey) => [
  key.sportKey,
  key.eventId,
  key.marketKey,
  key.playerName,
];

const read = async (key: LivePropCacheKey): Promise<LivePropCacheEntry | null> => {
  const rows = (await getSql().query(
    `SELECT payload, fetched_at
     FROM live_prop_inputs_cache
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4`,
    keyParams(key)
  )) as CacheRow[];
  const row = rows[0];
  if (!row?.payload || !row.fetched_at) return null;
  return { payload: row.payload, fetchedAtMs: new Date(row.fetched_at).getTime() };
};

const tryAcquireRefresh = async (
  key: LivePropCacheKey,
  ownerId: string,
  freshAfterMs: number,
  leaseMs: number
): Promise<boolean> => {
  const rows = await getSql().query(
    `INSERT INTO live_prop_inputs_cache (
       sport_key, event_id, market_key, player_name, refresh_owner, refresh_lease_until
     )
     VALUES ($1, $2, $3, $4, $5, now() + ($7 * interval '1 millisecond'))
     ON CONFLICT (sport_key, event_id, market_key, player_name)
     DO UPDATE SET
       refresh_owner = EXCLUDED.refresh_owner,
       refresh_lease_until = EXCLUDED.refresh_lease_until
     WHERE (live_prop_inputs_cache.fetched_at IS NULL OR live_prop_inputs_cache.fetched_at <= $6)
       AND (
         live_prop_inputs_cache.refresh_lease_until IS NULL
         OR live_prop_inputs_cache.refresh_lease_until <= now()
       )
     RETURNING refresh_owner`,
    [
      ...keyParams(key),
      ownerId,
      new Date(freshAfterMs).toISOString(),
      leaseMs,
    ]
  );
  return rows.length > 0;
};

const renew = async (
  key: LivePropCacheKey,
  ownerId: string,
  leaseMs: number
): Promise<boolean> => {
  const rows = await getSql().query(
    `UPDATE live_prop_inputs_cache
     SET refresh_lease_until = now() + ($6 * interval '1 millisecond')
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
       AND refresh_owner = $5
     RETURNING refresh_owner`,
    [...keyParams(key), ownerId, leaseMs]
  );
  return rows.length > 0;
};

const write = async (
  key: LivePropCacheKey,
  ownerId: string,
  payload: LivePropInputs
): Promise<void> => {
  const rows = await getSql().query(
    `UPDATE live_prop_inputs_cache
     SET payload = $6, fetched_at = now(), refresh_owner = NULL, refresh_lease_until = NULL
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
       AND refresh_owner = $5
     RETURNING event_id`,
    [...keyParams(key), ownerId, JSON.stringify(payload)]
  );
  if (rows.length === 0) throw new Error("Live-prop refresh lease was lost before cache write");
};

const release = async (key: LivePropCacheKey, ownerId: string): Promise<void> => {
  await getSql().query(
    `UPDATE live_prop_inputs_cache
     SET refresh_owner = NULL, refresh_lease_until = NULL
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
       AND refresh_owner = $5`,
    [...keyParams(key), ownerId]
  );
};

export const getSharedLivePropInputs = async (
  key: LivePropCacheKey,
  context: LivePropFetchContext
): Promise<LivePropInputs> =>
  getOrRefreshLivePropInputs(
    key,
    {
      read,
      tryAcquireRefresh,
      renew,
      write,
      release,
      fetchFresh: async (_key, ownerSignal) => {
        const siblingController = new AbortController();
        const abortFromOwner = () => siblingController.abort(ownerSignal.reason);
        if (ownerSignal.aborted) {
          abortFromOwner();
        } else {
          ownerSignal.addEventListener("abort", abortFromOwner, { once: true });
        }

        try {
          const observationId = randomUUID();
          const oddsRequest = async () => {
            const fetched = await fetchPlayerPropMarketOdds(
              key.sportKey,
              key.eventId,
              key.marketKey,
              key.playerName,
              siblingController.signal
            );
            let observationPersisted = false;
            if (fetched.data.response) {
              const event = {
                ...fetched.data.response,
                sport_key: fetched.data.response.sport_key ?? key.sportKey,
                commence_time: fetched.data.response.commence_time ?? context.startTime,
                home_team: fetched.data.response.home_team ?? context.homeTeam,
                away_team: fetched.data.response.away_team ?? context.awayTeam,
              };
              try {
                await persistOddsObservation(
                  {
                    observationId,
                    sportKey: event.sport_key,
                    eventId: key.eventId,
                    homeTeam: event.home_team,
                    awayTeam: event.away_team,
                    eventStartTime: new Date(event.commence_time),
                    source: "live",
                    capturedAt: new Date(fetched.capturedAt),
                    requestedMarketKeys: [key.marketKey],
                    quota: fetched.quota,
                  },
                  event
                );
                observationPersisted = true;
              } catch (error) {
                console.error(
                  `[livePropCacheRepo] failed to persist observation "${observationId}":`,
                  error
                );
              }
            }
            return { ...fetched, observationPersisted };
          };

          const [odds, weather] = await Promise.all([
            oddsRequest(),
            fetchGameWeather(
              context.startTime,
              context.venueLat,
              context.venueLon,
              siblingController.signal
            ),
          ]);
          if (odds.data.oddsByBookmaker.length === 0 || !weather) {
            throw new Error("Failed to fetch real odds/weather");
          }
          return {
            oddsByBookmaker: odds.data.oddsByBookmaker,
            oddsObservation: {
              origin: "upstream",
              observationId,
              persisted: odds.observationPersisted,
              capturedAt: odds.capturedAt,
              quota: odds.quota,
            },
            weather,
          };
        } catch (error) {
          siblingController.abort(error);
          throw error;
        } finally {
          ownerSignal.removeEventListener("abort", abortFromOwner);
        }
      },
      makeOwnerId: randomUUID,
      now: Date.now,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onCacheWriteError: (error) =>
        console.error("[livePropCacheRepo] failed to persist refreshed inputs:", error),
    },
    { ttlMs: POLL_INTERVAL_MS }
  );
