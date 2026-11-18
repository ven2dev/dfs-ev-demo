import "server-only";
import { checkInteractiveQuotaFloor, type PaidOddsContext } from "./providerQuota";
import { projectPlayerPropLines } from "./oddsProjection";
import { randomUUID } from "node:crypto";
import { getCurrentNflSlateWindow, isEventInNflSlateWindow } from "@dfs-ev/domain/nfl-week";
import {
  recordOddsApiRequest,
  type OddsApiRequestSource,
} from "./oddsApiTelemetryRepo";
import { serverConfig, sanitizedFailure } from "./config.server";
import { requireOddsEventId, requireOddsSport } from "./oddsRequestInputs";
import { getPlayerPropMarket } from "./playerPropMarkets";
// Enforced, not just documented: importing this from a "use client"
// component fails the build. The server boundary supplies ODDS_API_KEY;
// its value stays outside the browser bundle.

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

export { DEFAULT_SPORT_KEY } from "./oddsRequestInputs";

const requireOddsMarket = (marketKey: string): string => {
  const market = getPlayerPropMarket(marketKey);
  if (!market) throw new Error("Unknown player-prop market key");
  return market.key;
};

export type OddsOutcome = {
  name: string;
  description?: string;
  price: number;
  point?: number;
};

export type OddsMarket = {
  key: string;
  last_update?: string;
  outcomes: OddsOutcome[];
};

export type OddsBookmaker = {
  key: string;
  title?: string;
  markets: OddsMarket[];
};

export type EventOddsResponse = {
  id: string;
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers: OddsBookmaker[];
};

export type OddsApiQuota = {
  remaining: number | null;
  used: number | null;
  last: number | null;
};

export type OddsApiFetch<T> = {
  data: T;
  capturedAt: string;
  quota: OddsApiQuota;
};

export class OddsApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly capturedAt: string,
    readonly quota: OddsApiQuota
  ) {
    super(message);
    this.name = "OddsApiHttpError";
  }
}

export type PlayerPropLine = {
  overPrice: number;
  underPrice: number;
  point: number;
};

export type PlayerPropBookmakerLine = PlayerPropLine & {
  bookmakerKey: string;
};

type RawSlateEvent = {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time: string;
};

