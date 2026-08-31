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
