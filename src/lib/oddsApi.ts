import "server-only";
// Enforced, not just documented: importing this from a "use client"
// component now fails the build, since it reads ODDS_API_KEY, which must
// never reach the browser bundle.

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// This app is NFL-only for now (see CLAUDE.md's Stack section) -- one
// shared constant instead of the literal repeated across callers, so
// adding a second sport later is a one-place change, not a find/replace.
export const DEFAULT_SPORT_KEY = "americanfootball_nfl";

export type OddsOutcome = {
  name: string;
  description?: string;
  price: number;
  point?: number;
};

export type OddsMarket = {
  key: string;
  outcomes: OddsOutcome[];
};

export type OddsBookmaker = {
  key: string;
  markets: OddsMarket[];
};

export type EventOddsResponse = {
  id: string;
  bookmakers: OddsBookmaker[];
};

export type PlayerPropLine = {
  overPrice: number;
  underPrice: number;
  point: number;
};

type RawSlateEvent = {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time: string;
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
  marketKeys: string[]
): Promise<EventOddsResponse> => {
  if (marketKeys.length === 0) {
    throw new Error("fetchEventOdds requires at least one market key");
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds/?apiKey=${apiKey}&regions=us&markets=${marketKeys.join(",")}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Odds API event-odds fetch failed: ${res.status}`);
  }

  return res.json();
};

export const fetchSlateEvents = async (sportKey: string): Promise<SlateEvent[]> => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events?apiKey=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Odds API events fetch failed: ${res.status}`);
  }

  const data: RawSlateEvent[] = await res.json();
  return data.map((event) => ({
    id: event.id,
    sportKey: event.sport_key,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
  }));
};

export async function fetchPlayerPropOdds(
  sportKey: string,
  eventId: string,
  marketKey: string,
  playerName: string
): Promise<PlayerPropLine | null> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds/?apiKey=${apiKey}&regions=us&markets=${marketKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    return null;
  }
  const data: EventOddsResponse = await res.json();

  for (const bookmaker of data.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    if (!market) continue;
    const over = market.outcomes.find(
      (o) => o.name === "Over" && o.description === playerName
    );
    const under = market.outcomes.find(
      (o) => o.name === "Under" && o.description === playerName
    );
    if (over && under && over.point !== undefined) {
      return { overPrice: over.price, underPrice: under.price, point: over.point };
    }
  }
  return null;
}
