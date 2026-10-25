import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = { read: vi.fn(), tryAcquireRefresh: vi.fn(), renew: vi.fn(), write: vi.fn(), release: vi.fn() };
  return {
    store,
    getOrRefresh: vi.fn(),
    query: vi.fn(),
    fetchOdds: vi.fn(),
    fetchWeather: vi.fn(),
    persistObservation: vi.fn(),
  };
});

vi.mock("@dfs-ev/db/runtime", async () => ({
  ...(await vi.importActual("@dfs-ev/db/runtime")),
  getOrRefresh: mocks.getOrRefresh,
}));
vi.mock("node:crypto", () => ({ randomUUID: () => "owner-1" }));
vi.mock("./db", () => ({ getSql: () => ({ query: mocks.query }) }));
vi.mock("./oddsApi", () => ({ fetchPlayerPropMarketOdds: mocks.fetchOdds }));
vi.mock("./weather", () => ({ fetchGameWeather: mocks.fetchWeather }));
vi.mock("./oddsSnapshotRepo", () => ({ persistOddsObservation: mocks.persistObservation }));

const { getSharedLivePropInputs } = await import("./livePropCacheRepo.ts");

const key = { sportKey: "americanfootball_nfl", eventId: "evt-1", marketKey: "player_pass_yds", playerName: "Jalen Hurts" };
const context = { startTime: "2026-10-05T17:00:00Z", homeTeam: "Chicago Bears", awayTeam: "Seattle Seahawks", venueLat: 41.8623, venueLon: -87.6167 };
const oddsByBookmaker = [{ bookmakerKey: "fixture", overPrice: 1.91, underPrice: 1.89, point: 214.5 }];
const weather = { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 };

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  for (const value of Object.values(mocks)) if ("mockReset" in value) value.mockReset();
  mocks.query.mockResolvedValue([]);
  mocks.fetchOdds.mockResolvedValue({
    data: { response: undefined, oddsByBookmaker },
    capturedAt: "2026-10-05T16:00:00.000Z",
    quota: { remaining: 479, used: 21, last: 1 },
  });
  mocks.fetchWeather.mockResolvedValue(weather);
});

describe("getSharedLivePropInputs wiring", () => {
  it("binds the lazy query, TTL, id, clock and fetch callbacks to the generic kernel", async () => {
    const events: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456);
    mocks.getOrRefresh.mockImplementation(async (passedKey, deps, options) => {
      events.push("kernel");
      expect(passedKey).toEqual(key);
      expect(options).toEqual({ ttlMs: 90_000 });
      expect(deps.makeOwnerId()).toBe("owner-1");
      expect(deps.now()).toBe(123_456);
      expect(typeof deps.wait).toBe("function");
      await deps.read(passedKey);
      const fresh = await deps.fetchFresh(passedKey, new AbortController().signal);
      events.push("fresh");
      return fresh;
    });

    await expect(getSharedLivePropInputs(key, context)).resolves.toMatchObject({ oddsByBookmaker, weather });
    // Store construction occurs on module import, but the driver is still lazy:
    // this callback is not invoked until a cache operation needs it.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("FROM live_prop_inputs_cache");
    expect(mocks.fetchOdds).toHaveBeenCalledWith(
      key.sportKey, key.eventId, key.marketKey, key.playerName, expect.any(AbortSignal), "live"
    );
    expect(mocks.fetchWeather).toHaveBeenCalledWith(
      context.startTime, context.venueLat, context.venueLon, expect.any(AbortSignal)
    );
    expect(mocks.persistObservation).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["kernel", "fresh"]);
  });
});
