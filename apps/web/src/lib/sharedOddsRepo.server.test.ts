import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_PROP_MARKETS } from "./playerPropMarkets";

const m = vi.hoisted(() => ({ query: vi.fn(), event: vi.fn(), legacy: vi.fn(), weather: vi.fn(), persist: vi.fn() }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./oddsApi", () => ({ fetchEventOdds: m.event, fetchPlayerPropMarketOdds: m.legacy }));
vi.mock("./weather", () => ({ fetchGameWeather: m.weather }));
vi.mock("./oddsSnapshotRepo", () => ({ persistOddsObservation: m.persist }));

const keys = PLAYER_PROP_MARKETS.map(market => market.key);
const capturedAt = "2026-10-05T16:00:00.000Z";
const payload = { bookmakers: [{ key: "book", markets: [{ key: "player_pass_yds", outcomes: [
  { name: "Over", description: "Player A", point: 200, price: 1.9 },
  { name: "Under", description: "Player A", point: 200, price: 1.8 },
] }] }] };
const key = { sportKey: "americanfootball_nfl", eventId: "event", marketKey: "player_pass_yds", playerName: "Player A" };
const context = { startTime: "2026-10-05T17:00:00Z", homeTeam: "Home", awayTeam: "Away", venueLat: 0, venueLon: 0 };

beforeEach(() => {
  vi.resetModules();
  Object.values(m).forEach(mock => mock.mockReset());
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@database.invalid/synthetic");
  m.weather.mockResolvedValue({ temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 });
  m.persist.mockResolvedValue({ inserted: true });
});
afterEach(() => vi.unstubAllEnvs());

const start = async (ready: boolean) => {
  m.query.mockResolvedValueOnce([{ ready }]);
  const { initializeOddsCache } = await import("./oddsCacheStartup");
  await initializeOddsCache();
  m.query.mockClear();
};

describe("startup-selected application integration", () => {
  it("returns one unavailable cooldown key and fetches the other eleven in one request", async () => {
    await start(true);
    const resources = Object.fromEntries(keys.map((key, index) => [key, {
      state: index ? "pending" : "unavailable", payload: null, fetchedAt: null,
    }]));
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      outcome: "leader", owned_keys: keys.slice(1).sort(), resources,
    }]).mockResolvedValue([]);
    m.event.mockResolvedValue({
      data: { id: "event", sport_key: key.sportKey, commence_time: context.startTime,
        home_team: "Home", away_team: "Away", bookmakers: [] },
      capturedAt, quota: { remaining: 100, used: 11, last: 11 },
    });
    const { getOrFetchMarketOdds } = await import("./oddsCacheRepo");
    const result = await getOrFetchMarketOdds(key.sportKey, key.eventId, keys);
    expect(m.event).toHaveBeenCalledOnce();
    expect(m.event.mock.calls[0][2]).toEqual(keys.slice(1).sort());
    expect(result.origins[keys[0]]).toMatchObject({ status: "unavailable", capturedAt: null });
    expect(keys.slice(1).every(key => result.origins[key].status === "upstream")).toBe(true);
    const publication = m.query.mock.calls.find(([text]) => text.includes("publish_shared"));
    const written = JSON.parse(publication![1][3]);
    expect(Object.keys(written)).toHaveLength(11);
    expect(written[keys[0]]).toBeUndefined();
    expect(Object.values(written).every(value => (value as typeof payload).bookmakers.length === 0)).toBe(true);
    expect(m.persist).toHaveBeenCalledOnce();
    expect(m.weather).not.toHaveBeenCalled();
  });

  it("returns stale live odds without re-aging the outer view and leaves weather on its path", async () => {
    await start(true);
    m.query.mockResolvedValueOnce([]) // outer cache read
      .mockResolvedValueOnce([{ refresh_owner: "owner" }]) // outer claim
      .mockResolvedValueOnce([]) // raw read
      .mockResolvedValueOnce([{ outcome: "complete", owned_keys: [], resources: {
        [key.marketKey]: { state: "stale", payload, fetchedAt: capturedAt },
      } }]).mockResolvedValue([]); // outer release instead of publication
    const { getSharedLivePropInputs } = await import("./livePropCacheRepo");
    const result = await getSharedLivePropInputs(key, context);
    expect(result.oddsObservation).toMatchObject({ origin: "cache", status: "stale", capturedAt });
    expect(result.oddsByBookmaker[0].point).toBe(200);
    expect(m.weather).toHaveBeenCalledOnce();
    expect(m.event).not.toHaveBeenCalled();
    expect(m.legacy).not.toHaveBeenCalled();
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.query.mock.calls.some(([text]) => text.includes("SET payload ="))).toBe(false);
    expect(m.query.mock.calls.at(-1)![0]).toContain("refresh_owner = NULL");
  });

  it("marks a raw hit as cached and does not persist another observation", async () => {
    await start(true);
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ market_key: key.marketKey, payload, fetched_at: capturedAt, fresh: true }])
      .mockResolvedValue([{ event_id: key.eventId }]);
    const { getSharedLivePropInputs } = await import("./livePropCacheRepo");
    const result = await getSharedLivePropInputs(key, context);
    expect(result.oddsObservation).toMatchObject({ origin: "cache", status: "fresh", observationId: null });
    expect(m.weather).toHaveBeenCalledOnce();
    expect(m.event).not.toHaveBeenCalled();
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.query).toHaveBeenCalledTimes(4); // two outer, raw read, outer publish
    const write = m.query.mock.calls.at(-1)!;
    expect(write[0]).toContain("FROM public.event_market_odds_cache");
    expect(write[0]).toContain("IS NOT DISTINCT FROM $7::text");
    expect(write[1][6]).toBeNull();
  });

  it("retains live observation context fallback when raw event metadata is absent", async () => {
    await start(true);
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ outcome: "leader", owned_keys: [key.marketKey], resources: {} }])
      .mockResolvedValue([{ event_id: key.eventId }]);
    m.event.mockResolvedValue({ data: { id: key.eventId, ...payload }, capturedAt,
      quota: { remaining: 10, used: 1, last: 1 } });
    const { getSharedLivePropInputs } = await import("./livePropCacheRepo");
    const result = await getSharedLivePropInputs(key, context);
    expect(result.oddsObservation).toMatchObject({ origin: "upstream", persisted: true });
    expect(m.persist).toHaveBeenCalledOnce();
    expect(m.persist.mock.calls[0][0]).toMatchObject({ source: "live", homeTeam: "Home", awayTeam: "Away" });
    expect(m.persist.mock.calls[0][1].commence_time).toBe(context.startTime);
    expect(m.weather).toHaveBeenCalledOnce();
    expect(m.event).toHaveBeenCalledOnce();
  });

  it("selects actual legacy live behavior on the current schema", async () => {
    await start(false);
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValue([{ event_id: key.eventId }]);
    m.legacy.mockResolvedValue({ data: { response: null, oddsByBookmaker: [{ bookmakerKey: "book", point: 200, overPrice: 1.9, underPrice: 1.8 }] },
      capturedAt, quota: { remaining: null, used: null, last: null } });
    const { getSharedLivePropInputs } = await import("./livePropCacheRepo");
    const result = await getSharedLivePropInputs(key, context);
    expect(result.oddsObservation?.origin).toBe("upstream");
    expect(result.oddsObservation?.status).toBeUndefined();
    expect(m.legacy).toHaveBeenCalledOnce();
    expect(m.event).not.toHaveBeenCalled();
    expect(m.query).toHaveBeenCalledTimes(3);
    expect(m.query.mock.calls.some(([text]) => text.includes('shared_odds'))).toBe(false);
  });

  it("keeps a legacy live hit at one SELECT with no weather/provider work", async () => {
    await start(false);
    const legacyPayload = { oddsByBookmaker: [{ bookmakerKey: "book", point: 200, overPrice: 1.9, underPrice: 1.8 }],
      weather: { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 } };
    m.query.mockResolvedValueOnce([{ payload: legacyPayload, fetched_at: new Date().toISOString() }]);
    const { getSharedLivePropInputs } = await import("./livePropCacheRepo");
    expect(await getSharedLivePropInputs(key, context)).toEqual(legacyPayload);
    expect(m.query).toHaveBeenCalledOnce();
    expect(m.weather).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
    expect(m.legacy).not.toHaveBeenCalled();
  });

  it.each(["cold", "forced-cooldown", "forced-stale", "failure"])("keeps current-schema discovery %s behavior", async kind => {
    await start(false);
    const cachedAt = new Date(Date.now() - (kind === "forced-cooldown" ? 10_000 : 30_000)).toISOString();
    m.query.mockResolvedValueOnce(kind.startsWith("forced")
      ? [{ market_key: key.marketKey, payload, fetched_at: cachedAt }] : []).mockResolvedValue([]);
    if (kind === "failure") m.event.mockRejectedValue(new Error("legacy provider unavailable"));
    else m.event.mockResolvedValue({ data: { id: key.eventId, ...payload, commence_time: context.startTime, home_team: "Home", away_team: "Away" }, capturedAt,
      quota: { remaining: 10, used: 1, last: 1 } });
    const { getOrFetchMarketOdds } = await import("./oddsCacheRepo");
    const pending = getOrFetchMarketOdds(key.sportKey, key.eventId, [key.marketKey], { forceRefresh: kind.startsWith("forced") });
    if (kind === "failure") {
      await expect(pending).rejects.toThrow("legacy provider unavailable");
      expect(m.query).toHaveBeenCalledOnce();
    } else {
      const result = await pending;
      expect(result.origins[key.marketKey].status).toBeUndefined();
      expect(result.origins[key.marketKey].origin).toBe(kind === "forced-cooldown" ? "cache" : "upstream");
      expect(m.query).toHaveBeenCalledTimes(kind === "forced-cooldown" ? 1 : 2);
    }
    expect(m.event).toHaveBeenCalledTimes(kind === "forced-cooldown" ? 0 : 1);
    expect(m.query.mock.calls.some(([text]) => text.includes("shared_odds"))).toBe(false);
    expect(m.weather).not.toHaveBeenCalled();
  });

  it("rejects invalid shared identities before cache or provider work", async () => {
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    await expect(getSharedMarketOdds("basketball_nba", "event", keys)).rejects.toThrow("Only americanfootball_nfl");
    await expect(getSharedMarketOdds(key.sportKey, "../event", keys)).rejects.toThrow("Invalid eventId");
    await expect(getSharedMarketOdds(key.sportKey, "event", ["bad-market"])).rejects.toThrow("Unknown player-prop");
    expect(m.query).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });
});
