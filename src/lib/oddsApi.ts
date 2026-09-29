import "server-only";
// Enforced, not just documented: importing this from a "use client"
// component now fails the build, since it reads ODDS_API_KEY, which must
// never reach the browser bundle.

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

type OddsOutcome = {
  name: string;
  description?: string;
  price: number;
  point?: number;
};

type OddsMarket = {
  key: string;
  outcomes: OddsOutcome[];
};

type OddsBookmaker = {
  key: string;
  markets: OddsMarket[];
};

type EventOddsResponse = {
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
