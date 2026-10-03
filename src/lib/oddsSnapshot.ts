import { createHash } from "node:crypto";
import type { EventOddsResponse, OddsOutcome } from "./oddsApi";

export type SnapshotMarketStatus = "returned" | "empty" | "invalid" | "unavailable";

export type NormalizedOddsQuote = {
  bookmakerKey: string;
  rawPlayerName: string;
  playerId: string | null;
  direction: "over" | "under";
  point: number;
  decimalPrice: number;
};

export type BookmakerMarketObservation = {
  bookmakerKey: string;
  providerUpdatedAt: string | null;
};

export type NormalizedMarketSnapshot = {
  marketKey: string;
  status: SnapshotMarketStatus;
  contentHash: string | null;
  quotes: NormalizedOddsQuote[];
  bookmakerObservations: BookmakerMarketObservation[];
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareQuotes = (left: NormalizedOddsQuote, right: NormalizedOddsQuote) =>
  compareText(left.bookmakerKey, right.bookmakerKey) ||
  compareText(left.rawPlayerName, right.rawPlayerName) ||
  left.point - right.point ||
  compareText(left.direction, right.direction) ||
  left.decimalPrice - right.decimalPrice;

const validProviderTimestamp = (value: string | undefined): string | null =>
  value !== undefined && Number.isFinite(Date.parse(value)) ? value : null;

const validOutcome = (
  outcome: OddsOutcome
): outcome is OddsOutcome & { description: string; point: number } =>
  typeof outcome.description === "string" &&
  outcome.description.trim().length > 0 &&
  typeof outcome.point === "number" &&
  Number.isFinite(outcome.point) &&
  typeof outcome.price === "number" &&
  Number.isFinite(outcome.price) &&
  outcome.price > 1 &&
  (outcome.name === "Over" || outcome.name === "Under");

const outcomeIdentity = (outcome: OddsOutcome & { description: string; point: number }) =>
  JSON.stringify([
    outcome.name,
    outcome.description.trim(),
    outcome.point,
    outcome.price,
  ]);

const quoteContentHash = (marketKey: string, quotes: NormalizedOddsQuote[]) => {
  const hashableQuotes = quotes.map((quote) => ({
    bookmakerKey: quote.bookmakerKey,
    rawPlayerName: quote.rawPlayerName,
    direction: quote.direction,
    point: quote.point,
    decimalPrice: quote.decimalPrice,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ marketKey, quotes: hashableQuotes }))
    .digest("hex");
};

export const normalizeMarketSnapshot = (
  response: EventOddsResponse,
  marketKey: string
): NormalizedMarketSnapshot => {
  const outcomesByBookmaker = new Map<string, Map<string, OddsOutcome>>();
  const updateByBookmaker = new Map<string, string | null>();
  let returnedMarketCount = 0;
  let rawOutcomeCount = 0;

  for (const bookmaker of response.bookmakers) {
    if (!bookmaker.key) continue;

    for (const market of bookmaker.markets) {
      if (market.key !== marketKey) continue;
      returnedMarketCount += 1;
      rawOutcomeCount += market.outcomes.length;

      const outcomes = outcomesByBookmaker.get(bookmaker.key) ?? new Map();
      for (const outcome of market.outcomes) {
        if (!validOutcome(outcome)) continue;
        outcomes.set(outcomeIdentity(outcome), outcome);
      }
      outcomesByBookmaker.set(bookmaker.key, outcomes);

      const candidateUpdate = validProviderTimestamp(market.last_update);
      const currentUpdate = updateByBookmaker.get(bookmaker.key) ?? null;
      if (
        candidateUpdate &&
        (!currentUpdate || Date.parse(candidateUpdate) > Date.parse(currentUpdate))
      ) {
        updateByBookmaker.set(bookmaker.key, candidateUpdate);
      } else if (!updateByBookmaker.has(bookmaker.key)) {
        updateByBookmaker.set(bookmaker.key, currentUpdate);
      }
    }
  }

  const bookmakerObservations = Array.from(updateByBookmaker, ([bookmakerKey, providerUpdatedAt]) => ({
    bookmakerKey,
    providerUpdatedAt,
  })).sort((left, right) => compareText(left.bookmakerKey, right.bookmakerKey));

  if (returnedMarketCount === 0) {
    return {
      marketKey,
      status: "unavailable",
      contentHash: null,
      quotes: [],
      bookmakerObservations,
    };
  }

  if (rawOutcomeCount === 0) {
    return {
      marketKey,
      status: "empty",
      contentHash: null,
      quotes: [],
      bookmakerObservations,
    };
  }

  const quotes: NormalizedOddsQuote[] = [];
  for (const [bookmakerKey, uniqueOutcomes] of outcomesByBookmaker) {
    const pairs = new Map<
      string,
      { playerName: string; point: number; overs: OddsOutcome[]; unders: OddsOutcome[] }
    >();

    for (const outcome of uniqueOutcomes.values()) {
      if (!validOutcome(outcome)) continue;
      const playerName = outcome.description.trim();
      const pairKey = JSON.stringify([playerName, outcome.point]);
      const pair = pairs.get(pairKey) ?? {
        playerName,
        point: outcome.point,
        overs: [],
        unders: [],
      };
      if (outcome.name === "Over") pair.overs.push(outcome);
      if (outcome.name === "Under") pair.unders.push(outcome);
      pairs.set(pairKey, pair);
    }

    for (const pair of pairs.values()) {
      if (pair.overs.length !== 1 || pair.unders.length !== 1) continue;
      const over = pair.overs[0];
      const under = pair.unders[0];
      quotes.push(
        {
          bookmakerKey,
          rawPlayerName: pair.playerName,
          playerId: null,
          direction: "over",
          point: pair.point,
          decimalPrice: over.price,
        },
        {
          bookmakerKey,
          rawPlayerName: pair.playerName,
          playerId: null,
          direction: "under",
          point: pair.point,
          decimalPrice: under.price,
        }
      );
    }
  }

  quotes.sort(compareQuotes);
  if (quotes.length === 0) {
    return {
      marketKey,
      status: "invalid",
      contentHash: null,
      quotes,
      bookmakerObservations,
    };
  }

  return {
    marketKey,
    status: "returned",
    contentHash: quoteContentHash(marketKey, quotes),
    quotes,
    bookmakerObservations,
  };
};
