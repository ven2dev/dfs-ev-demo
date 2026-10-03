import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const { recordOddsApiRequest } = await import("./oddsApiTelemetryRepo.ts");

afterEach(() => {
  queryMock.mockReset();
});

describe("recordOddsApiRequest", () => {
  it("persists request provenance and quota without credentials or URLs", async () => {
    queryMock.mockResolvedValueOnce([]);

    await recordOddsApiRequest({
      id: "request-1",
      requestKind: "event-odds",
      source: "scheduled",
      sportKey: "americanfootball_nfl",
      eventId: "event-1",
      requestedMarkets: ["player_pass_yds", "player_receptions"],
      requestedAt: new Date("2026-10-04T19:45:59Z"),
      responseReceivedAt: new Date("2026-10-04T19:46:00Z"),
      outcome: "success",
      httpStatus: 200,
      quota: { remaining: 491, used: 9, last: 9 },
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("INSERT INTO odds_api_request_log");
    expect(sql).not.toContain("apiKey");
    expect(params).toEqual([
      "request-1",
      "event-odds",
      "scheduled",
      "americanfootball_nfl",
      "event-1",
      ["player_pass_yds", "player_receptions"],
      "2026-10-04T19:45:59.000Z",
      "2026-10-04T19:46:00.000Z",
      "success",
      200,
      491,
      9,
      9,
    ]);
  });

  it("rejects contradictory response outcomes before touching Postgres", async () => {
    await expect(
      recordOddsApiRequest({
        id: "request-1",
        requestKind: "events",
        source: "slate",
        sportKey: "americanfootball_nfl",
        eventId: null,
        requestedMarkets: [],
        requestedAt: new Date("2026-10-04T19:45:59Z"),
        responseReceivedAt: null,
        outcome: "success",
        httpStatus: 200,
        quota: { remaining: null, used: null, last: null },
      })
    ).rejects.toThrow("outcome does not match");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects event-odds telemetry without a billed market", async () => {
    await expect(
      recordOddsApiRequest({
        id: "request-1",
        requestKind: "event-odds",
        source: "scheduled",
        sportKey: "americanfootball_nfl",
        eventId: "event-1",
        requestedMarkets: [],
        requestedAt: new Date("2026-10-04T19:45:59Z"),
        responseReceivedAt: new Date("2026-10-04T19:46:00Z"),
        outcome: "success",
        httpStatus: 200,
        quota: { remaining: 491, used: 9, last: 9 },
      })
    ).rejects.toThrow("requires markets");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
