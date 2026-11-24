import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getSharedOddsBatch, type AdmissionQuery } from "@dfs-ev/db/runtime";
import type { LivePropInputs, LivePropFetchContext } from "./livePropCacheRepo";
import type { fetchPlayerPropMarketOdds } from "./oddsApi";
import type { fetchSharedPlayerPropOdds } from "./sharedOddsRepo";

const m = vi.hoisted(() => ({
  mode: "legacy", query: vi.fn(), verify: vi.fn(),
  legacy: vi.fn<typeof fetchPlayerPropMarketOdds>(), shared: vi.fn<typeof fetchSharedPlayerPropOdds>(),
  weather: vi.fn(), cached: null as LivePropInputs | null, fresh: false,
}));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./firebaseAdmin", () => ({ getAdminAuth: () => ({ verifyIdToken: m.verify }) }));
vi.mock("./config.server", () => ({ serverConfig: {
  paidOddsMode: () => "log-only",
  environment: () => "production", databaseConfigured: () => true,
  collectorHealth: () => ({ quotaReserve: 100 }),
  paidOdds: () => ({ keyring: [{ version: "v1", keyHex: "11".repeat(32) }], policies: {
    anonymousNetwork: { intervalMs: 1000, burst: 1 }, signedNetwork: { intervalMs: 1000, burst: 100 },
    user: { intervalMs: 1000, burst: 2 },
  } }),
} }));
vi.mock("./oddsCacheStartup", () => ({
  selectOddsCachePath: async <T,>(legacy: T, shared: T) => m.mode === "legacy" ? legacy : shared,
  initializeOddsCache: async () => m.mode,
}));
vi.mock("./oddsApi", () => ({ fetchPlayerPropMarketOdds: m.legacy }));
vi.mock("./sharedOddsRepo", () => ({ fetchSharedPlayerPropOdds: m.shared }));
vi.mock("./weather", () => ({ fetchGameWeather: m.weather }));
vi.mock("./oddsSnapshotRepo", () => ({ persistOddsObservation: vi.fn() }));
import { getSharedLivePropInputs } from "./livePropCacheRepo";
import { createPaidRefreshRequest, createPaidOddsBoundary, type PaidRefreshRequest } from "./paidOddsBoundary";
import { openLiveStream } from "./liveStream";

const key = { sportKey: "americanfootball_nfl", eventId: "fixture", marketKey: "player_pass_yds", playerName: "Fixture" };
const request = (headers: Headers) => createPaidRefreshRequest({ headers } as NextRequest);
const context = (): LivePropFetchContext => ({
  startTime: "2030-01-01T00:00:00Z", homeTeam: "Home", awayTeam: "Away", venueLat: 0, venueLon: 0,
  paidRequest: request(new Headers({ "x-vercel-forwarded-for": "203.0.113.7", Authorization: "Bearer synthetic" })),
});
const fetched = () => ({
  capturedAt: new Date().toISOString(), quota: { remaining: 1000, used: 1, last: 1 },
  data: { response: null, oddsByBookmaker: [{ bookmakerKey: "fixture", point: 10, overPrice: 2, underPrice: 2 }] },
});
beforeEach(() => {
  m.fresh = false;m.cached = null;
  m.query.mockReset();m.verify.mockReset().mockResolvedValue({ uid: "fixture-user", exp: Math.floor(Date.now() / 1000) + 3600 });
  m.weather.mockReset().mockResolvedValue({ temperatureF: 60, windSpeedMph: 0, precipitationMm: 0 });
  m.query.mockImplementation(async (sql: string, params: readonly unknown[]) => {
    if (sql.includes("SELECT payload")) return m.cached ? [{ payload: m.cached, fetched_at: new Date(m.fresh ? Date.now() : 0) }] : [];
    if (sql.includes("SET payload")) { m.cached = JSON.parse(params[5] as string);m.fresh = true; }
    return [{ event_id: "fixture" }];
  });
  m.legacy.mockReset().mockImplementation(async (...args) => {
    expect(await args[6]!.resolveSubject()).toHaveLength(2);return fetched();
  });
  m.shared.mockReset().mockImplementation(async (...args) => {
    expect(await args[5]!.paidRequest!.resolveSubject()).toHaveLength(2);return fetched();
  });
});
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });

