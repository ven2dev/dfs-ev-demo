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

// The default bookmaker shown for ONE prop row when no manual override
// is active. Two well-defined, mechanical notions of "best," each
// restricted to what's actually computable from cached data alone:
// - "yes"-only markets (anytime/1st/last TD): highest price, full stop
//   -- there's no line to shop, so it's a single dimension.
// - Two-way markets: restricted to whichever POINT value the most books
//   agree on (the modal line), then the lowest combined overround
//   (1/overPrice + 1/underPrice) among those -- the least-vig book at
//   the standard number, without arbitrarily preferring Over or Under.
// Deliberately does NOT compare across DIFFERENT points (e.g. 211.5 vs
// 215.5) -- deciding which point is "better" needs a real predictive
// probability model over the stat, which this app doesn't have (see
// #39's non-goals). Faking that comparison would invent precision the
// data doesn't support.
export const getBestBookmakerKey = (lines: DiscoveredLine[]): string | null => {
  const rows = groupLinesByBookmaker(lines);
  if (rows.length === 0) return null;

  if (lines[0]?.side === "yes") {
    let best = rows[0];
    for (const row of rows) {
      if ((row.yesPrice ?? -Infinity) > (best.yesPrice ?? -Infinity)) best = row;
    }
    return best.bookmakerKey;
  }

  const pointCounts = new Map<number, number>();
  for (const row of rows) {
    if (row.point === undefined) continue;
    pointCounts.set(row.point, (pointCounts.get(row.point) ?? 0) + 1);
  }

  let modalPoint: number | undefined;
  let modalCount = 0;
  for (const [point, count] of pointCounts) {
    if (count > modalCount) {
      modalCount = count;
      modalPoint = point;
    }
  }

  const candidates = rows.filter(
    (row): row is BookmakerRow & { point: number; overPrice: number; underPrice: number } =>
      row.point === modalPoint && row.overPrice !== undefined && row.underPrice !== undefined
  );
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestOverround = 1 / best.overPrice + 1 / best.underPrice;
  for (const row of candidates) {
    const overround = 1 / row.overPrice + 1 / row.underPrice;
    if (overround < bestOverround) {
      best = row;
      bestOverround = overround;
    }
  }
  return best.bookmakerKey;
};

// Every bookmaker key that appears anywhere across a discovered-props
// result, sorted for a stable, predictable cycle order -- drives the
// single-book stepper and the compare-mode picker, both of which need
// one shared list of "which books are actually available right now"
// rather than each player card discovering its own subset.
export const getAllBookmakerKeys = (players: DiscoveredPlayer[]): string[] => {
  const keys = new Set<string>();
  for (const player of players) {
    for (const market of player.markets) {
      for (const line of market.lines) {
        keys.add(line.bookmakerKey);
      }
    }
  }
  return Array.from(keys).sort();
};
