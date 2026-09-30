// Pure math/reshaping, no I/O -- kept separate from oddsCacheRepo.ts on
// purpose. The cache repo stores exactly what the API said (so a future
// change to how props are grouped/displayed never needs a cache-schema
// migration); this file owns turning that raw bookmaker/market shape
// into the player-grouped view the discovery UI actually wants.
import type { EventOddsResponse } from "./oddsApi";

export type DiscoveredLine = {
  bookmakerKey: string;
  // Generalizes both real outcome shapes confirmed live: two-way
  // Over/Under yardage/count markets, and single-sided "Yes"
  // touchdown-scorer markets (no Under side, no point).
  side: "over" | "under" | "yes";
  price: number;
  point?: number;
};

export type DiscoveredMarket = {
  marketKey: string;
  lines: DiscoveredLine[];
};

export type DiscoveredPlayer = {
  playerName: string;
  markets: DiscoveredMarket[];
};

const sideFromOutcomeName = (name: string): DiscoveredLine["side"] => {
  if (name === "Over") return "over";
  if (name === "Under") return "under";
  return "yes";
};

// Groups a raw multi-bookmaker, multi-market response by PLAYER instead
// -- outcomes carry the player name in `description`, not as a
// top-level field, so there's no player list until this runs. Outcomes
// with no `description` are skipped rather than guessed at: every
// player-prop market this app requests always sets it (confirmed live),
// so a missing one would mean a non-player market slipped in, not a
// player worth showing blank.
export const groupOddsByPlayer = (response: EventOddsResponse): DiscoveredPlayer[] => {
  const marketsByPlayer = new Map<string, Map<string, DiscoveredLine[]>>();

  for (const bookmaker of response.bookmakers) {
    for (const market of bookmaker.markets) {
      for (const outcome of market.outcomes) {
        const playerName = outcome.description;
        if (!playerName) continue;

        const linesByMarket = marketsByPlayer.get(playerName) ?? new Map<string, DiscoveredLine[]>();
        const lines = linesByMarket.get(market.key) ?? [];
        lines.push({
          bookmakerKey: bookmaker.key,
          side: sideFromOutcomeName(outcome.name),
          price: outcome.price,
          point: outcome.point,
        });
        linesByMarket.set(market.key, lines);
        marketsByPlayer.set(playerName, linesByMarket);
      }
    }
  }

  return Array.from(marketsByPlayer.entries()).map(([playerName, linesByMarket]) => ({
    playerName,
    markets: Array.from(linesByMarket.entries()).map(([marketKey, lines]) => ({
      marketKey,
      lines,
    })),
  }));
};

export type BookmakerRow = {
  bookmakerKey: string;
  point?: number;
  overPrice?: number;
  underPrice?: number;
  yesPrice?: number;
};

// A market's lines come in as one flat list (one entry per bookmaker
// PER SIDE) -- this pairs a bookmaker's Over and Under back into a
// single row for display, so a table shows one row per book instead of
// two. A "Yes"-only market's lines already have one entry per
// bookmaker, so this is a no-op shape change for those, not a merge.
export const groupLinesByBookmaker = (lines: DiscoveredLine[]): BookmakerRow[] => {
  const rowsByBookmaker = new Map<string, BookmakerRow>();

  for (const line of lines) {
    const row = rowsByBookmaker.get(line.bookmakerKey) ?? { bookmakerKey: line.bookmakerKey };
    if (line.point !== undefined) row.point = line.point;
    if (line.side === "over") row.overPrice = line.price;
    else if (line.side === "under") row.underPrice = line.price;
    else row.yesPrice = line.price;
    rowsByBookmaker.set(line.bookmakerKey, row);
  }

  return Array.from(rowsByBookmaker.values());
};
