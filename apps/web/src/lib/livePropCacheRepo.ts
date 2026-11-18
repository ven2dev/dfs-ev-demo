import "server-only";
import { InteractiveQuotaUnavailable } from "./providerQuota";

import { createLivePropCacheStore, getOrRefresh, type LivePropCacheEntry, type LivePropCacheKey } from "@dfs-ev/db/runtime";
import { randomUUID } from "node:crypto";
import { getSql } from "./db";
import { selectOddsCachePath } from "./oddsCacheStartup";
import { fetchSharedPlayerPropOdds } from "./sharedOddsRepo";
import { fetchPlayerPropMarketOdds, type OddsApiQuota, type PlayerPropBookmakerLine, type PlayerPropMarketOddsFetch } from "./oddsApi";
import { persistOddsObservation } from "./oddsSnapshotRepo";
import { POLL_INTERVAL_MS } from "./streamConfig";
import { fetchGameWeather, type WeatherSnapshot } from "./weather";

export type LivePropInputs = {
  oddsByBookmaker: PlayerPropBookmakerLine[];
  oddsObservation?: {
    origin: "upstream" | "cache";
    status?: "fresh" | "upstream" | "stale" | "unavailable";
    observationId: string | null;
    persisted: boolean;
    capturedAt: string;
    quota: OddsApiQuota;
  };
  weather: WeatherSnapshot;
};

export type LivePropFetchContext = {
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  venueLat: number;
  venueLon: number;
};

// Keep Neon initialization lazy: importing the repository does not open a client.
const cacheStore = createLivePropCacheStore<LivePropInputs>((text, params) =>
  getSql().query(text, params)
);

type ViewOddsFetcher = (key: LivePropCacheKey, context: LivePropFetchContext, signal: AbortSignal) => Promise<PlayerPropMarketOddsFetch>;
const createLivePropInputs = (fetchOdds: ViewOddsFetcher) => async (
  key: LivePropCacheKey,
  context: LivePropFetchContext
): Promise<LivePropInputs> => {
  let prior: LivePropCacheEntry<LivePropInputs> | null = null;
  return getOrRefresh<LivePropInputs>(
    key,
    {
      ...cacheStore,
      read: async cacheKey => { prior = await cacheStore.read(cacheKey); return prior; },
      write: async (cacheKey, owner, payload) => {
        if (payload.oddsObservation?.status === "stale") {
          // Returning explicitly stale raw odds must not re-age the outer view.
          await cacheStore.release(cacheKey, owner);
          return;
        }
        if (payload.oddsObservation?.status) {
          // The outer view cannot restart the raw observation's TTL. Copy the
          // matching publication's DB timestamp in the same write statement.
          // A failed/obsolete raw publication gets epoch freshness instead.
          const rows = await getSql().query(
            `UPDATE live_prop_inputs_cache SET payload = $6,
               fetched_at = coalesce((
                 SELECT CASE WHEN r.payload->'observation'->>'id' IS NOT DISTINCT FROM $7::text
                   THEN r.fetched_at ELSE 'epoch'::timestamptz END
                 FROM public.event_market_odds_cache r WHERE r.event_id = $2 AND r.market_key = $3
               ), 'epoch'::timestamptz), refresh_owner = NULL, refresh_lease_until = NULL
             WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
               AND refresh_owner = $5 RETURNING event_id`,
            [cacheKey.sportKey, cacheKey.eventId, cacheKey.marketKey, cacheKey.playerName,
              owner, JSON.stringify(payload), payload.oddsObservation.observationId]
          );
          if (!rows.length) throw new Error("Live-prop refresh lease was lost before cache write");
          return;
        }
        await cacheStore.write(cacheKey, owner, payload);
      },
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
            const fetched = await fetchOdds(key, context, siblingController.signal);
            let observationPersisted = false;
            if (fetched.data.response && !fetched.sharedObservation) {
              const event = {
                ...fetched.data.response,
                sport_key: fetched.data.response.sport_key ?? key.sportKey,
                commence_time: fetched.data.response.commence_time ?? context.startTime,
                home_team: fetched.data.response.home_team ?? context.homeTeam,
                away_team: fetched.data.response.away_team ?? context.awayTeam,
              };
              const eventStartTime = new Date(event.commence_time);
              const capturedAt = new Date(fetched.capturedAt);
              const isPostKickoff =
                Number.isFinite(eventStartTime.getTime()) &&
                Number.isFinite(capturedAt.getTime()) &&
                capturedAt.getTime() >= eventStartTime.getTime();
              if (!isPostKickoff) {
                try {
                  await persistOddsObservation(
                    {
                      observationId,
                      sportKey: event.sport_key,
                      eventId: key.eventId,
                      homeTeam: event.home_team,
                      awayTeam: event.away_team,
                      eventStartTime,
                      source: "live",
                      capturedAt,
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
            }
            return { ...fetched, observationPersisted: fetched.sharedObservation?.persisted ?? observationPersisted };
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
              origin: odds.sharedObservation?.origin ?? "upstream",
              ...(odds.sharedObservation ? { status: odds.sharedObservation.status } : {}),
              observationId: odds.sharedObservation ? odds.sharedObservation.observationId : observationId,
              persisted: odds.observationPersisted,
              capturedAt: odds.capturedAt,
              quota: odds.quota,
            },
            weather,
          };
        } catch (error) {
          siblingController.abort(error);
          if (error instanceof InteractiveQuotaUnavailable && prior?.payload.oddsByBookmaker.length) {
            return { ...prior.payload, oddsObservation: {
              origin: "cache", status: "stale", observationId: prior.payload.oddsObservation?.observationId ?? null,
              persisted: prior.payload.oddsObservation?.persisted ?? false,
              capturedAt: prior.payload.oddsObservation?.capturedAt ?? new Date(prior.fetchedAtMs).toISOString(),
              quota: { remaining: null, used: null, last: null },
            } };
          }
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
};

const legacyLiveInputs = createLivePropInputs((key, _context, signal) =>
  fetchPlayerPropMarketOdds(key.sportKey, key.eventId, key.marketKey, key.playerName, signal, "live"));
const sharedLiveInputs = createLivePropInputs((key, context, signal) =>
  fetchSharedPlayerPropOdds(key.sportKey, key.eventId, key.marketKey, key.playerName, signal, context));
export const getSharedLivePropInputs: typeof legacyLiveInputs = async (...args) =>
  (await selectOddsCachePath(legacyLiveInputs, sharedLiveInputs))(...args);
