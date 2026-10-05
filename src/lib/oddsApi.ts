import "server-only";
import { randomUUID } from "node:crypto";
import { getCurrentNflSlateWindow, isEventInNflSlateWindow } from "./nflWeek";
import {
  recordOddsApiRequest,
  type OddsApiRequestSource,
} from "./oddsApiTelemetryRepo";
import { requireLiveOddsDataSource } from "./oddsDataSource";
import { requireOddsEventId, requireOddsSport } from "./oddsRequestInputs";
import { getPlayerPropMarket } from "./playerPropMarkets";
// Enforced, not just documented: importing this from a "use client"
// component now fails the build, since it reads ODDS_API_KEY, which must
// never reach the browser bundle.

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
  if (!process.env.DATABASE_URL) return;
  try {
    await recordOddsApiRequest(telemetry);
  } catch (error) {
    console.error("[oddsApi] failed to persist request telemetry:", error);
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
  source: OddsApiRequestSource = "direct"
): Promise<OddsApiFetch<EventOddsResponse>> => {
  requireLiveOddsDataSource();
  if (marketKeys.length === 0) {
    throw new Error("fetchEventOdds requires at least one market key");
  }
  sportKey = requireOddsSport(sportKey);
  eventId = requireOddsEventId(eventId);
  marketKeys = marketKeys.map(requireOddsMarket);

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/events/${encodeURIComponent(eventId)}/odds/`);
  url.search = new URLSearchParams({ apiKey, regions: "us", markets: marketKeys.join(",") }).toString();
  const requestId = randomUUID();
  const requestedAt = new Date();
  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: "no-store", signal, redirect: "error" });
  } catch (error) {
    await safelyRecordRequest({
      id: requestId,
      requestKind: "event-odds",
      source,
      sportKey,
      eventId,
      requestedMarkets: marketKeys,
      requestedAt,
      responseReceivedAt: null,
      outcome: signal?.aborted ? "aborted" : "network-error",
      httpStatus: null,
      quota: emptyQuota(),
    });
    throw error;
  }
  const metadata = responseMetadata(res);
  await safelyRecordRequest({
    id: requestId,
    requestKind: "event-odds",
    source,
    sportKey,
    eventId,
    requestedMarkets: marketKeys,
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

  return { data: await res.json(), ...metadata };
};

export const fetchSlateEvents = async (
  sportKey: string,
  now: Date = new Date(),
  signal?: AbortSignal,
  source: OddsApiRequestSource = "slate"
): Promise<OddsApiFetch<SlateEvent[]>> => {
  requireLiveOddsDataSource();
  sportKey = requireOddsSport(sportKey);
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

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
    throw error;
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

  const data: RawSlateEvent[] = await res.json();
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
}>;

// Real-time, uncached, deliberately NOT reusing the discovery cache
// (see #27 step 7's decision) -- a live tracker showing a value frozen
// for several ticks between real refreshes would defeat its own
// purpose. Returns every bookmaker so one snapshot can support both
// the selected-book line anchor and same-line market consensus.
export const fetchPlayerPropMarketOdds = async (
  sportKey: string,
  eventId: string,
  marketKey: string,
  playerName: string,
  signal?: AbortSignal,
  source: OddsApiRequestSource = "direct"
): Promise<PlayerPropMarketOddsFetch> => {
  requireLiveOddsDataSource();
  sportKey = requireOddsSport(sportKey);
  eventId = requireOddsEventId(eventId);
  marketKey = requireOddsMarket(marketKey);
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/events/${encodeURIComponent(eventId)}/odds/`);
  url.search = new URLSearchParams({ apiKey, regions: "us", markets: marketKey }).toString();
  const requestId = randomUUID();
  const requestedAt = new Date();
  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: "no-store", signal, redirect: "error" });
  } catch (error) {
    await safelyRecordRequest({
      id: requestId,
      requestKind: "event-odds",
      source,
      sportKey,
      eventId,
      requestedMarkets: [marketKey],
      requestedAt,
      responseReceivedAt: null,
      outcome: signal?.aborted ? "aborted" : "network-error",
      httpStatus: null,
      quota: emptyQuota(),
    });
    throw error;
  }
  const metadata = responseMetadata(res);
  await safelyRecordRequest({
    id: requestId,
    requestKind: "event-odds",
    source,
    sportKey,
    eventId,
    requestedMarkets: [marketKey],
    requestedAt,
    responseReceivedAt: new Date(metadata.capturedAt),
    outcome: res.ok ? "success" : "http-error",
    httpStatus: res.status,
    quota: metadata.quota,
  });
  if (!res.ok) {
    return { data: { response: null, oddsByBookmaker: [] }, ...metadata };
  }
  const data: EventOddsResponse = await res.json();

  const lines: PlayerPropBookmakerLine[] = [];
  for (const bookmaker of data.bookmakers) {
    const market = bookmaker.markets.find((candidate) => candidate.key === marketKey);
    if (!market) continue;
    const over = market.outcomes.find(
      (outcome) => outcome.name === "Over" && outcome.description === playerName
    );
    const under = market.outcomes.find(
      (outcome) => outcome.name === "Under" && outcome.description === playerName
    );
    if (
      over &&
      under &&
      over.point !== undefined &&
      under.point !== undefined &&
      over.point === under.point
    ) {
      lines.push({
        bookmakerKey: bookmaker.key,
        overPrice: over.price,
        underPrice: under.price,
        point: over.point,
      });
    }
  }
  return { data: { response: data, oddsByBookmaker: lines }, ...metadata };
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
