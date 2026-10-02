import { consensusDevigAtLine, type ConsensusDevigResult } from "./consensusDevig";
import type { OddsObservationSource } from "./oddsSnapshotRepo";
import type { SnapshotMarketStatus } from "./oddsSnapshot";

export type HistoricalQuoteRow = {
  bookmakerKey: string;
  rawPlayerName: string;
  playerId: string | null;
  direction: "over" | "under";
  point: number | string;
  decimalPrice: number | string;
};

export type HistoricalMarketObservation = {
  observationId: string;
  eventId: string;
  marketKey: string;
  status: SnapshotMarketStatus;
  source: OddsObservationSource;
  capturedAt: string;
  eventStartTime: string;
  quotes: HistoricalQuoteRow[];
};

export type HistoricalPlayerIdentity =
  | { kind: "trusted-id"; value: string }
  | { kind: "provider-name"; value: string };

export type HistoricalObservationProvenance = {
  observationId: string;
  capturedAt: string;
  eventStartTime: string;
  source: OddsObservationSource;
  ageAtCutoffMs: number;
  pregameLeadMs: number;
  label: "closing-candidate" | "latest-pregame";
};

export type HistoricalConsensusResult =
  | {
      status: "available";
      observation: HistoricalObservationProvenance;
      consensus: ConsensusDevigResult;
    }
  | {
      status: "unavailable";
      reason:
        | "no-observation"
        | "market-unavailable"
        | "market-empty"
        | "market-invalid"
        | "player-not-found-in-observation"
        | "exact-line-not-found"
        | "no-valid-two-way-quotes";
      observation?: HistoricalObservationProvenance;
    };

const finiteNumber = (value: number | string): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const provenance = (
  observation: HistoricalMarketObservation,
  cutoff: Date
): HistoricalObservationProvenance => {
  const capturedAtMs = Date.parse(observation.capturedAt);
  const eventStartMs = Date.parse(observation.eventStartTime);
  const cutoffMs = cutoff.getTime();
  if (
    !Number.isFinite(capturedAtMs) ||
    !Number.isFinite(eventStartMs) ||
    capturedAtMs > cutoffMs ||
    capturedAtMs >= eventStartMs
  ) {
    throw new Error("Historical observation timestamps violate pregame cutoff semantics");
  }
  const pregameLeadMs = eventStartMs - capturedAtMs;
  return {
    observationId: observation.observationId,
    capturedAt: new Date(capturedAtMs).toISOString(),
    eventStartTime: new Date(eventStartMs).toISOString(),
    source: observation.source,
    ageAtCutoffMs: cutoffMs - capturedAtMs,
    pregameLeadMs,
    label: pregameLeadMs <= 30 * 60 * 1000 ? "closing-candidate" : "latest-pregame",
  };
};

export const consensusFromHistoricalObservation = (input: {
  observation: HistoricalMarketObservation | null;
  cutoff: Date;
  player: HistoricalPlayerIdentity;
  line: number;
}): HistoricalConsensusResult => {
  if (!Number.isFinite(input.cutoff.getTime())) throw new Error("cutoff must be a valid date");
  if (!Number.isFinite(input.line)) throw new Error("line must be finite");
  if (input.player.value.trim().length === 0) throw new Error("player identity must not be empty");
  if (!input.observation) return { status: "unavailable", reason: "no-observation" };

  const observationProvenance = provenance(input.observation, input.cutoff);
  if (input.observation.status !== "returned") {
    return {
      status: "unavailable",
      reason: `market-${input.observation.status}`,
      observation: observationProvenance,
    };
  }

  const playerQuotes = input.observation.quotes.filter((quote) =>
    input.player.kind === "trusted-id"
      ? quote.playerId === input.player.value
      : quote.rawPlayerName === input.player.value
  );
  if (playerQuotes.length === 0) {
    return {
      status: "unavailable",
      reason: "player-not-found-in-observation",
      observation: observationProvenance,
    };
  }

  const exactLineQuotes = playerQuotes.filter(
    (quote) => finiteNumber(quote.point) === input.line
  );
  if (exactLineQuotes.length === 0) {
    return {
      status: "unavailable",
      reason: "exact-line-not-found",
      observation: observationProvenance,
    };
  }

  const byBookmaker = new Map<
    string,
    { overPrice?: number; underPrice?: number }
  >();
  for (const quote of exactLineQuotes) {
    const price = finiteNumber(quote.decimalPrice);
    if (price === null) continue;
    const line = byBookmaker.get(quote.bookmakerKey) ?? {};
    if (quote.direction === "over") line.overPrice = price;
    else line.underPrice = price;
    byBookmaker.set(quote.bookmakerKey, line);
  }

  const lines = Array.from(byBookmaker, ([bookmakerKey, prices]) => ({
    bookmakerKey,
    overPrice: prices.overPrice ?? Number.NaN,
    underPrice: prices.underPrice ?? Number.NaN,
    point: input.line,
  }));
  const consensus = consensusDevigAtLine(lines, input.line);
  if (!consensus) {
    return {
      status: "unavailable",
      reason: "no-valid-two-way-quotes",
      observation: observationProvenance,
    };
  }
  return { status: "available", observation: observationProvenance, consensus };
};
