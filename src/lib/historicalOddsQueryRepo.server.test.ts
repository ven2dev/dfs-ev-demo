import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const { getHistoricalMarketConsensus } = await import("./historicalOddsQueryRepo.ts");

afterEach(() => {
  queryMock.mockReset();
});

describe("getHistoricalMarketConsensus", () => {
  it("selects one latest observation at or before cutoff before inspecting quotes", async () => {
    queryMock.mockResolvedValueOnce([
      {
        observation_id: "observation-1",
        event_id: "event-1",
        market_key: "player_pass_yds",
        status: "returned",
        source: "scheduled",
        captured_at: "2026-10-04T19:40:00.000Z",
        event_start_time: "2026-10-04T20:00:00.000Z",
        quotes: [
          {
            bookmakerKey: "draftkings",
            rawPlayerName: "Jalen Hurts",
            playerId: null,
            direction: "over",
            point: 244.5,
            decimalPrice: 1.9,
          },
          {
            bookmakerKey: "draftkings",
            rawPlayerName: "Jalen Hurts",
            playerId: null,
            direction: "under",
            point: 244.5,
            decimalPrice: 1.9,
          },
        ],
      },
    ]);

    await expect(
      getHistoricalMarketConsensus({
        eventId: "event-1",
        marketKey: "player_pass_yds",
        cutoff: new Date("2026-10-04T19:50:00Z"),
        player: { kind: "provider-name", value: "Jalen Hurts" },
        line: 244.5,
      })
    ).resolves.toMatchObject({
      status: "available",
      consensus: { contributingBookCount: 1 },
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("observation.captured_at <= $3");
    expect(sql).toContain("ORDER BY observation.captured_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(sql.indexOf("LIMIT 1")).toBeLessThan(sql.indexOf("LEFT JOIN odds_quotes"));
    expect(params).toEqual([
      "event-1",
      "player_pass_yds",
      "2026-10-04T19:50:00.000Z",
    ]);
  });

  it("does not fall back when no observation exists before the cutoff", async () => {
    queryMock.mockResolvedValueOnce([]);

    await expect(
      getHistoricalMarketConsensus({
        eventId: "event-1",
        marketKey: "player_pass_yds",
        cutoff: new Date("2026-10-04T12:00:00Z"),
        player: { kind: "provider-name", value: "Jalen Hurts" },
        line: 244.5,
      })
    ).resolves.toEqual({ status: "unavailable", reason: "no-observation" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
