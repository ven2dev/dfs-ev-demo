import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPlayerPropOdds, fetchSlateEvents } from "./oddsApi.ts";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
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

    const events = await fetchSlateEvents("americanfootball_nfl");

    expect(events).toEqual([
      {
        id: "evt-1",
        sportKey: "americanfootball_nfl",
        homeTeam: "Chicago Bears",
        awayTeam: "Seattle Seahawks",
        commenceTime: "2026-10-05T17:00:00Z",
      },
    ]);
  });

  it("throws on a non-ok response instead of silently returning an empty slate", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 500));

    await expect(fetchSlateEvents("americanfootball_nfl")).rejects.toThrow(
      "Odds API events fetch failed: 500"
    );
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
