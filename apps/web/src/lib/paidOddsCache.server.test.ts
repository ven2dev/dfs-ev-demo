import { describe, expect, it, vi } from "vitest";
import { getSharedOddsBatch, getOrRefresh } from "@dfs-ev/db/runtime";
import { createPaidOddsBoundary } from "./paidOddsBoundary";
import { InteractiveQuotaUnavailable } from "./providerQuota";
const key = "v1:anonymous-network:" + "a".repeat(64);
const market = "player_pass_yds", payload = { bookmakers: [] };
const make = (outcome = "subject-rate-limit") => {
  const statements: string[] = [];let fresh = false;
  const fetchedAt = new Date(Date.now() - 600_000).toISOString();
  const request = { resolveSubject: vi.fn(async () => [{ keys: [key], report: key, intervalMs: 1000, burst: 1, traffic: "anonymous" as const }]) };
  const boundary = createPaidOddsBoundary({ enforce: true, reserve: () => 100, initialize: async () => "ready", warn: vi.fn(),
    fallbackFloor: vi.fn(), query: async sql => { statements.push(sql);return [{ outcome, retry_after_ms: outcome === "subject-rate-limit" ? "10000" : "0", denied_subjects: outcome === "subject-rate-limit" ? [key] : [], warning: null, quota_remaining: 500, would_deny: false }]; } });
  const beforeClaim = vi.fn(() => boundary.beforeClaim(request));
  const query = async (sql: string) => {
    statements.push(sql);
    if (sql.includes("claim_shared_odds_batch")) return [{ outcome: "leader", owned_keys: [market], resources: {
      [market]: { state: "pending", payload, fetchedAt } } }];
    if (sql.includes("SELECT market_key")) return [{ market_key: market, payload, fetched_at: fresh ? new Date().toISOString() : fetchedAt, fresh }];
    return [];
  };
  const batch = () => getSharedOddsBatch("fixture", [market], {
    query, shouldDenyRefresh: beforeClaim,
    fetch: async () => { await boundary.check(request);throw new Error("denied send reached transport"); },
    makeOwnerId: () => "owner", monotonicNow: () => performance.now(), wait: async () => {},
    isFetchUnavailable: error => error instanceof InteractiveQuotaUnavailable,
    refusalReason: error => error instanceof InteractiveQuotaUnavailable ? error.reason : undefined,
  }, { ttlMs: 90_000 });
  return { statements, fetchedAt, batch, beforeClaim, request, setFresh: () => { fresh = true; } };
};
describe("#223 actual cache kernel denial work", () => {
  it("repeat denied requests add zero claim/admission/release SQL after the existing freshness read", async () => {
    const s = make();const first = await s.batch();expect(first[market].state).toBe("stale");
    expect(s.statements).toHaveLength(4);expect(s.statements.at(-1)).toContain("release_shared_odds_limiter_denial");
    s.statements.length = 0;
    const second = await s.batch();expect(second[market]).toMatchObject({ state: "stale", fetchedAt: s.fetchedAt });
    expect(s.statements).toHaveLength(1);expect(s.statements[0]).toContain("SELECT market_key");
  });
  it("quota-floor refusal uses ordinary release and never shortcuts later claims", async () => {
    const s = make("quota-floor");await s.batch();expect(s.statements.at(-1)).toBe("SELECT public.release_shared_odds_batch($1,$2,$3)");
    s.statements.length = 0;await s.batch();expect(s.statements).toHaveLength(4);
  });
  it("a fresh hit ignores deny cache, does one existing SELECT and resolves no subject", async () => {
    const s = make();await s.batch();s.statements.length = 0;s.beforeClaim.mockClear();s.request.resolveSubject.mockClear();s.setFresh();
    expect((await s.batch())[market].state).toBe("fresh");expect(s.statements).toHaveLength(1);
    expect(s.beforeClaim).not.toHaveBeenCalled();expect(s.request.resolveSubject).not.toHaveBeenCalled();
  });
  it("generic live cache returns a stale shortcut before claiming, without writing/re-aging", async () => {
    const tryAcquireRefresh = vi.fn(), fetchFresh = vi.fn(), write = vi.fn(), release = vi.fn();
    const result = await getOrRefresh({ sportKey: "nfl", eventId: "fixture", marketKey: market, playerName: "fixture" }, {
      read: async () => ({ payload, fetchedAtMs: 0 }), beforeClaim: async () => ({ payload }),
      tryAcquireRefresh, fetchFresh, write, release, renew: vi.fn(), makeOwnerId: () => "unused", now: () => 100000, wait: async () => {},
    }, { ttlMs: 1000 });
    expect(result).toBe(payload);expect(tryAcquireRefresh).not.toHaveBeenCalled();expect(fetchFresh).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
  });
});