describe("#299 live attribution work budgets", () => {
  it.each(["legacy", "shared"])("%s forwards the exact paid context and fresh reconnect adds only one existing read", async mode => {
    m.mode = mode;
    const ctx = context();
    expect((await getSharedLivePropInputs(key, ctx)).oddsByBookmaker).toHaveLength(1);
    expect(m.verify).toHaveBeenCalledTimes(1);expect(m.query).toHaveBeenCalledTimes(3);
    expect(m.weather).toHaveBeenCalledTimes(1);
    if (mode === "legacy") expect(m.legacy.mock.calls[0][6]).toBe(ctx.paidRequest);
    else expect(m.shared.mock.calls[0][5]!.paidRequest).toBe(ctx.paidRequest);
    m.query.mockClear();m.verify.mockClear();
    await getSharedLivePropInputs(key, context());
    expect(m.query).toHaveBeenCalledTimes(1);expect(m.verify).not.toHaveBeenCalled();
    expect(m.legacy.mock.calls.length + m.shared.mock.calls.length).toBe(1);
    expect(m.weather).toHaveBeenCalledTimes(1);
  });
  it.each(["legacy", "shared"])("%s fresh hits add no token verification, odds or weather work", async mode => {
    m.mode = mode;m.fresh = true;
    m.cached = { ...fetched().data, weather: { temperatureF: 60, windSpeedMph: 0, precipitationMm: 0 } };
    await getSharedLivePropInputs(key, context());
    expect(m.query).toHaveBeenCalledTimes(1);expect(m.verify).not.toHaveBeenCalled();
    expect(m.weather).not.toHaveBeenCalled();expect(m.legacy).not.toHaveBeenCalled();expect(m.shared).not.toHaveBeenCalled();
  });
  it("two fetch/SSE clients share one cache-kernel paid send; fresh reconnect adds no admission or send", async () => {
    let fresh = true, claimed = false, reads = 0, claims = 0, admissions = 0, sends = 0, publishes = 0;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const query = vi.fn<AdmissionQuery>().mockImplementation(async () => {
      admissions++;
      return [{ outcome: "allow", retry_after_ms: "0", denied_subjects: [], warning: null, quota_remaining: 1000, would_deny: false }];
    });
    const boundary = createPaidOddsBoundary({ initialize: async () => "ready", query, sharedCacheReady: async () => true,
      enforce: false, reserve: () => 100, fallbackFloor: vi.fn(), warn: vi.fn() });
    const run = (paidRequest: PaidRefreshRequest) => getSharedOddsBatch("fixture", ["player_pass_yds"], {
      makeOwnerId: () => "owner", monotonicNow: () => performance.now(), wait: async () => { await hold; },
      shouldDenyRefresh: () => boundary.beforeClaim(paidRequest),
      query: async sql => {
        if (sql.includes("SELECT market_key")) {
          reads++;
          return fresh ? [{ market_key: "player_pass_yds", fresh: true, payload: { bookmakers: [] }, fetched_at: new Date().toISOString() }] : [];
        }
        if (sql.includes("claim_shared_odds_batch")) {
          claims++;
          if (claimed) return [{ outcome: "follower", owned_keys: [], resources: {} }];
          claimed = true;return [{ outcome: "leader", owned_keys: ["player_pass_yds"], resources: {} }];
        }
        if (sql.includes("publish_shared_odds_batch")) { publishes++;fresh = true;release(); }
        return [];
      },
      fetch: async () => {
        await boundary.check(paidRequest);sends++;
        return { player_pass_yds: { bookmakers: [] } };
      },
    }, { ttlMs: 90_000 });
    let headerLookups = 0, fetches = 0, deliveries = 0;
    const attempt = async (signed: boolean) => {
      const stream = openLiveStream({
        url: "/api/stream?eventId=fixture",
        getHeaders: async () => { headerLookups++;return new Headers(signed ? { Authorization: "Bearer synthetic" } : undefined); },
        fetch: async (_url, options) => {
          fetches++;
          const headers = new Headers(options?.headers);headers.set("x-vercel-forwarded-for", "203.0.113.7");
          const batch = await run(request(headers));
          return new Response(`data: ${JSON.stringify({ type: "tick", payload: batch })}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
        isCurrent: () => true, onOpen: vi.fn(), onData: () => { deliveries++; }, onFailure: vi.fn(),
      });
      await stream.done;
    };
    await attempt(true);
    expect(reads).toBe(1);expect(m.verify).not.toHaveBeenCalled();expect(admissions).toBe(0);
    fresh = false;
    await Promise.all([attempt(true), attempt(false)]);
    expect({ admissions, sends, publishes }).toEqual({ admissions: 1, sends: 1, publishes: 1 });
    expect(m.verify).toHaveBeenCalledTimes(1);
    const before = { reads, claims, admissions, sends };
    await attempt(true);
    expect(reads - before.reads).toBe(1);expect(claims).toBe(before.claims);
    expect(admissions).toBe(before.admissions);expect(sends).toBe(before.sends);
    expect(m.verify).toHaveBeenCalledTimes(1);
    expect({ headerLookups, fetches, deliveries }).toEqual({ headerLookups: 4, fetches: 4, deliveries: 4 });
  });
});
