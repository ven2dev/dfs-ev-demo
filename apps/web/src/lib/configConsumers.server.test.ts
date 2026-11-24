import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cert: vi.fn(), initialize: vi.fn(), getApp: vi.fn(), getApps: vi.fn(),
  auth: vi.fn(), firestore: vi.fn(), verify: vi.fn(), readDocument: vi.fn(),
  pool: vi.fn(), connect: vi.fn(), query: vi.fn(), release: vi.fn(), syncStats: vi.fn(), syncRoster: vi.fn(),
}));
vi.mock("firebase-admin/app", () => ({ cert: m.cert, initializeApp: m.initialize, getApp: m.getApp, getApps: m.getApps }));
vi.mock("firebase-admin/auth", () => ({ getAuth: m.auth }));
vi.mock("firebase-admin/firestore", () => ({ getFirestore: m.firestore }));
vi.mock("pg", async original => ({ ...await original<typeof import("pg")>(), Pool: m.pool }));
vi.mock("./playerStatsSync", () => ({ syncPlayerStats: m.syncStats }));
vi.mock("./nflverseRosterSync", () => ({ syncNflverseRoster: m.syncRoster }));

// Synthetic private key stays in memory; no key values or fingerprints are saved.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const account = (project = "synthetic-project") => Buffer.from(JSON.stringify({
  type: "service_account", project_id: project,
  client_email: "synthetic@synthetic.invalid", private_key: privateKey,
})).toString("base64");
const request = (path: string, bearer?: string) => new NextRequest(`http://localhost${path}`, {
  headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
});
const marker = "synthetic-server-marker-99";

