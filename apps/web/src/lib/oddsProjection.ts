import type { EventOddsResponse, OddsMarket, PlayerPropBookmakerLine } from "./oddsApi";

// Raw resource identity excludes player, bookmaker and direction filters.
export const canonicalOddsMarkets = (keys: readonly string[]): string[] =>
  [...new Set(keys)].sort();

export const projectPlayerPropLines = (
  data: EventOddsResponse,
  marketKey: string,
  playerName: string
): PlayerPropBookmakerLine[] => {
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
  return lines;
};

export type CachedMarketPayload = {
  bookmakers: { key: string; markets: OddsMarket[] }[];
};

// A missing market deliberately becomes an empty published slice, as on main.
export const sliceOddsByMarket = (response: EventOddsResponse, marketKey: string): CachedMarketPayload => ({
  bookmakers: response.bookmakers
    .map((bookmaker) => ({
      key: bookmaker.key,
      markets: bookmaker.markets.filter((market) => market.key === marketKey),
    }))
    .filter((bookmaker) => bookmaker.markets.length > 0),
});

export const mergeOddsSlices = (eventId: string, slices: CachedMarketPayload[]): EventOddsResponse => {
  const bookmakersByKey = new Map<string, Map<string, OddsMarket>>();
  for (const slice of slices) {
    for (const bookmaker of slice.bookmakers) {
      const marketsByKey = bookmakersByKey.get(bookmaker.key) ?? new Map<string, OddsMarket>();
      for (const market of bookmaker.markets) marketsByKey.set(market.key, market);
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
