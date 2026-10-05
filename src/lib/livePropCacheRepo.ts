import "server-only";

import { randomUUID } from "node:crypto";
import { getSql } from "./db";
import {
  getOrRefreshLivePropInputs,
  type LivePropCacheKey,
  type LivePropInputs,
} from "./livePropCache";
import { createLivePropCacheStore } from "./livePropCacheStore";
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

// Keep Neon initialization lazy: importing the repository does not open a client.
const cacheStore = createLivePropCacheStore((text, params) =>
  getSql().query(text, params)
);

export const getSharedLivePropInputs = async (
  key: LivePropCacheKey,
  context: LivePropFetchContext
): Promise<LivePropInputs> =>
  getOrRefreshLivePropInputs(
    key,
    {
      ...cacheStore,
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
              siblingController.signal,
              "live"
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
