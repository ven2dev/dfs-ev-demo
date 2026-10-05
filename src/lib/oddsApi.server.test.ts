import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchEventOdds,
  fetchPlayerPropMarketOdds,
  fetchPlayerPropOdds,
  fetchSlateEvents,
  OddsApiHttpError,
} from "./oddsApi.ts";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.stubEnv("ODDS_DATA_SOURCE", "live");
});

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

describe("provider request boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
  });

  const eventFetchers = [
    ["discovery", (eventId: string) => fetchEventOdds("americanfootball_nfl", eventId, ["player_pass_yds"])],
    ["live", (eventId: string) => fetchPlayerPropMarketOdds("americanfootball_nfl", eventId, "player_pass_yds", "Jalen Hurts")],
  ] as const;

  describe.each(eventFetchers)("%s event IDs", (_name, call) => {
    it.each([
      "", ".", "..", "../../other", "a/b", "a\\b", "%2e%2e%2fother",
      "%252e%252e", "evt?apiKey=other", "evt#fragment", "evt\n", "evt\u0000",
      "évt", "a".repeat(129),
    ])("rejects unsafe ID %j before fetch", async (eventId) => {
      await expect(call(eventId)).rejects.toThrow("Invalid eventId");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each(["basketball_nba", "../../sports/basketball_nba", "americanfootball_nfl?regions=eu#", ""])(
    "rejects unsupported sport %j at every provider boundary", async (sportKey) => {
      await expect(fetchSlateEvents(sportKey)).rejects.toThrow("Only americanfootball_nfl");
      await expect(fetchEventOdds(sportKey, "evt-1", ["player_pass_yds"])).rejects.toThrow("Only americanfootball_nfl");
      await expect(fetchPlayerPropMarketOdds(sportKey, "evt-1", "player_pass_yds", "Jalen Hurts")).rejects.toThrow("Only americanfootball_nfl");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["h2h", "player_pass_yds&regions=eu", "player_pass_yds#", "player_pass_yds,player_receptions"])(
    "rejects unknown/injected market %j before fetch", async (marketKey) => {
      await expect(fetchEventOdds("americanfootball_nfl", "evt-1", ["player_pass_yds", marketKey])).rejects.toThrow("Unknown player-prop market");
      await expect(fetchPlayerPropMarketOdds("americanfootball_nfl", "evt-1", marketKey, "Jalen Hurts")).rejects.toThrow("Unknown player-prop market");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("rejects an empty market batch without fetching", async () => {
    await expect(fetchEventOdds("americanfootball_nfl", "evt-1", [])).rejects.toThrow("at least one market");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps credentials inside one query value and preserves safe path tokens, markets, and abort signals", async () => {
    const apiKey = "local&regions=eu#?+example";
    vi.stubEnv("ODDS_API_KEY", apiKey);
    fetchMock.mockResolvedValue(jsonResponse({ bookmakers: [] }));
    const controller = new AbortController();
    await fetchEventOdds("americanfootball_nfl", "fixture-week_4", ["player_pass_yds", "player_anytime_td"], controller.signal);
    await fetchPlayerPropMarketOdds("americanfootball_nfl", "a".repeat(128), "player_receptions", "Jalen Hurts", controller.signal);
    fetchMock.mockResolvedValue(jsonResponse([]));
    await fetchSlateEvents("americanfootball_nfl", new Date(), controller.signal);

    const urls = fetchMock.mock.calls.map(([url, options]) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://api.the-odds-api.com");
      expect(parsed.hash).toBe("");
      expect(parsed.searchParams.getAll("apiKey")).toEqual([apiKey]);
      expect(options).toMatchObject({ cache: "no-store", signal: controller.signal, redirect: "error" });
      return parsed;
    });
    expect(urls[0].pathname).toBe("/v4/sports/americanfootball_nfl/events/fixture-week_4/odds/");
    expect([...urls[0].searchParams]).toEqual([["apiKey", apiKey], ["regions", "us"], ["markets", "player_pass_yds,player_anytime_td"]]);
    expect(urls[1].pathname).toBe(`/v4/sports/americanfootball_nfl/events/${"a".repeat(128)}/odds/`);
    expect(urls[1].searchParams.get("markets")).toBe("player_receptions");
    expect(urls[2].pathname).toBe("/v4/sports/americanfootball_nfl/events");
    expect([...urls[2].searchParams]).toEqual([["apiKey", apiKey]]);
  });
});

describe("fetchSlateEvents", () => {
  it("throws when ODDS_API_KEY is not set, without making a request", async () => {
    vi.stubEnv("ODDS_API_KEY", "");

    await expect(fetchSlateEvents("americanfootball_nfl")).rejects.toThrow(
      "requires ODDS_API_KEY"
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
    ).rejects.toThrow("requires ODDS_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
