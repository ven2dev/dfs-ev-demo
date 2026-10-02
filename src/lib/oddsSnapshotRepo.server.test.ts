import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventOddsResponse } from "./oddsApi";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const { persistOddsObservation } = await import("./oddsSnapshotRepo.ts");

const response = (): EventOddsResponse => ({
  id: "event-1",
  bookmakers: [
    {
      key: "draftkings",
      markets: [
        {
          key: "player_pass_yds",
          last_update: "2026-10-04T19:00:00Z",
          outcomes: [
            { name: "Over", description: "Jalen Hurts", point: 244.5, price: 1.9 },
            { name: "Under", description: "Jalen Hurts", point: 244.5, price: 1.9 },
          ],
        },
      ],
    },
  ],
});

const input = () => ({
  observationId: "observation-1",
  sportKey: "americanfootball_nfl",
  eventId: "event-1",
  homeTeam: "Philadelphia Eagles",
  awayTeam: "New York Giants",
  eventStartTime: new Date("2026-10-04T20:25:00Z"),
  source: "scheduled" as const,
  capturedAt: new Date("2026-10-04T20:10:00Z"),
  requestedMarketKeys: ["player_pass_yds", "player_receptions"],
  collectionProfile: "free-pilot",
  checkpointKey: "t-15",
  quota: { remaining: 450, used: 50, last: 1 },
});

afterEach(() => {
  queryMock.mockReset();
});

describe("persistOddsObservation", () => {
  it("persists one observation and every requested market through one atomic statement", async () => {
    queryMock.mockResolvedValueOnce([
      {
        inserted: true,
        market_count: 2,
        quote_set_count: 1,
        inserted_quote_count: 2,
      },
    ]);

    await expect(persistOddsObservation(input(), response())).resolves.toEqual({
      inserted: true,
      marketCount: 2,
      quoteSetCount: 1,
      insertedQuoteCount: 2,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("WITH inserted_observation AS");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).toContain("DO UPDATE SET content_hash = EXCLUDED.content_hash");
    expect(sql).toContain("INSERT INTO odds_quotes");
    expect(params.slice(0, 14)).toEqual([
      "observation-1",
      "americanfootball_nfl",
      "event-1",
      "Philadelphia Eagles",
      "New York Giants",
      "2026-10-04T20:25:00.000Z",
      "scheduled",
      "2026-10-04T20:10:00.000Z",
      ["player_pass_yds", "player_receptions"],
      "free-pilot",
      "t-15",
      450,
      50,
      1,
    ]);

    const markets = JSON.parse(params[14]);
    expect(markets).toEqual([
      expect.objectContaining({
        market_key: "player_pass_yds",
        status: "returned",
        content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        bookmaker_observations: [
          {
            bookmaker_key: "draftkings",
            provider_updated_at: "2026-10-04T19:00:00Z",
          },
        ],
        quotes: expect.arrayContaining([
          expect.objectContaining({ direction: "over", raw_player_name: "Jalen Hurts" }),
          expect.objectContaining({ direction: "under", raw_player_name: "Jalen Hurts" }),
        ]),
      }),
      expect.objectContaining({
        market_key: "player_receptions",
        status: "unavailable",
        content_hash: null,
        quotes: [],
      }),
    ]);
  });

  it("returns an idempotent retry result without inventing a second observation", async () => {
    queryMock.mockResolvedValueOnce([
      {
        inserted: false,
        market_count: 0,
        quote_set_count: 0,
        inserted_quote_count: 0,
      },
    ]);

    await expect(persistOddsObservation(input(), response())).resolves.toEqual({
      inserted: false,
      marketCount: 0,
      quoteSetCount: 0,
      insertedQuoteCount: 0,
    });
  });

  it("rejects a response received at or after kickoff before touching Postgres", async () => {
    const afterKickoff = input();
    afterKickoff.capturedAt = new Date("2026-10-04T20:25:00Z");

    await expect(persistOddsObservation(afterKickoff, response())).rejects.toThrow(
      "must be captured before event start"
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched events and duplicate requested markets", async () => {
    const mismatched = response();
    mismatched.id = "other-event";
    await expect(persistOddsObservation(input(), mismatched)).rejects.toThrow(
      "does not match"
    );

    const duplicates = input();
    duplicates.requestedMarketKeys = ["player_pass_yds", "player_pass_yds"];
    await expect(persistOddsObservation(duplicates, response())).rejects.toThrow(
      "must not contain duplicates"
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects invalid quota telemetry before touching Postgres", async () => {
    const invalidQuota = input();
    invalidQuota.quota.remaining = -1;

    await expect(persistOddsObservation(invalidQuota, response())).rejects.toThrow(
      "quota.remaining"
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects blank collection metadata before touching Postgres", async () => {
    const invalidProfile = input();
    invalidProfile.collectionProfile = " ";

    await expect(persistOddsObservation(invalidProfile, response())).rejects.toThrow(
      "collectionProfile"
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fails loudly when persistence returns no result row", async () => {
    queryMock.mockResolvedValueOnce([]);

    await expect(persistOddsObservation(input(), response())).rejects.toThrow(
      "persistence returned no result"
    );
  });
});
