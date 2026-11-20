import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn(), getAuth: vi.fn(), sdkLoads: vi.fn() }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./firebaseAdmin", () => {
  m.sdkLoads();
  return { getAdminAuth: m.getAuth.mockImplementation(() => ({ verifyIdToken: m.verify })) };
});
vi.mock("./config.server", () => ({ serverConfig: {
  environment: () => "production", databaseConfigured: () => true,
  collectorHealth: () => ({ quotaReserve: 100 }),
  paidOdds: () => ({ keyring: [{ version: "v1", keyHex: "11".repeat(32) }], policies: {
    anonymousNetwork: { intervalMs: 1000, burst: 1 }, signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 2 } } }),
} }));
import { createPaidOddsBoundary, checkPaidOddsAdmission, createPaidRefreshRequest, paidOddsHealth } from "./paidOddsBoundary";
import type { PaidAdmission } from "@dfs-ev/db/runtime";
import type { NextRequest } from "next/server";
const key = (kind: string, ch = "a") => `v1:${kind}:` + ch.repeat(64);
const dims = [{ keys: [key("anonymous-network")], report: key("anonymous-network"), intervalMs: 1000, burst: 1, traffic: "anonymous" as const }];
const row = (outcome: PaidAdmission["outcome"] = "allow") => ({ outcome, retry_after_ms: outcome === "subject-rate-limit" ? "1000" : "0", denied_subjects: outcome === "subject-rate-limit" ? dims[0].keys : [], warning: null, quota_remaining: 500, would_deny: false });
const setup = (enforce = true) => {
  let now = 0;const query = vi.fn().mockResolvedValue([row()]), floor = vi.fn(), warn = vi.fn(), initialize = vi.fn().mockResolvedValue("ready");
  const boundary = createPaidOddsBoundary({ query, fallbackFloor: floor, warn, initialize, reserve: () => 100, enforce, now: () => now, maxDeniedSubjects: 2 });
  return { boundary, query, floor, warn, initialize, time: (n: number) => { now = n; }, request: { resolveSubject: vi.fn(async () => dims) } };
};
afterEach(() => vi.restoreAllMocks());
describe("#223 paid boundary and advisory deny cache", () => {
  it("importing the provider/collector transport does not load Firebase Admin", async () => {
    await import("./oddsApi");
    expect(m.sdkLoads).not.toHaveBeenCalled();expect(m.getAuth).not.toHaveBeenCalled();
  });
  it("signed-in subject checks signature/expiry only, never revocation, and coalesces verification", async () => {
    m.verify.mockResolvedValue({ uid: "synthetic-user" });
    const request = createPaidRefreshRequest({ headers: new Headers({
      "x-vercel-forwarded-for": "203.0.113.7", authorization: "Bearer synthetic-token",
    }) } as NextRequest);
    const [a, b] = await Promise.all([request.resolveSubject(), request.resolveSubject()]);
    expect(a).toBe(b);expect(a).toHaveLength(2);
    expect(m.verify.mock.calls).toEqual([["synthetic-token", false]]);
  });
  it("invalid signature/expired token stays anonymous with a reason-only warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.verify.mockClear();m.verify.mockRejectedValueOnce(new Error("synthetic private SDK detail"));
    const request = createPaidRefreshRequest({ headers: new Headers({
      "x-vercel-forwarded-for": "203.0.113.7", authorization: "Bearer expired-synthetic-token",
    }) } as NextRequest);
    expect(await request.resolveSubject()).toHaveLength(1);
    expect(m.verify.mock.calls).toEqual([["expired-synthetic-token", false]]);
    expect(warn.mock.calls).toEqual([["[paid-odds] invalid-token"]]);
  });
  it("network-only live attribution never invokes Admin even with an Authorization header", async () => {
    m.getAuth.mockClear();m.verify.mockClear();
    const request = createPaidRefreshRequest({ headers: new Headers({
      "x-vercel-forwarded-for": "203.0.113.7", authorization: "Bearer ignored-synthetic-token",
    }) } as NextRequest, true);
    expect(await request.resolveSubject()).toHaveLength(1);
    expect(m.getAuth).not.toHaveBeenCalled();expect(m.verify).not.toHaveBeenCalled();
  });
  it("composed admission does one statement and replaces legacy floor", async () => {
    const s = setup();await s.boundary.check(s.request);expect(s.query).toHaveBeenCalledTimes(1);expect(s.floor).not.toHaveBeenCalled();
  });
  it.each(["not-installed", "unavailable"])("%s capability uses legacy floor only", async mode => {
    const s = setup();s.initialize.mockResolvedValue(mode);await s.boundary.check(s.request);
    expect(s.floor).toHaveBeenCalledTimes(1);expect(s.query).not.toHaveBeenCalled();expect(s.request.resolveSubject).not.toHaveBeenCalled();
  });
  it("null subject allows the legacy floor and logs one reason per request", async () => {
    const s = setup();const req = { resolveSubject: vi.fn(async () => null) };
    await s.boundary.check(req);await s.boundary.check(req);
    expect(s.warn.mock.calls).toEqual([["identity-unavailable"]]);expect(s.query).not.toHaveBeenCalled();expect(s.floor).toHaveBeenCalledTimes(2);
  });
  it("only subject-rate-limit populates deny cache, expires at retry-after and adds no SQL before claim", async () => {
    const s = setup();s.query.mockResolvedValue([row("subject-rate-limit")]);
    await expect(s.boundary.check(s.request)).rejects.toMatchObject({ reason: "subject-rate-limit" });
    s.query.mockClear();s.request.resolveSubject.mockClear();
    expect(await s.boundary.beforeClaim(s.request)).toBe(true);expect(s.query).not.toHaveBeenCalled();
    s.time(1000);expect(await s.boundary.beforeClaim(s.request)).toBe(false);
  });
  it("log-only allow with retry/would-deny never populates or applies cache", async () => {
    const s = setup(false);s.query.mockResolvedValue([{ ...row(), retry_after_ms: "1000", denied_subjects: dims[0].keys, would_deny: true }]);
    await s.boundary.check(s.request);expect(s.boundary.deniedSize()).toBe(0);
    s.request.resolveSubject.mockClear();expect(await s.boundary.beforeClaim(s.request)).toBe(false);expect(s.request.resolveSubject).not.toHaveBeenCalled();
  });
  it("quota refusal and storage errors never populate the cache", async () => {
    const s = setup();s.query.mockResolvedValue([row("quota-floor")]);
    await expect(s.boundary.check(s.request)).rejects.toMatchObject({ reason: "quota-floor" });expect(s.boundary.deniedSize()).toBe(0);
    s.query.mockRejectedValue(new Error("private URI"));await s.boundary.check(s.request);
    expect(s.warn.mock.calls).toEqual([["limiter-storage-failed"]]);expect(s.boundary.deniedSize()).toBe(0);
  });
  it("user denial does not blacklist another user sharing the network", async () => {
    const s = setup();const network = key("signed-network"), user = key("user");
    s.query.mockResolvedValue([{ ...row("subject-rate-limit"), denied_subjects: [user] }]);
    await expect(s.boundary.check(s.request)).rejects.toBeDefined();
    const req = { resolveSubject: async () => [{ ...dims[0], keys: [network], report: network }, { ...dims[0], keys: [key("user", "b")], report: key("user", "b") }] };
    expect(await s.boundary.beforeClaim(req)).toBe(false);
  });
  it("entries are bounded and eviction only defers to the database", async () => {
    const s = setup();for (const ch of ["a", "b", "c"]) {
      s.query.mockResolvedValue([{ ...row("subject-rate-limit"), denied_subjects: [key("anonymous-network", ch)] }]);
      await expect(s.boundary.check(s.request)).rejects.toBeDefined();
    }
    expect(s.boundary.deniedSize()).toBe(2);expect(await s.boundary.beforeClaim(s.request)).toBe(false);
  });
  it("global null-subject path is counted in instance health without raw data", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.query.mockImplementation(async (sql: string) => sql.includes("AS ready") ? [{ ready: true }] : []);
    const before = paidOddsHealth().reasonCounts["identity-unavailable"] ?? 0;
    const request = createPaidRefreshRequest({ headers: new Headers() } as NextRequest);
    await checkPaidOddsAdmission(request);
    expect(paidOddsHealth().reasonCounts["identity-unavailable"]).toBe(before + 1);
    expect(paidOddsHealth().recentError).toBe("identity-unavailable");expect(JSON.stringify(paidOddsHealth())).not.toContain("headers");
  });
});
