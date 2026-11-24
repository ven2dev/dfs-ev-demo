import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ConfigurationModule from "./config.server";
import { createServerConfig } from "./config.server";
import { createPaidOddsMode } from "./paidOddsMode";
import type { PaidOddsCapability } from "./paidOddsStartup";
import type { OddsCacheStatus } from "./oddsCacheStartup";

const m = vi.hoisted(() => ({ query: vi.fn(), mode: vi.fn(), verify: vi.fn(),
  limiterReady: true, sharedReady: true, sharedFailure: false, keys: true }));
vi.mock("./db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("./firebaseAdmin", () => ({ getAdminAuth: () => ({ verifyIdToken: m.verify }) }));
vi.mock("./config.server", async original => ({
  ...await original<typeof ConfigurationModule>(),
  serverConfig: {
    paidOddsMode: m.mode, environment: () => "production", databaseConfigured: () => true,
    collectorHealth: () => ({ quotaReserve: 100 }), oddsHealthSecret: () => "synthetic-health-secret",
    paidOdds: () => m.keys ? { keyring: [{ version: "v1", keyHex: "11".repeat(32) }], policies: {
      anonymousNetwork: { intervalMs: 1000, burst: 1 }, signedNetwork: { intervalMs: 1000, burst: 100 },
      user: { intervalMs: 1000, burst: 2 },
    } } : null,
  },
}));
const counts = { admitted: 0, denied: 0, wouldDeny: 0, floorDenied: 0, anonymous: 0, signedIn: 0 };
const reportRows = ["1h", "24h"].map(label => ({ label, totals: counts, top_admitted: [], top_denied: [], top_would_deny: [] }));
beforeEach(() => {
  vi.resetModules();vi.clearAllMocks();m.limiterReady = true;m.sharedReady = true;m.sharedFailure = false;m.keys = true;
  m.mode.mockReturnValue("log-only");
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_attribute")) {
      if (m.sharedFailure) throw Error("private database detail");
      return [{ ready: m.sharedReady }];
    }
    if (sql.includes("AS ready")) return [{ ready: m.limiterReady }];
    if (sql.includes("report_odds_subjects()")) return reportRows;
    if (sql.includes("admit_paid_odds(")) return [{ outcome: "allow", retry_after_ms: "0", denied_subjects: [],
      warning: null, quota_remaining: 1000, would_deny: false }];
    if (sql.includes("odds_api_request_log")) return [];
    throw Error("unexpected query");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("#224 deployment mode and pure health projection", () => {
  it("reads the deployment selection once and projects readiness without probes", () => {
    const config = createServerConfig(name => name === "ODDS_SUBJECT_MODE" ? "enforce" : undefined);
    const read = vi.fn(config.paidOddsMode), warn = vi.fn();
    let capability: PaidOddsCapability = "not-installed";
    let shared: OddsCacheStatus = "not-initialized";
    const mode = createPaidOddsMode({ read, warn, capability: () => capability, sharedCache: () => shared });
    expect(mode.health()).toMatchObject({ requestedMode: "enforce", effectiveMode: "log-only",
      modeReasons: ["limiter-not-ready", "shared-cache-not-ready"] });
    capability = "ready";shared = "shared";
    for (let i = 0; i < 10; i++) expect(mode.health()).toMatchObject({ effectiveMode: "enforce", mode: "enforce", modeReasons: [] });
    expect(read).toHaveBeenCalledTimes(1);expect(m.query).not.toHaveBeenCalled();expect(m.verify).not.toHaveBeenCalled();
  });
  it("malformed selection is cached, warns once, and never echoes supplied values", () => {
    const config = createServerConfig(name => name === "ODDS_SUBJECT_MODE" ? "private-invalid-mode" : undefined);
    const read = vi.fn(config.paidOddsMode), warn = vi.fn();
    const mode = createPaidOddsMode({ read, warn, capability: () => "ready", sharedCache: () => "shared" });
    for (let i = 0; i < 2; i++) expect(mode.health()).toMatchObject({ requestedMode: null, effectiveMode: "log-only",
      modeReasons: ["mode-configuration-unavailable"] });
    expect(JSON.stringify(mode.health())).not.toContain("private-invalid-mode");
    expect(read).toHaveBeenCalledTimes(1);expect(warn.mock.calls).toEqual([["mode-configuration-unavailable"]]);
    expect(m.query).not.toHaveBeenCalled();
  });
  it.each(["log-only", "enforce"])("global %s mode reaches the existing admission without extra health queries", async requested => {
    m.mode.mockReturnValue(requested);
    const boundary = await import("./paidOddsBoundary");
    const cache = await import("./oddsCacheStartup");
    await boundary.initializePaidOdds();await cache.initializeOddsCache();
    expect(m.query).toHaveBeenCalledTimes(2);m.query.mockClear();
    const request = boundary.createPaidRefreshRequest(new NextRequest("http://localhost/fixture", {
      headers: { "x-vercel-forwarded-for": "203.0.113.7" },
    }));
    await boundary.checkPaidOddsAdmission(request);
    expect(m.query).toHaveBeenCalledTimes(1);expect(m.query.mock.calls[0][1][1]).toBe(requested === "enforce");
    for (let i = 0; i < 10; i++) expect(boundary.paidOddsHealth()).toMatchObject({ requestedMode: requested,
      effectiveMode: requested, mode: requested, sharedCache: "shared" });
    expect(m.query).toHaveBeenCalledTimes(1);expect(m.mode).toHaveBeenCalledTimes(1);expect(m.verify).not.toHaveBeenCalled();
  });
  it.each(["missing-schema", "missing-keys", "legacy", "cache-failure"])("requested enforce with %s stays effectively log-only", async scenario => {
    m.mode.mockReturnValue("enforce");
    m.limiterReady = scenario !== "missing-schema";m.keys = scenario !== "missing-keys";
    m.sharedReady = scenario !== "legacy";m.sharedFailure = scenario === "cache-failure";
    const boundary = await import("./paidOddsBoundary"), cache = await import("./oddsCacheStartup");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await boundary.initializePaidOdds();await cache.initializeOddsCache().catch(() => undefined);
    const before = m.query.mock.calls.length;
    expect(boundary.paidOddsHealth()).toMatchObject({ requestedMode: "enforce", effectiveMode: "log-only", mode: "log-only" });
    expect(m.query).toHaveBeenCalledTimes(before);expect(m.verify).not.toHaveBeenCalled();log.mockRestore();
  });
  it("invalid mode does not reject limiter initialization or unrelated account-route import", async () => {
    m.mode.mockImplementation(() => { throw Error("private invalid mode details"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boundary = await import("./paidOddsBoundary");
    await expect(boundary.initializePaidOdds()).resolves.toBe("ready");
    expect(boundary.paidOddsHealth()).toMatchObject({ requestedMode: null, effectiveMode: "log-only" });
    expect(warn.mock.calls).toEqual([["[paid-odds] mode-configuration-unavailable"]]);
    // Account actions keep their own authorization; importing them cannot read mode.
    await expect(import("./apiAuth")).resolves.toBeDefined();
    expect(m.verify).not.toHaveBeenCalled();
  });
  it("HTTP health adds requested/effective mode but unauthorized callers do no database work", async () => {
    m.mode.mockReturnValue("enforce");
    const { GET } = await import("../app/api/health/odds-subjects/route");
    const request = (secret: string) => new NextRequest("http://localhost/api/health/odds-subjects", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect((await GET(request("wrong"))).status).toBe(401);expect(m.query).not.toHaveBeenCalled();
    const boundary = await import("./paidOddsBoundary"), cache = await import("./oddsCacheStartup");
    await boundary.initializePaidOdds();await cache.initializeOddsCache();m.query.mockClear();
    const response = await GET(request("synthetic-health-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).limiter).toMatchObject({ requestedMode: "enforce", effectiveMode: "enforce", mode: "enforce" });
    expect(m.query).toHaveBeenCalledTimes(1);expect(m.query.mock.calls[0][0]).toContain("report_odds_subjects()");
    expect(m.verify).not.toHaveBeenCalled();
  });
});
