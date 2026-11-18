import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), fetch: vi.fn(), telemetry: vi.fn() }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./oddsSnapshotRepo", () => ({ persistOddsObservation: async () => ({ inserted: true }) }));
vi.mock("./oddsApiTelemetryRepo", () => ({ recordOddsApiRequest: m.telemetry }));
const key = "player_pass_yds";
const payload = { bookmakers: [] };
beforeEach(() => {
  vi.resetModules(); Object.values(m).forEach(mock => mock.mockReset());
  vi.stubEnv("ODDS_DATA_SOURCE", "live"); vi.stubEnv("ODDS_API_KEY", "synthetic-key");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@database.invalid/synthetic");
  vi.stubEnv("ODDS_COLLECTION_QUOTA_RESERVE", "100"); vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("quota floor is paid-leader-only and never re-ages stale odds", () => {
  it("a fresh shared cache hit adds no quota SQL", async () => {
    m.query.mockResolvedValue([{ market_key: key, payload, fresh: true, fetched_at: new Date().toISOString() }]);
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    expect((await getSharedMarketOdds("americanfootball_nfl", "event", [key])).origins[key].status).toBe("fresh");
    expect(m.query).toHaveBeenCalledOnce(); expect(m.fetch).not.toHaveBeenCalled();
    expect(m.query.mock.calls[0][0]).not.toContain("odds_api_request_log");
  });
  it.each([true, false])("denied shared refresh returns prior=%s as stale/unavailable; followers add no quota read", async prior => {
    const fetchedAt = "2026-10-05T12:00:00.000Z";
    let claimed = false;
    m.query.mockImplementation(async (text: string) => {
      if (text.includes("SELECT market_key")) return [];
      if (text.includes("claim_shared")) {
        const follower = claimed; claimed = true;
        return [{ outcome: follower ? "complete" : "leader", owned_keys: [key], resources: {
          [key]: { state: prior ? "stale" : "unavailable", payload: prior ? payload : null, fetchedAt: prior ? fetchedAt : null },
        } }];
      }
      if (text.includes("odds_api_request_log")) return [{ remaining: 0, used: 500, age_seconds: 3 }];
      if (text.includes("release_shared")) return [];
      throw new Error("Denied refresh cannot publish or write");
    });
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    for (let i = 0; i < 2; i++) {
      const result = await getSharedMarketOdds("americanfootball_nfl", "event", [key], { forceRefresh: true });
      expect(result.origins[key]).toMatchObject({ status: prior ? "stale" : "unavailable", capturedAt: prior ? fetchedAt : null });
    }
    expect(m.query.mock.calls.filter(([text]) => text.includes("odds_api_request_log"))).toHaveLength(1);
    expect(m.query).toHaveBeenCalledTimes(6); // leader read/claim/quota/release + follower read/claim
    expect(m.fetch).not.toHaveBeenCalled(); expect(m.telemetry).not.toHaveBeenCalled();
  });
  it("a fresh legacy cache hit adds no quota SQL", async () => {
    m.query.mockResolvedValue([{ market_key: key, payload, fetched_at: new Date().toISOString() }]);
    const { getLegacyMarketOdds } = await import("./oddsCacheRepo");
    await getLegacyMarketOdds("americanfootball_nfl", "event", [key]);
    expect(m.query).toHaveBeenCalledOnce(); expect(m.fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])("legacy denial returns flagged prior=%s without a cache write", async prior => {
    m.query.mockImplementation(async (text: string) => text.includes("odds_api_request_log")
      ? [{ remaining: 0, used: 500, age_seconds: 3 }]
      : prior ? [{ market_key: key, payload, fetched_at: "2026-10-05T12:00:00.000Z" }] : []);
    const { getLegacyMarketOdds } = await import("./oddsCacheRepo");
    const result = await getLegacyMarketOdds("americanfootball_nfl", "event", [key]);
    expect(result.origins[key]).toMatchObject({ status: prior ? "stale" : "unavailable", capturedAt: prior ? "2026-10-05T12:00:00.000Z" : null });
    expect(m.query).toHaveBeenCalledTimes(2); expect(m.fetch).not.toHaveBeenCalled();
  });
  it("failed quota read fetches and publishes upstream data instead of taking stale fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.query.mockImplementation(async (text: string) => {
      if (text.includes("SELECT market_key")) return [];
      if (text.includes("claim_shared")) return [{ outcome: "leader", owned_keys: [key], resources: {
        [key]: { state: "pending", payload, fetchedAt: "2026-10-05T12:00:00.000Z" },
      } }];
      if (text.includes("odds_api_request_log")) throw new Error("private SQL and connection marker");
      if (text.includes("publish_shared")) return [];
      throw new Error("Unexpected fallback/release work");
    });
    m.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "event", bookmakers: [],
      commence_time: "2099-01-01T00:00:00Z", home_team: "Home", away_team: "Away" })));
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    const result = await getSharedMarketOdds("americanfootball_nfl", "event", [key]);
    expect(result.origins[key]).toMatchObject({ origin: "upstream", status: "upstream" });
    expect(m.query.mock.calls.filter(([text]) => text.includes("publish_shared"))).toHaveLength(1);
    expect(m.query).toHaveBeenCalledTimes(4); // read, claim, failed quota read, publish
    expect(m.fetch).toHaveBeenCalledOnce(); expect(m.telemetry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[providerQuota] quota-read-failed");
  });

});
