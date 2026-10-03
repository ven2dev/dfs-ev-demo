import { afterEach, describe, expect, it, vi } from "vitest";

const recordOddsApiRequestMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("./oddsApiTelemetryRepo", () => ({
  recordOddsApiRequest: recordOddsApiRequestMock,
}));
vi.stubGlobal("fetch", fetchMock);

const { fetchEventOdds, fetchPlayerPropMarketOdds, fetchSlateEvents } =
  await import("./oddsApi.ts");

const jsonResponse = (
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {}
) => ({
  ok,
  status,
  headers: new Headers(headers),
  json: () => Promise.resolve(body),
});

afterEach(() => {
  fetchMock.mockReset();
  recordOddsApiRequestMock.mockReset();
  vi.unstubAllEnvs();
});

describe("Odds API request telemetry", () => {
  it("records a scheduled event-odds request with its billed quota", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubEnv("DATABASE_URL", "postgres://configured");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { id: "event-1", bookmakers: [] },
        true,
        200,
        {
          "x-requests-remaining": "491",
          "x-requests-used": "9",
          "x-requests-last": "9",
        }
      )
    );

    await fetchEventOdds(
      "americanfootball_nfl",
      "event-1",
      ["player_pass_yds", "player_receptions"],
      undefined,
      "scheduled"
    );

    expect(recordOddsApiRequestMock).toHaveBeenCalledOnce();
    expect(recordOddsApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKind: "event-odds",
        source: "scheduled",
        sportKey: "americanfootball_nfl",
        eventId: "event-1",
        requestedMarkets: ["player_pass_yds", "player_receptions"],
        outcome: "success",
        httpStatus: 200,
        quota: { remaining: 491, used: 9, last: 9 },
      })
    );
  });

  it("records a free slate request without inventing billed markets", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubEnv("DATABASE_URL", "postgres://configured");
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await fetchSlateEvents(
      "americanfootball_nfl",
      new Date("2026-09-30T12:00:00Z"),
      undefined,
      "live"
    );

    expect(recordOddsApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKind: "events",
        source: "live",
        eventId: null,
        requestedMarkets: [],
        outcome: "success",
        httpStatus: 200,
      })
    );
  });

  it("records an HTTP failure before returning an unavailable player market", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubEnv("DATABASE_URL", "postgres://configured");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(null, false, 429, {
        "x-requests-remaining": "0",
        "x-requests-used": "500",
        "x-requests-last": "1",
      })
    );

    const result = await fetchPlayerPropMarketOdds(
      "americanfootball_nfl",
      "event-1",
      "player_pass_yds",
      "Jalen Hurts",
      undefined,
      "live"
    );

    expect(result.data).toEqual({ response: null, oddsByBookmaker: [] });
    expect(recordOddsApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "live",
        requestedMarkets: ["player_pass_yds"],
        outcome: "http-error",
        httpStatus: 429,
        quota: { remaining: 0, used: 500, last: 1 },
      })
    );
  });

  it("distinguishes an aborted request from a generic network error", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubEnv("DATABASE_URL", "postgres://configured");
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    await expect(
      fetchEventOdds(
        "americanfootball_nfl",
        "event-1",
        ["player_pass_yds"],
        controller.signal,
        "discovery"
      )
    ).rejects.toThrow("aborted");

    expect(recordOddsApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "discovery",
        outcome: "aborted",
        responseReceivedAt: null,
        httpStatus: null,
        quota: { remaining: null, used: null, last: null },
      })
    );
  });
});
