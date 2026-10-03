import { describe, expect, it } from "vitest";
import {
  consensusFromHistoricalObservation,
  type HistoricalMarketObservation,
} from "./historicalOddsQuery";

const observation = (): HistoricalMarketObservation => ({
  observationId: "observation-1",
  eventId: "event-1",
  marketKey: "player_pass_yds",
  status: "returned",
  source: "scheduled",
  capturedAt: "2026-10-04T19:40:00.000Z",
  eventStartTime: "2026-10-04T20:00:00.000Z",
  quotes: [
    {
      bookmakerKey: "draftkings",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "over",
      point: "244.5",
      decimalPrice: "1.90",
    },
    {
      bookmakerKey: "draftkings",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "under",
      point: "244.5",
      decimalPrice: "1.90",
    },
    {
      bookmakerKey: "fanduel",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "over",
      point: 244.5,
      decimalPrice: 1.85,
    },
    {
      bookmakerKey: "fanduel",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "under",
      point: 244.5,
      decimalPrice: 2.0,
    },
    {
      bookmakerKey: "other",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "over",
      point: 245.5,
      decimalPrice: 1.9,
    },
    {
      bookmakerKey: "other",
      rawPlayerName: "Jalen Hurts",
      playerId: null,
      direction: "under",
      point: 245.5,
      decimalPrice: 1.9,
    },
  ],
});

const query = (snapshot: HistoricalMarketObservation | null = observation()) =>
  consensusFromHistoricalObservation({
    observation: snapshot,
    cutoff: new Date("2026-10-04T19:50:00.000Z"),
    player: { kind: "provider-name", value: "Jalen Hurts" },
    line: 244.5,
  });

describe("consensusFromHistoricalObservation", () => {
  it("reproduces exact-line v1 consensus from one observation only", () => {
    const result = query();

    expect(result).toMatchObject({
      status: "available",
      observation: {
        observationId: "observation-1",
        source: "scheduled",
        ageAtCutoffMs: 10 * 60 * 1000,
        pregameLeadMs: 20 * 60 * 1000,
        label: "closing-candidate",
      },
      consensus: {
        line: 244.5,
        contributingBookCount: 2,
        method: "exact-line-median",
        version: 1,
      },
    });
  });

  it("does not search backward when the latest observation lacks the requested line", () => {
    const latest = observation();
    latest.observationId = "latest-with-moved-line";
    latest.quotes = latest.quotes.filter((quote) => Number(quote.point) === 245.5);

    expect(query(latest)).toEqual({
      status: "unavailable",
      reason: "exact-line-not-found",
      observation: expect.objectContaining({ observationId: "latest-with-moved-line" }),
    });
  });

  it("reports market state and player absence instead of fabricating consensus", () => {
    for (const status of ["unavailable", "empty", "invalid"] as const) {
      const snapshot = observation();
      snapshot.status = status;
      snapshot.quotes = [];
      expect(query(snapshot)).toMatchObject({
        status: "unavailable",
        reason: `market-${status}`,
      });
    }

    const missingPlayer = observation();
    expect(
      consensusFromHistoricalObservation({
        observation: missingPlayer,
        cutoff: new Date("2026-10-04T19:50:00Z"),
        player: { kind: "provider-name", value: "Josh Allen" },
        line: 244.5,
      })
    ).toMatchObject({
      status: "unavailable",
      reason: "player-not-found-in-observation",
    });
  });

  it("requires a complete valid Over/Under pair at the exact line", () => {
    const incomplete = observation();
    incomplete.capturedAt = "2026-10-04T18:00:00Z";
    incomplete.quotes = incomplete.quotes.filter(
      (quote) => quote.direction === "over" && Number(quote.point) === 244.5
    );

    expect(query(incomplete)).toMatchObject({
      status: "unavailable",
      reason: "no-valid-two-way-quotes",
      observation: { label: "latest-pregame" },
    });
  });

  it("matches trusted identity only by trusted id", () => {
    const snapshot = observation();
    snapshot.quotes = snapshot.quotes.map((quote) => ({
      ...quote,
      playerId: quote.bookmakerKey === "draftkings" ? "00-001" : null,
    }));

    const result = consensusFromHistoricalObservation({
      observation: snapshot,
      cutoff: new Date("2026-10-04T19:50:00Z"),
      player: { kind: "trusted-id", value: "00-001" },
      line: 244.5,
    });
    expect(result).toMatchObject({
      status: "available",
      consensus: { contributingBookCount: 1 },
    });
  });

  it("returns an honest no-observation result and rejects look-ahead timestamps", () => {
    expect(query(null)).toEqual({ status: "unavailable", reason: "no-observation" });

    const future = observation();
    future.capturedAt = "2026-10-04T19:51:00Z";
    expect(() => query(future)).toThrow("cutoff semantics");
  });
});