beforeEach(() => {
  vi.resetModules();
  Object.values(m).forEach(mock => mock.mockReset());
  const apps: { name: string; options: { projectId?: string } }[] = [];
  m.getApps.mockReturnValue(apps);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "synthetic-project");
  vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_KEY_BASE64", account());
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@database.invalid/synthetic");
  vi.stubEnv("ODDS_DATA_SOURCE", "live");
  vi.stubEnv("ODDS_API_KEY", marker);
  vi.stubEnv("CRON_SECRET", "synthetic-cron");
  m.cert.mockReturnValue({ synthetic: true });
  m.initialize.mockImplementation((options, name) => {
    const app = { options, name };
    apps.push(app);
    return app;
  });
  m.verify.mockResolvedValue({ uid: "synthetic-user" });
  m.auth.mockReturnValue({ verifyIdToken: m.verify });
  m.firestore.mockReturnValue({ collection: () => ({ doc: () => ({ get: m.readDocument }) }) });
  m.query.mockResolvedValue({ rows: [] });
  m.connect.mockResolvedValue(Object.assign(new EventEmitter(), { query: m.query, release: m.release }));
  m.pool.mockImplementation(function (options) {
    return Object.assign(new EventEmitter(), { options, connect: m.connect, end: vi.fn().mockResolvedValue(undefined) });
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected synthetic network use"));
});
afterEach(() => {
  vi.doUnmock("./config.server");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("#99 migrated configuration call paths", () => {
  it("checks the real Firebase adapter before cached reuse and ignores ambient apps", async () => {
    const actual = await import("./config.server");
    let project = "synthetic-project";
    const boundary = actual.createServerConfig(name => process.env[name], { firebaseProjectId: () => project });
    vi.doMock("./config.server", () => ({ ...actual, serverConfig: boundary }));
    const { getAdminAuth, getFirestoreDb } = await import("./firebaseAdmin");
    m.getApps.mockReturnValue([{ name: "unverified-default" }]);
    getAdminAuth();
    getAdminAuth();
    getFirestoreDb();
    expect(m.cert).toHaveBeenCalledOnce();
    expect(m.initialize).toHaveBeenCalledOnce();
    expect(m.initialize.mock.calls[0][1]).toBe("dfs-ev-server");
    expect(m.getApp).not.toHaveBeenCalled();
    expect(m.getApps).toHaveBeenCalledOnce();
    expect(m.initialize.mock.calls[0][0].projectId).toBe("synthetic-project");
    // Test seam changes the compared project, not the immutable deployed inputs.
    project = "synthetic-other";
    expect(getAdminAuth).toThrow("firebase-project-mismatch");
    expect(getFirestoreDb).toThrow("firebase-project-mismatch");
    expect(m.auth).toHaveBeenCalledTimes(2);
    expect(m.firestore).toHaveBeenCalledOnce();
    expect(m.cert).toHaveBeenCalledOnce();
    expect(m.pool).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses the verified named SDK app after the configuration instance reloads", async () => {
    const actual = await import("./config.server");
    const configure = () => actual.createServerConfig(name => process.env[name], {
      firebaseProjectId: () => "synthetic-project",
    });
    let boundary = configure();
    vi.doMock("./config.server", () => ({ ...actual, serverConfig: boundary }));
    let { getAdminAuth } = await import("./firebaseAdmin");
    getAdminAuth();
    const firstApp = m.auth.mock.calls[0][0];
    expect(firstApp.options.projectId).toBe("synthetic-project");
    // Keep the SDK's app registry while replacing the configuration/module cache.
    vi.resetModules();
    const previousBoundary = boundary;
    boundary = configure();
    expect(boundary).not.toBe(previousBoundary);
    vi.doMock("./config.server", () => ({ ...actual, serverConfig: boundary }));
    ({ getAdminAuth } = await import("./firebaseAdmin"));
    getAdminAuth();
    getAdminAuth();
    expect(m.auth.mock.calls.every(([app]) => app === firstApp)).toBe(true);
    expect(m.initialize).toHaveBeenCalledOnce();
    expect(m.cert).toHaveBeenCalledOnce();
    expect(m.getApps).toHaveBeenCalledTimes(2);
    expect(m.getApp).not.toHaveBeenCalled();
    expect(m.pool).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "synthetic-other"])("refuses a named SDK app with unverified project %s", async projectId => {
    m.getApps.mockReturnValue([{ name: "dfs-ev-server", options: { projectId } }]);
    const { getAdminAuth } = await import("./firebaseAdmin");
    expect(getAdminAuth).toThrow("firebase-project-mismatch");
    expect(getAdminAuth).toThrow("firebase-project-mismatch");
    expect(m.getApps).toHaveBeenCalledOnce();
    expect(m.initialize).not.toHaveBeenCalled();
    expect(m.cert).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "mismatch"])("refuses %s credentials through the authenticated route before any SDK or data call", async kind => {
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_KEY_BASE64", kind === "missing" ? undefined : kind === "malformed" ? marker : account("synthetic-other"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("@/app/api/user-data/route");
    const response = await GET(request("/api/user-data", "synthetic-token"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, reason: "Internal error" });
    expect(m.cert).not.toHaveBeenCalled();
    expect(m.initialize).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.readDocument).not.toHaveBeenCalled();
    expect(m.pool).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(inspect(log.mock.calls)).not.toContain(marker);
    expect(inspect(log.mock.calls)).not.toContain("synthetic-other");
  });

  it("rechecks the boundary before returning the cached database adapter without adding SQL", async () => {
    const actual = await import("./config.server");
    const database = vi.fn(() => actual.serverConfig.database());
    vi.doMock("./config.server", () => ({ ...actual, serverConfig: { ...actual.serverConfig, database } }));
    const { getSql } = await import("./db");
    expect(getSql()).toBe(getSql());
    expect(m.pool).toHaveBeenCalledOnce();
    expect(database).toHaveBeenCalledTimes(2);
    database.mockReturnValueOnce("postgresql://synthetic:synthetic@changed.invalid/synthetic");
    expect(getSql).toThrow("configuration unavailable (environment-policy)");
    database.mockImplementationOnce(() => { throw new actual.ConfigurationError("invalid"); });
    expect(getSql).toThrow("configuration unavailable (invalid)");
    expect(m.pool).toHaveBeenCalledOnce();
    expect(m.connect).not.toHaveBeenCalled();
    expect(m.query).not.toHaveBeenCalled();
  });

  it.each([undefined, "synthetic-invalid-url"])("refuses database input %s through getSql before pool creation", async value => {
    vi.stubEnv("DATABASE_URL", value);
    const { getSql } = await import("./db");
    expect(getSql).toThrow("configuration unavailable");
    expect(getSql).toThrow("configuration unavailable");
    expect(m.pool).not.toHaveBeenCalled();
    expect(m.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns rows and normalizes query failures through the real getSql entry point", async () => {
    const { getSql } = await import("./db");
    m.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    expect(await getSql().query("SELECT $1::int AS id", [7])).toEqual([{ id: 7 }]);
    expect(m.query.mock.calls[0][0]).toMatchObject({ text: "SELECT $1::int AS id", values: [7] });
    expect(m.release).toHaveBeenLastCalledWith(false);
    m.query.mockRejectedValueOnce(Object.assign(new Error(marker, { cause: marker }), { code: "23505" }));
    const error = await getSql().query("SELECT $1", [marker]).catch(error => error);
    expect(error).toMatchObject({ code: "23505", message: "Application dependency unavailable." });
    expect(inspect(error, { depth: 10 })).not.toContain(marker);
    expect(m.release).toHaveBeenLastCalledWith(false);
    expect(m.pool).toHaveBeenCalledOnce();
    expect(m.connect).toHaveBeenCalledTimes(2);
    expect(m.release).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["23505", "auth/invalid-credential"])("keeps safe diagnostics %s in the real route logger without raw messages or causes", async code => {
    class SyntheticDependencyError extends Error {}
    const raw = Object.assign(new SyntheticDependencyError(marker, { cause: { credential: marker } }), { code, status: 503 });
    raw.name = marker;
    m.readDocument.mockRejectedValue(raw);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("@/app/api/user-data/route");
    const response = await GET(request("/api/user-data", "synthetic-token"));
    expect(response.status).toBe(500);
    expect(m.verify).toHaveBeenCalledOnce();
    expect(m.readDocument).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("[api/user-data] GET failed:", expect.objectContaining({
      name: "SyntheticDependencyError", code, status: 503, message: "Application dependency unavailable.",
    }));
    expect(inspect(log.mock.calls, { depth: 10 })).not.toContain(marker);
    expect(JSON.stringify(await response.json())).not.toContain(marker);
  });

  it("keeps only app-owned stack locations, omitting multiline messages, causes and function labels", async () => {
    const { sanitizedFailure } = await import("./config.server");
    const raw = new TypeError(`${marker}\n    at apps/web/src/lib/${marker}.ts:1:2`, { cause: marker });
    const safe = sanitizedFailure(raw);
    expect(safe.name).toBe("TypeError");
    expect(safe.stack).toContain("apps/web/src/lib/configConsumers.server.test.ts:");
    expect(inspect(safe, { depth: 10 })).not.toContain(marker);
    expect(safe.cause).toBeUndefined();
    expect(sanitizedFailure(safe)).toBe(safe);
  });

  it("drops unsafe diagnostic fields and dependency stacks instead of adopting their app caller frames", async () => {
    const { sanitizedFailure } = await import("./config.server");
    for (const code of [marker, "auth/invalid credential", "23505\n", 23505]) {
      const raw = Object.assign(new TypeError(marker, { cause: marker }), { code, statusCode: 700 });
      raw.name = marker;
      raw.stack = `${marker}: ${marker}\n    at provider (/synthetic/node_modules/provider/index.js:1:2)\n    at caller (/synthetic/apps/web/src/lib/oddsApi.ts:1:2)`;
      const safe = sanitizedFailure(raw);
      expect(safe).not.toHaveProperty("code");
      expect(safe).not.toHaveProperty("status");
      expect(safe.name).toBe("TypeError");
      expect(safe.stack).toBeUndefined();
      expect(inspect(safe, { depth: 10 })).not.toContain(marker);
    }
    const safe = sanitizedFailure(Object.assign(new Error(marker), { statusCode: 429 }));
    expect(safe).toHaveProperty("status", 429);
  });

  it("normalizes provider errors before the slate route logs them and makes no extra request", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.mocked(fetch).mockRejectedValue(new Error(`https://synthetic.invalid/?apiKey=${marker}`));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("@/app/api/slate/route");
    const response = await GET(request("/api/slate"));
    expect(response.status).toBe(500);
    expect(fetch).toHaveBeenCalledOnce();
    expect(m.pool).not.toHaveBeenCalled();
    expect(inspect(log.mock.calls, { depth: 10 })).not.toContain(marker);
  });

  it("separates missing sync receiver configuration from missing or invalid caller credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("CRON_SECRET", undefined);
    let { GET } = await import("@/app/api/cron/sync-player-stats/route");
    expect((await GET(request("/api/cron/sync-player-stats"))).status).toBe(500);
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "synthetic-cron");
    ({ GET } = await import("@/app/api/cron/sync-player-stats/route"));
    for (const bearer of [undefined, "synthetic-wrong"]) {
      expect((await GET(request("/api/cron/sync-player-stats", bearer))).status).toBe(401);
    }
    expect(m.syncStats).not.toHaveBeenCalled();
    expect(m.syncRoster).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(inspect(log.mock.calls)).not.toContain("synthetic-cron");
  });
});
