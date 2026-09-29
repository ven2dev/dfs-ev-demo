import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSlateEvents } from "./oddsApi.ts";

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
