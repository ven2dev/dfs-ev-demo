import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchEventOdds,
  fetchPlayerPropMarketOdds,
  fetchPlayerPropOdds,
  fetchSlateEvents,
  OddsApiHttpError,
} from "./oddsApi.ts";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

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

describe("fetchSlateEvents", () => {
  it("throws when ODDS_API_KEY is not set, without making a request", async () => {
    vi.stubEnv("ODDS_API_KEY", "");

    await expect(fetchSlateEvents("americanfootball_nfl")).rejects.toThrow(
      "ODDS_API_KEY is not set"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the bare /events endpoint -- no markets/regions params, since those are what cost credits", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await fetchSlateEvents("americanfootball_nfl");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/sports/americanfootball_nfl/events?apiKey=test-key");
    expect(url).not.toContain("markets=");
    expect(url).not.toContain("regions=");
  });

  it("maps the raw snake_case response into camelCase SlateEvent objects", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "evt-1",
          sport_key: "americanfootball_nfl",
          home_team: "Chicago Bears",
          away_team: "Seattle Seahawks",
          commence_time: "2026-10-05T17:00:00Z",
        },
      ])
    );

    const result = await fetchSlateEvents(
      "americanfootball_nfl",
      new Date("2026-09-30T12:00:00Z")
    );

    expect(result.data).toEqual([
      {
        id: "evt-1",
        sportKey: "americanfootball_nfl",
        homeTeam: "Chicago Bears",
        awayTeam: "Seattle Seahawks",
        commenceTime: "2026-10-05T17:00:00Z",
      },
    ]);
  });

  it("filters the upstream event list to the server-defined current NFL week", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "week-4",
          sport_key: "americanfootball_nfl",
          home_team: "Chicago Bears",
          away_team: "Seattle Seahawks",
          commence_time: "2026-10-05T17:00:00Z",
        },
        {
          id: "week-5",
          sport_key: "americanfootball_nfl",
          home_team: "Denver Broncos",
          away_team: "Las Vegas Raiders",
          commence_time: "2026-10-08T00:15:00Z",
        },
      ])
    );

    const result = await fetchSlateEvents(
      "americanfootball_nfl",
      new Date("2026-09-30T12:00:00Z")
    );

    expect(result.data.map((event) => event.id)).toEqual(["week-4"]);
  });

  it("captures response time and sanitized quota headers", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse([], true, 200, {
        "x-requests-remaining": "491",
        "x-requests-used": "9",
        "x-requests-last": "0",
      })
    );

    const before = Date.now();
    const result = await fetchSlateEvents("americanfootball_nfl");

    expect(new Date(result.capturedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(result.quota).toEqual({ remaining: 491, used: 9, last: 0 });
  });

  it("throws on a non-ok response instead of silently returning an empty slate", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 500));

    await expect(fetchSlateEvents("americanfootball_nfl")).rejects.toThrow(
      "Odds API events fetch failed: 500"
    );
  });
});

describe("fetchEventOdds", () => {
  it("preserves quota telemetry on a billed HTTP failure", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(null, false, 503, {
        "x-requests-remaining": "482",
        "x-requests-used": "18",
        "x-requests-last": "9",
      })
    );

    const error = await fetchEventOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
    ]).catch((caught) => caught);

    expect(error).toBeInstanceOf(OddsApiHttpError);
    expect(error).toMatchObject({
      status: 503,
      quota: { remaining: 482, used: 18, last: 9 },
    });
  });
});

describe("fetchPlayerPropOdds", () => {
  const twoBookResponse = jsonResponse({
    id: "evt-1",
    bookmakers: [
      {
        key: "draftkings",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 },
              { name: "Under", description: "Jalen Hurts", price: 1.89, point: 214.5 },
            ],
          },
        ],
      },
      {
        key: "fanduel",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", description: "Jalen Hurts", price: 1.87, point: 213.5 },
              { name: "Under", description: "Jalen Hurts", price: 1.95, point: 213.5 },
            ],
          },
        ],
      },
    ],
  });

  it("returns the SPECIFIED bookmaker's line, not just the first one that matches", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(twoBookResponse);

    const result = await fetchPlayerPropOdds(
      "americanfootball_nfl",
      "evt-1",
      "player_pass_yds",
      "Jalen Hurts",
      "fanduel"
    );

    expect(result).toEqual({ overPrice: 1.87, underPrice: 1.95, point: 213.5 });
  });

  it("returns every bookmaker line for the shared prop cache in one upstream call", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(twoBookResponse);
    const controller = new AbortController();

    const result = await fetchPlayerPropMarketOdds(
      "americanfootball_nfl",
      "evt-1",
      "player_pass_yds",
      "Jalen Hurts",
      controller.signal
    );

    expect(result.data.oddsByBookmaker).toEqual([
      {
        bookmakerKey: "draftkings",
        overPrice: 1.91,
        underPrice: 1.89,
        point: 214.5,
      },
      {
        bookmakerKey: "fanduel",
        overPrice: 1.87,
        underPrice: 1.95,
        point: 213.5,
      },
    ]);
    expect(result.data.response?.bookmakers).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it("excludes a bookmaker whose Over and Under outcomes do not share one point", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "evt-1",
        bookmakers: [
          {
            key: "draftkings",
            markets: [
              {
                key: "player_pass_yds",
                outcomes: [
                  { name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 },
                  { name: "Under", description: "Jalen Hurts", price: 1.89, point: 215.5 },
                ],
              },
            ],
          },
        ],
      })
    );

    await expect(
      fetchPlayerPropMarketOdds(
        "americanfootball_nfl",
        "evt-1",
        "player_pass_yds",
        "Jalen Hurts"
      )
    ).resolves.toMatchObject({ data: { oddsByBookmaker: [], response: expect.any(Object) } });
  });

  it("returns null when the specified bookmaker doesn't have this market, even if another bookmaker does", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(twoBookResponse);

    const result = await fetchPlayerPropOdds(
      "americanfootball_nfl",
      "evt-1",
      "player_pass_yds",
      "Jalen Hurts",
      "betmgm"
    );

    expect(result).toBeNull();
  });

  it("returns null on a non-ok response rather than throwing", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 500));

    const result = await fetchPlayerPropOdds(
      "americanfootball_nfl",
      "evt-1",
      "player_pass_yds",
      "Jalen Hurts",
      "draftkings"
    );

    expect(result).toBeNull();
  });

  it("throws when ODDS_API_KEY is not set, without making a request", async () => {
    vi.stubEnv("ODDS_API_KEY", "");

    await expect(
      fetchPlayerPropOdds("americanfootball_nfl", "evt-1", "player_pass_yds", "Jalen Hurts", "draftkings")
    ).rejects.toThrow("ODDS_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
