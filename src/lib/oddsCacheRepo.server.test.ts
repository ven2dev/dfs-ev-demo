import { describe, it, expect, vi, afterEach } from "vitest";
import type { EventOddsResponse } from "./oddsApi.ts";

const queryMock = vi.fn();
const fetchEventOddsMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

vi.mock("./oddsApi", () => ({
  fetchEventOdds: fetchEventOddsMock,
}));

// Imported after the mocks so getOrFetchMarketOdds resolves getSql/
// fetchEventOdds to the fakes above, not the real server-only-guarded
// modules (which would require a real DATABASE_URL/ODDS_API_KEY).
const { getOrFetchMarketOdds } = await import("./oddsCacheRepo.ts");

afterEach(() => {
  queryMock.mockReset();
  fetchEventOddsMock.mockReset();
});

const freshRow = (marketKey: string, bookmakerKey: string, secondsAgo = 30) => ({
  market_key: marketKey,
  fetched_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  payload: {
    bookmakers: [
      {
        key: bookmakerKey,
        markets: [{ key: marketKey, outcomes: [{ name: "Over", price: -110, point: 214.5 }] }],
      },
    ],
  },
});

const apiResponse = (marketKey: string, bookmakerKey = "draftkings"): EventOddsResponse => ({
  id: "evt-1",
  bookmakers: [
    {
      key: bookmakerKey,
      markets: [{ key: marketKey, outcomes: [{ name: "Over", price: -115, point: 71.5 }] }],
    },
  ],
});

describe("getOrFetchMarketOdds", () => {
  it("fetches and caches every requested market on a cold cache", async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT: nothing cached
    fetchEventOddsMock.mockResolvedValueOnce({
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            { key: "player_pass_yds", outcomes: [] },
            { key: "player_rush_yds", outcomes: [] },
          ],
        },
      ],
    });
    queryMock.mockResolvedValue([]); // the two INSERT upserts

    await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_rush_yds",
    ]);

    expect(fetchEventOddsMock).toHaveBeenCalledTimes(1);
    expect(fetchEventOddsMock).toHaveBeenCalledWith("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_rush_yds",
    ]);
    // 1 SELECT + 2 upserts (one per market)
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("skips the API entirely when every requested market is already cached and fresh", async () => {
    queryMock.mockResolvedValueOnce([
      freshRow("player_pass_yds", "draftkings"),
      freshRow("player_rush_yds", "fanduel"),
    ]);

    const result = await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_rush_yds",
    ]);

    expect(fetchEventOddsMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1); // just the SELECT, no upserts
    expect(result.bookmakers).toHaveLength(2);
  });

  it("only fetches the markets that are missing, not ones already fresh in the cache", async () => {
    queryMock.mockResolvedValueOnce([freshRow("player_pass_yds", "draftkings")]);
    fetchEventOddsMock.mockResolvedValueOnce(apiResponse("player_rush_yds"));
    queryMock.mockResolvedValueOnce([]); // the one upsert for the missing market

    await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_rush_yds",
    ]);

    expect(fetchEventOddsMock).toHaveBeenCalledWith("americanfootball_nfl", "evt-1", [
      "player_rush_yds",
    ]);
  });

  it("treats a stale (TTL-expired) cache row as missing and refetches it", async () => {
    queryMock.mockResolvedValueOnce([freshRow("player_pass_yds", "draftkings", 10 * 60)]); // 10 min old
    fetchEventOddsMock.mockResolvedValueOnce(apiResponse("player_pass_yds"));
    queryMock.mockResolvedValueOnce([]);

    await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", ["player_pass_yds"]);

    expect(fetchEventOddsMock).toHaveBeenCalledWith("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
    ]);
  });

  it("forceRefresh refetches a row that's within the normal TTL but past the shorter force-refresh cooldown", async () => {
    // 60s old: well under the normal 5-min TTL (would be "fresh" on a
    // plain request), but past the 20s force-refresh cooldown.
    queryMock.mockResolvedValueOnce([freshRow("player_pass_yds", "draftkings", 60)]);
    fetchEventOddsMock.mockResolvedValueOnce(apiResponse("player_pass_yds"));
    queryMock.mockResolvedValueOnce([]); // the upsert

    await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", ["player_pass_yds"], {
      forceRefresh: true,
    });

    expect(fetchEventOddsMock).toHaveBeenCalledWith("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
    ]);
  });

  it("forceRefresh still refuses to re-hit the API for a market refreshed within the cooldown window -- the anti-spam floor", async () => {
    // 5s old: inside the 20s force-refresh cooldown.
    queryMock.mockResolvedValueOnce([freshRow("player_pass_yds", "draftkings", 5)]);

    const result = await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", ["player_pass_yds"], {
      forceRefresh: true,
    });

    expect(fetchEventOddsMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1); // just the SELECT, no upsert -- no API call was made
    expect(result.bookmakers).toHaveLength(1);
  });

  it("de-dupes concurrent requests for the same event+market-set, calling the API only once", async () => {
    queryMock.mockResolvedValue([]); // every SELECT/upsert in this test resolves empty

    let resolveFetch!: (value: EventOddsResponse) => void;
    const pendingFetch = new Promise<EventOddsResponse>((resolve) => {
      resolveFetch = resolve;
    });
    fetchEventOddsMock.mockReturnValueOnce(pendingFetch);

    const call1 = getOrFetchMarketOdds("americanfootball_nfl", "evt-1", ["player_pass_yds"]);
    const call2 = getOrFetchMarketOdds("americanfootball_nfl", "evt-1", ["player_pass_yds"]);

    // Let both calls run past their SELECT and reach the point where
    // they'd each try to fetch, before the one shared fetch resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));

    resolveFetch({
      id: "evt-1",
      bookmakers: [{ key: "draftkings", markets: [{ key: "player_pass_yds", outcomes: [] }] }],
    });

    const [result1, result2] = await Promise.all([call1, call2]);

    expect(fetchEventOddsMock).toHaveBeenCalledTimes(1);
    expect(result1.bookmakers).toEqual(result2.bookmakers);
  });

  it("de-duplicates repeated market keys before checking the cache or the API", async () => {
    queryMock.mockResolvedValueOnce([]);
    fetchEventOddsMock.mockResolvedValueOnce(apiResponse("player_pass_yds"));
    queryMock.mockResolvedValueOnce([]);

    await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_pass_yds",
    ]);

    expect(fetchEventOddsMock).toHaveBeenCalledWith("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
    ]);
  });

  it("merges a bookmaker's markets from different sources (cache + fresh fetch) into one entry, not duplicates", async () => {
    queryMock.mockResolvedValueOnce([freshRow("player_pass_yds", "draftkings")]);
    fetchEventOddsMock.mockResolvedValueOnce(apiResponse("player_rush_yds", "draftkings"));
    queryMock.mockResolvedValueOnce([]);

    const result = await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", [
      "player_pass_yds",
      "player_rush_yds",
    ]);

    const draftkings = result.bookmakers.find((b) => b.key === "draftkings");
    expect(draftkings?.markets.map((m) => m.key).sort()).toEqual([
      "player_pass_yds",
      "player_rush_yds",
    ]);
  });

  it("returns an empty result and touches neither the DB nor the API when given no market keys", async () => {
    const result = await getOrFetchMarketOdds("americanfootball_nfl", "evt-1", []);

    expect(result).toEqual({ id: "evt-1", bookmakers: [] });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchEventOddsMock).not.toHaveBeenCalled();
  });
});
