import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeProviderCreditPermit } from "@dfs-ev/db/runtime";
import { createPaidOddsBoundary } from "./providerCreditBoundary";
const m = vi.hoisted(() => ({ query: vi.fn(), fetch: vi.fn(), telemetry: vi.fn(), persist: vi.fn() }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./oddsApiTelemetryRepo", () => ({ recordOddsApiRequest: m.telemetry }));
vi.mock("./oddsSnapshotRepo", () => ({ persistOddsObservation: m.persist }));
const quota = { last: 1, remaining: 99, used: 1 };
const owner = { kind: "raw" as const, ownerId: "owner", deadline: 100 };
const fixture = (mode: "log-only" | "enforce" = "enforce") => {
  const query = vi.fn(async (_text: string, params: unknown[]) => [{ result: { outcome: "reserved", allowed: true,
    reason: "reserved", reservationId: params[0], cost: 1, availableCredits: 100, period: "2026-11" } }]);
  const onFailure = vi.fn();
  const boundary = createPaidOddsBoundary({ query, mode, now: () => 0, date: () => new Date("2026-11-17T12:00:00Z"),
    makeId: () => "attempt", onFailure });
  return { query, onFailure, boundary };
};
beforeEach(() => {
  vi.resetModules(); Object.values(m).forEach(mock => mock.mockReset());
  vi.stubEnv("ODDS_DATA_SOURCE", "live"); vi.stubEnv("ODDS_API_KEY", "synthetic-key");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@database.invalid/synthetic");
  vi.stubGlobal("fetch", m.fetch);
  m.persist.mockResolvedValue({ inserted: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("paid boundary orchestration", () => {
  it("reserves once, then reconciles known HTTP metadata once", async () => {
    const f = fixture();
    const send = await f.boundary("americanfootball_nfl", "event", ["a"], undefined, owner);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(consumeProviderCreditPermit(send.permit)).toMatchObject({ authoritative: true });
    f.query.mockResolvedValueOnce([{ result: { outcome: "settled" } }] as never);
    await send.reconcile(quota);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1]).toEqual([expect.stringContaining("reconcile"), ["attempt", 1, 99, 1, "2026-11"]]);
  });
  it("missing cost keeps full liability with zero invented settlement", async () => {
    const f = fixture(); const send = await f.boundary("americanfootball_nfl", "event", ["a"], undefined, owner);
    await send.reconcile({ ...quota, last: null }); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("reconcile storage failure cannot trigger a resend or propagate private details", async () => {
    const f = fixture(); const send = await f.boundary("americanfootball_nfl", "event", ["a"], undefined, owner);
    f.query.mockRejectedValueOnce(new Error("private credential"));
    await expect(send.reconcile(quota)).resolves.toBeUndefined();
    expect(f.query).toHaveBeenCalledTimes(2); expect(f.onFailure).toHaveBeenCalledExactlyOnceWith("reconcile");
  });
  it("enforce refuses ownerless direct calls before accounting", async () => {
    const f = fixture(); await expect(f.boundary("americanfootball_nfl", "event", ["a"])).rejects.toThrow("owner");
    expect(f.query).not.toHaveBeenCalled();
  });
  it("binds collector identity separately from public telemetry source and canonical cost", async () => {
    const f = fixture(); await f.boundary("americanfootball_nfl", "event", ["a"], undefined,
      { kind: "collector", checkpointId: "checkpoint", ownerId: "collector", deadline: 100 });
    expect(f.query.mock.calls[0][1]).toEqual(["attempt", "enforce", "collector", "checkpoint", "collector", "americanfootball_nfl", ["a"], 1, "2026-11"]);
  });
  it("real direct transport shadows once; scheduled telemetry alone remains raw", async () => {
    m.query.mockRejectedValue(new Error("fixture storage failure"));
    m.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "event", bookmakers: [] }), { headers: { "x-requests-last": "1" } }));
    const { fetchEventOdds } = await import("./oddsApi");
    await fetchEventOdds("americanfootball_nfl", "event", ["player_pass_yds"], undefined, "scheduled");
    expect(m.fetch).toHaveBeenCalledOnce(); expect(m.query).toHaveBeenCalledOnce();
    expect(m.query.mock.calls[0][1][2]).toBe("raw");
  });
  it("free events make no reservation, even with storage unavailable", async () => {
    m.fetch.mockResolvedValue(new Response("[]")); const { fetchSlateEvents } = await import("./oddsApi");
    await fetchSlateEvents("americanfootball_nfl"); expect(m.query).not.toHaveBeenCalled(); expect(m.fetch).toHaveBeenCalledOnce();
  });
  it("aborted calls do no SQL and no paid fetch", async () => {
    const controller = new AbortController(); controller.abort();
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", ["player_pass_yds"], controller.signal)).rejects.toThrow();
    expect(m.query).not.toHaveBeenCalled(); expect(m.fetch).not.toHaveBeenCalled();
  });
  it.each(["http", "decode", "network"])("%s failure makes one paid attempt and never retries", async kind => {
    m.query.mockRejectedValue(new Error("fixture storage unavailable"));
    if (kind === "network") m.fetch.mockRejectedValue(new Error("network failure"));
    else m.fetch.mockResolvedValue(new Response(kind === "decode" ? "invalid JSON" : "{}", { status: kind === "http" ? 429 : 200,
      headers: { "x-requests-last": "1", "x-requests-remaining": "99", "x-requests-used": "1" } }));
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", ["player_pass_yds"])).rejects.toThrow();
    expect(m.fetch).toHaveBeenCalledOnce(); expect(m.query).toHaveBeenCalledOnce();
    expect(m.telemetry.mock.calls[0][0].quota).toEqual(kind === "network" ? { last: null, remaining: null, used: null } : quota);
  });
  it("real shared leader forwards its owner, reserves once, and publishes empty absent market", async () => {
    m.query.mockImplementation(async (text, params) => {
      if (text.includes("SELECT market_key")) return [];
      if (text.includes("claim_shared")) return [{ outcome: "leader", owned_keys: ["player_pass_yds"], resources: {} }];
      if (text.includes("provider_credit.reserve")) return [{ result: { outcome: "shadow", allowed: false, reason: "uninitialized", reservationId: params[0], cost: 1, availableCredits: null, period: null } }];
      return [];
    });
    m.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "event", bookmakers: [] })));
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    const result = await getSharedMarketOdds("americanfootball_nfl", "event", ["player_pass_yds"]);
    expect(result.origins.player_pass_yds.status).toBe("upstream");
    expect(m.fetch).toHaveBeenCalledOnce();
    const claim = m.query.mock.calls.find(([text]) => text.includes("claim_shared"))!;
    const reserves = m.query.mock.calls.filter(([text]) => text.includes("provider_credit.reserve"));
    expect(reserves).toHaveLength(1); expect(reserves[0][1][4]).toBe(claim[1][2]);
    expect(m.query.mock.calls.filter(([text]) => text.includes("publish_shared"))).toHaveLength(1);
  });
  it.each(["http", "decode"])("enforced %s response reconciles headers before returning/throwing", async kind => {
    const boundaryModule = await import("./providerCreditBoundary");
    const query = vi.fn(async (text: string, params: unknown[]) => text.includes("reserve")
      ? [{ result: { outcome: "reserved", allowed: true, reason: "reserved", reservationId: params[0], cost: 1, availableCredits: 100, period: "2026-11" } }]
      : [{ result: { outcome: "settled" } }]);
    const boundary = boundaryModule.createPaidOddsBoundary({ query, mode: "enforce", now: () => 0,
      date: () => new Date("2026-11-17T12:00:00Z"), makeId: () => "attempt", onFailure: vi.fn() });
    const spy = vi.spyOn(boundaryModule, "reservePaidOdds").mockImplementation(boundary);
    m.fetch.mockResolvedValue(new Response(kind === "decode" ? "invalid JSON" : "{}", {
      status: kind === "http" ? 429 : 200,
      headers: { "x-requests-last": "1", "x-requests-remaining": "99", "x-requests-used": "1" },
    }));
    const { fetchEventOdds } = await import("./oddsApi");
    await expect(fetchEventOdds("americanfootball_nfl", "event", ["player_pass_yds"], undefined, "live", owner)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual(["attempt", 1, 99, 1, "2026-11"]);
    expect(m.fetch).toHaveBeenCalledOnce();
    expect(m.telemetry.mock.calls[0][0].id).toBe("attempt"); spy.mockRestore();
  });
  it.each(["fresh", "cooldown"])("shared %s returns without reservation or send", async state => {
    const payload = { bookmakers: [] };
    m.query.mockImplementation(async (text: string) => {
      if (text.includes("SELECT market_key")) return state === "fresh"
        ? [{ market_key: "player_pass_yds", payload, fresh: true, fetched_at: "2026-11-17T12:00:00Z" }] : [];
      if (text.includes("claim_shared")) return [{ outcome: "complete", owned_keys: [], resources: {
        player_pass_yds: { state: "stale", payload, fetchedAt: "2026-11-17T12:00:00Z" },
      } }];
      throw new Error("unexpected accounting");
    });
    const { getSharedMarketOdds } = await import("./sharedOddsRepo");
    await getSharedMarketOdds("americanfootball_nfl", "event", ["player_pass_yds"]);
    expect(m.query).toHaveBeenCalledTimes(state === "fresh" ? 1 : 2);
    expect(m.query.mock.calls.some(([text]) => text.includes("provider_credit"))).toBe(false);
    expect(m.fetch).not.toHaveBeenCalled();
  });

});