const quotaHeader = (headers: Headers, name: string): number | null => {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

const responseMetadata = (response: Response) => ({
  capturedAt: new Date().toISOString(),
  quota: {
    remaining: quotaHeader(response.headers, "x-requests-remaining"),
    used: quotaHeader(response.headers, "x-requests-used"),
    last: quotaHeader(response.headers, "x-requests-last"),
  },
});

const emptyQuota = (): OddsApiQuota => ({ remaining: null, used: null, last: null });

const safelyRecordRequest = async (
  telemetry: Parameters<typeof recordOddsApiRequest>[0]
) => {
  // Odds calls historically remain usable without Postgres in local setup.
  // When a database is configured, telemetry failure is isolated from the
  // provider result so observability cannot turn current odds into an outage.
  try {
    if (!serverConfig.databaseConfigured()) return;
    await recordOddsApiRequest(telemetry);
  } catch (error) {
    console.error("[oddsApi] failed to persist request telemetry:", sanitizedFailure(error));
  }
};

// The bare game list for a sport -- no bookmakers/markets, so this costs
// ZERO credits on The Odds API's free tier (confirmed against their own
// docs: only /odds-suffixed endpoints are metered, at
// [markets] x [regions] credits each; plain /events is free). This is
// what makes "browse the whole slate for free, only pay credits once a
// user drills into a specific game" possible.
export type SlateEvent = {
  id: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
};

// Batches however many market keys the caller still needs into ONE
// request -- The Odds API bills [markets] x [regions] regardless of
// whether they're requested together or as separate calls, so batching
// costs nothing extra and saves round trips. Returns the raw
// multi-bookmaker response; slicing it down to one market's data (for
// the per-market cache) is oddsCacheRepo.ts's job, not this function's
// -- this stays a thin, cache-agnostic API wrapper like the rest of this
// file.
export const fetchEventOdds = async (
  sportKey: string,
  eventId: string,
  marketKeys: string[],
  signal?: AbortSignal,
  source: OddsApiRequestSource = "direct",
  ownership?: PaidOddsContext
): Promise<OddsApiFetch<EventOddsResponse>> => {
  serverConfig.liveOdds();
  if (marketKeys.length === 0) {
    throw new Error("fetchEventOdds requires at least one market key");
  }
  sportKey = requireOddsSport(sportKey);
  eventId = requireOddsEventId(eventId);
  marketKeys = [...new Set(marketKeys.map(requireOddsMarket))].sort();
  signal?.throwIfAborted();
  if (ownership?.kind === "collector") {
    const bound = [...new Set(ownership.marketKeys)].sort();
    if (!ownership.checkpointId || !ownership.ownerId || bound.join(",") !== marketKeys.join(",")) {
      throw new Error("Collector markets do not match the claimed checkpoint");
    }
  } else {
    await checkInteractiveQuotaFloor();
  }
  const assertSendLifetime = () => {
    signal?.throwIfAborted();
    if (ownership && (!Number.isFinite(ownership.deadline) || performance.now() >= ownership.deadline)) {
      throw new Error("Paid odds send deadline expired");
    }
  };
  assertSendLifetime();
  const { apiKey } = serverConfig.liveOdds();
  const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/events/${encodeURIComponent(eventId)}/odds/`);
  url.search = new URLSearchParams({ apiKey, regions: "us", markets: marketKeys.join(",") }).toString();
  const requestId = randomUUID();
  const requestedAt = new Date();
  let res: Response;
  try {
    assertSendLifetime();
    res = await fetch(url.toString(), { cache: "no-store", signal, redirect: "error" });
  } catch (error) {
    await safelyRecordRequest({
      id: requestId,
      requestKind: "event-odds",
      source,
      sportKey,
      eventId,
      requestedMarkets: [...marketKeys],
      requestedAt,
      responseReceivedAt: null,
      outcome: signal?.aborted ? "aborted" : "network-error",
      httpStatus: null,
      quota: emptyQuota(),
    });
    throw sanitizedFailure(error);
  }
  const metadata = responseMetadata(res);
  await safelyRecordRequest({
    id: requestId,
    requestKind: "event-odds",
    source,
    sportKey,
    eventId,
    requestedMarkets: [...marketKeys],
    requestedAt,
    responseReceivedAt: new Date(metadata.capturedAt),
    outcome: res.ok ? "success" : "http-error",
    httpStatus: res.status,
    quota: metadata.quota,
  });
  if (!res.ok) {
    throw new OddsApiHttpError(
      `Odds API event-odds fetch failed: ${res.status}`,
      res.status,
      metadata.capturedAt,
      metadata.quota
    );
  }

  try { return { data: await res.json(), ...metadata }; }
  catch (error) { throw sanitizedFailure(error); }
};

export const fetchSlateEvents = async (
  sportKey: string,
  now: Date = new Date(),
  signal?: AbortSignal,
  source: OddsApiRequestSource = "slate"
): Promise<OddsApiFetch<SlateEvent[]>> => {
  const { apiKey } = serverConfig.liveOdds();
  sportKey = requireOddsSport(sportKey);

  const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/events`);
  url.search = new URLSearchParams({ apiKey }).toString();
  const requestId = randomUUID();
  const requestedAt = new Date();
  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: "no-store", signal, redirect: "error" });
  } catch (error) {
    await safelyRecordRequest({
      id: requestId,
      requestKind: "events",
      source,
      sportKey,
      eventId: null,
      requestedMarkets: [],
      requestedAt,
      responseReceivedAt: null,
      outcome: signal?.aborted ? "aborted" : "network-error",
      httpStatus: null,
      quota: emptyQuota(),
    });
    throw sanitizedFailure(error);
  }
  const metadata = responseMetadata(res);
  await safelyRecordRequest({
    id: requestId,
    requestKind: "events",
    source,
    sportKey,
    eventId: null,
    requestedMarkets: [],
    requestedAt,
    responseReceivedAt: new Date(metadata.capturedAt),
    outcome: res.ok ? "success" : "http-error",
    httpStatus: res.status,
    quota: metadata.quota,
  });
  if (!res.ok) {
    throw new OddsApiHttpError(
      `Odds API events fetch failed: ${res.status}`,
      res.status,
      metadata.capturedAt,
      metadata.quota
    );
  }

  let data: RawSlateEvent[];
  try { data = await res.json(); }
  catch (error) { throw sanitizedFailure(error); }
  const window = getCurrentNflSlateWindow(now);
  const events = data
    .map((event) => ({
      id: event.id,
      sportKey: event.sport_key,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
    }))
    .filter((event) => isEventInNflSlateWindow(event.commenceTime, window));
  return { data: events, ...metadata };
};

export type PlayerPropMarketOddsFetch = OddsApiFetch<{
  response: EventOddsResponse | null;
  oddsByBookmaker: PlayerPropBookmakerLine[];
}> & {
  sharedObservation?: {
    origin: "cache" | "upstream";
    status: "fresh" | "upstream" | "stale" | "unavailable";
    observationId: string | null;
    persisted: boolean;
  };
};

// Live and discovery share the raw transport; preserve live's unavailable
// result on HTTP errors and project only after receiving the all-player data.
export const fetchPlayerPropMarketOdds = async (
  sportKey: string,
  eventId: string,
  marketKey: string,
  playerName: string,
  signal?: AbortSignal,
  source: OddsApiRequestSource = "direct"
): Promise<PlayerPropMarketOddsFetch> => {
  let fetched: OddsApiFetch<EventOddsResponse>;
  try {
    fetched = await fetchEventOdds(sportKey, eventId, [marketKey], signal, source);
  } catch (error) {
    if (!(error instanceof OddsApiHttpError)) throw error;
    return {
      data: { response: null, oddsByBookmaker: [] },
      capturedAt: error.capturedAt,
      quota: error.quota,
    };
  }
  return {
    ...fetched,
    data: {
      response: fetched.data,
      oddsByBookmaker: projectPlayerPropLines(fetched.data, marketKey, playerName),
    },
  };
};

export const fetchPlayerPropOdds = async (
  sportKey: string,
  eventId: string,
  marketKey: string,
  playerName: string,
  bookmakerKey: string
): Promise<PlayerPropLine | null> => {
  const result = await fetchPlayerPropMarketOdds(sportKey, eventId, marketKey, playerName);
  const line = result.data.oddsByBookmaker.find(
    (candidate) => candidate.bookmakerKey === bookmakerKey
  );
  return line
    ? { overPrice: line.overPrice, underPrice: line.underPrice, point: line.point }
    : null;
};
