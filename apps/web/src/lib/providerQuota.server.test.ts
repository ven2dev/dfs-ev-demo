import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKABLE_PLAYER_PROP_MARKET_KEYS } from "./playerPropMarkets";
const m = vi.hoisted(() => ({ query: vi.fn(), fetch: vi.fn(), telemetry: vi.fn() }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./oddsApiTelemetryRepo", () => ({ recordOddsApiRequest: m.telemetry }));
const key = "player_pass_yds";
const threshold = 100 + TRACKABLE_PLAYER_PROP_MARKET_KEYS.length;
beforeEach(() => {
  vi.resetModules(); Object.values(m).forEach(mock => mock.mockReset());
  vi.stubEnv("ODDS_DATA_SOURCE", "live"); vi.stubEnv("ODDS_API_KEY", "synthetic-key");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@database.invalid/synthetic");
  vi.stubEnv("ODDS_COLLECTION_QUOTA_RESERVE", "100");
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockImplementation(async () => new Response(JSON.stringify({ id: "event", bookmakers: [] }), {
    headers: { "x-requests-remaining": "500", "x-requests-used": "1", "x-requests-last": "1" },
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("single paid-call entry and observed interactive quota floor", () => {
  it.each([0, threshold - 1, threshold])("refuses remaining=%s at/below the collector cushion with one indexed read", async remaining => {
    m.query.mockResolvedValue([{ remaining, used: 500, age_seconds: 2 }]);
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", [key])).rejects.toMatchObject({ reason: "quota-floor" });
    expect(m.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("ORDER BY requested_at DESC LIMIT 1"), []);
    expect(m.fetch).not.toHaveBeenCalled(); expect(m.telemetry).not.toHaveBeenCalled();
  });
  it.each([{ rows: [] }, { rows: [{ remaining: threshold + 1, used: 1, age_seconds: 2 }] }])("allows a missing or above-floor reading: %j", async ({ rows }) => {
    m.query.mockResolvedValue(rows); const { fetchEventOdds } = await import("./oddsApi");
    await fetchEventOdds("americanfootball_nfl", "event", [key]);
    expect(m.query).toHaveBeenCalledOnce(); expect(m.fetch).toHaveBeenCalledOnce();
    expect(m.telemetry).toHaveBeenCalledOnce();
    expect(m.telemetry.mock.calls[0][0].quota).toEqual({ remaining: 500, used: 1, last: 1 });
  });
  it("a first response supplies the next call's reading; no application snapshot or extra write", async () => {
    m.query.mockResolvedValueOnce([]).mockResolvedValue([{ remaining: 0, used: 500, age_seconds: 0 }]);
    const { fetchEventOdds } = await import("./oddsApi");
    await fetchEventOdds("americanfootball_nfl", "event", [key]);
    await expect(fetchEventOdds("americanfootball_nfl", "event", [key])).rejects.toMatchObject({ reason: "quota-floor" });
    expect(m.query).toHaveBeenCalledTimes(2); expect(m.fetch).toHaveBeenCalledOnce(); expect(m.telemetry).toHaveBeenCalledOnce();
  });
  it("collector checkpoint calls add no floor read and bind the canonical market set", async () => {
    const { fetchEventOdds } = await import("./oddsApi");
    const context = { kind: "collector" as const, checkpointId: "checkpoint", ownerId: "owner",
      deadline: performance.now() + 15_000, marketKeys: [key] };
    await fetchEventOdds("americanfootball_nfl", "event", [key], undefined, "scheduled", context);
    expect(m.query).not.toHaveBeenCalled(); expect(m.fetch).toHaveBeenCalledOnce();
    await expect(fetchEventOdds("americanfootball_nfl", "event", ["player_receptions"], undefined, "scheduled", context)).rejects.toThrow("checkpoint");
    expect(m.fetch).toHaveBeenCalledOnce();
  });
  it("a scheduled telemetry label alone cannot bypass the interactive floor", async () => {
    m.query.mockResolvedValue([{ remaining: 0, used: 500, age_seconds: 0 }]);
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", [key], undefined, "scheduled")).rejects.toMatchObject({ reason: "quota-floor" });
    expect(m.query).toHaveBeenCalledOnce(); expect(m.fetch).not.toHaveBeenCalled();
  });
  it("allows a failed read with one reason-only warning and no unavailable fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.query.mockRejectedValue(new Error("SELECT private SQL; postgresql://private:credential@target.invalid/database"));
    const { fetchEventOdds } = await import("./oddsApi");
    const result = await fetchEventOdds("americanfootball_nfl", "event", [key]);
    expect(result.data).toMatchObject({ id: "event", bookmakers: [] });
    expect(result).not.toHaveProperty("sharedObservation");
    expect(m.query).toHaveBeenCalledOnce(); expect(m.fetch).toHaveBeenCalledOnce();
    expect(m.telemetry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[providerQuota] quota-read-failed");
    const { readQuotaHealth } = await import("./providerQuota");
    expect(await readQuotaHealth()).toEqual({ status: "unavailable", remaining: null, used: null, ageSeconds: null });
    expect(warn).toHaveBeenCalledOnce(); // Health visibility adds no refresh warning.
  });
  it("rechecks owner deadline after a delayed quota read and does no retry", async () => {
    m.query.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2)); return []; });
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", [key], undefined, "live", { kind: "raw", ownerId: "owner", deadline: 0 })).rejects.toThrow("deadline");
    expect(m.fetch).not.toHaveBeenCalled(); expect(m.query).toHaveBeenCalledOnce();
  });
  it("free events make no floor query", async () => {
    m.fetch.mockResolvedValueOnce(new Response("[]")); const { fetchSlateEvents } = await import("./oddsApi");
    await fetchSlateEvents("americanfootball_nfl"); expect(m.query).not.toHaveBeenCalled();
  });
  it("quota health reports missing state as unavailable, not zero", async () => {
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ remaining: 0, used: 500, age_seconds: 12 }]);
    const { readQuotaHealth } = await import("./providerQuota");
    expect(await readQuotaHealth()).toEqual({ status: "unavailable", remaining: null, used: null, ageSeconds: null });
    expect(await readQuotaHealth()).toEqual({ status: "available", remaining: 0, used: 500, ageSeconds: 12 });
  });
});
