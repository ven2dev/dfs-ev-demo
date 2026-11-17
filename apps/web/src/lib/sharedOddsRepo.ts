import "server-only";
import { randomUUID } from "node:crypto";
import { getSharedOddsBatch } from "@dfs-ev/db/runtime";
import { getSql } from "./db";
import { fetchEventOdds, type EventOddsResponse, type OddsApiQuota, type PlayerPropMarketOddsFetch } from "./oddsApi";
import { canonicalOddsMarkets, mergeOddsSlices, projectPlayerPropLines, sliceOddsByMarket, type CachedMarketPayload } from "./oddsProjection";
import { requireOddsEventId, requireOddsSport } from "./oddsRequestInputs";
import { getPlayerPropMarket } from "./playerPropMarkets";
import { persistRawOddsObservation } from "./oddsObservation";
import type { GetOrFetchMarketOddsOptions, MarketOddsOrigin, MarketOddsResult } from "./oddsCacheRepo";

type EventContext = { startTime: string; homeTeam: string; awayTeam: string };

type SharedPayload = CachedMarketPayload & {
  event?: Omit<EventOddsResponse, "bookmakers">;
  observation?: { id: string; capturedAt: string; quota: OddsApiQuota; persisted: boolean };
};

const readSharedOdds = async (
  sportKey: string, eventId: string, marketKeys: string[], ttlMs: number,
  source: "discovery" | "live", signal?: AbortSignal, context?: EventContext
) => {
  requireOddsSport(sportKey);
  requireOddsEventId(eventId);
  const keys = canonicalOddsMarkets(marketKeys);
  if (keys.some(key => !getPlayerPropMarket(key))) throw new Error("Unknown player-prop market key");
  return getSharedOddsBatch<SharedPayload>(eventId, keys, {
    signal,
    query: (text, params) => getSql().query(text, params),
    makeOwnerId: randomUUID, monotonicNow: () => performance.now(),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    onCacheWriteError: error => console.error("[sharedOddsRepo] failed to publish odds:", error),
    fetch: async (owned, ownerSignal) => {
      const combinedSignal = signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal;
      combinedSignal.throwIfAborted();
      const raw = await fetchEventOdds(sportKey, eventId, owned, combinedSignal, source);
      const fetched = context ? { ...raw, data: {
        ...raw.data,
        commence_time: raw.data.commence_time ?? context.startTime,
        home_team: raw.data.home_team ?? context.homeTeam,
        away_team: raw.data.away_team ?? context.awayTeam,
      } } : raw;
      const id = randomUUID();
      const persisted = await persistRawOddsObservation(sportKey, eventId, owned, fetched, id, source);
      const event = {
        id: fetched.data.id, sport_key: fetched.data.sport_key,
        commence_time: fetched.data.commence_time,
        home_team: fetched.data.home_team, away_team: fetched.data.away_team,
      };
      return Object.fromEntries(owned.map(key => [key, {
        ...sliceOddsByMarket(fetched.data, key), event,
        observation: { id, capturedAt: fetched.capturedAt, quota: fetched.quota, persisted },
      }]));
    },
  }, { ttlMs });
};

const originFor = (resource: Awaited<ReturnType<typeof readSharedOdds>>[string]): MarketOddsOrigin => ({
  origin: resource.state === "upstream" ? "upstream" : "cache",
  status: resource.state === "pending" ? "unavailable" : resource.state,
  capturedAt: resource.payload?.observation?.capturedAt ?? resource.fetchedAt,
  observationId: resource.payload?.observation?.id ?? null,
  observationPersisted: resource.payload?.observation?.persisted ?? false,
  // Cache reads do not represent another billed provider request.
  quota: resource.state === "upstream" ? resource.payload?.observation?.quota ?? null : null,
});

export const getSharedMarketOdds = async (
  sportKey: string, eventId: string, keys: string[], options: GetOrFetchMarketOddsOptions = {}
): Promise<MarketOddsResult> => {
  const resources = await readSharedOdds(sportKey, eventId, keys, options.forceRefresh ? 20_000 : 300_000, "discovery");
  return {
    odds: mergeOddsSlices(eventId, Object.values(resources).flatMap(resource => resource.payload ? [resource.payload] : [])),
    origins: Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, originFor(resource)])),
  };
};

export const fetchSharedPlayerPropOdds = async (
  sportKey: string, eventId: string, key: string, player: string, signal?: AbortSignal, context?: EventContext
): Promise<PlayerPropMarketOddsFetch> => {
  const resources = await readSharedOdds(sportKey, eventId, [key], 90_000, "live", signal, context);
  const resource = resources[key];
  if (!resource?.payload) throw new Error("Shared odds observation unavailable during refresh cooldown");
  const origin = originFor(resource);
  const response = { ...resource.payload.event, ...mergeOddsSlices(eventId, [resource.payload]) };
  if (!origin.capturedAt) throw new Error("Shared odds observation has no capture time");
  return {
    capturedAt: origin.capturedAt,
    quota: origin.quota ?? { remaining: null, used: null, last: null },
    data: { response, oddsByBookmaker: projectPlayerPropLines(response, key, player) },
    sharedObservation: {
      origin: origin.origin, status: origin.status!, observationId: origin.observationId,
      persisted: origin.observationPersisted,
    },
  };
};
