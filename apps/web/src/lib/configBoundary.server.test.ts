import { generateKeyPairSync } from "node:crypto";
import { cert, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicConfig, publicInputDefinitions, type PublicInputName } from "./config.client";
import { ConfigurationError, createServerConfig, serverInputDefinitions, type ServerInputName } from "./config.server";

// Attach counters to the real database adapter import, not an unattached fake.
// Checkpoint (a) should never initialize it, even on successful validation.
const database = vi.hoisted(() => ({ initialize: vi.fn(), query: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({
  neon: () => { database.initialize(); return { query: database.query }; },
}));
const sdk = vi.hoisted(() => ({ cert: vi.fn(), initializeApp: vi.fn(), getApp: vi.fn(), getApps: vi.fn() }));
vi.mock("firebase-admin/app", () => sdk);

// A new synthetic key is generated in memory. Neither bytes nor fingerprints
// enter the receipt, logs, fixtures or snapshots.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const account = (project = "synthetic-project") => Buffer.from(JSON.stringify({
  type: "service_account", project_id: project,
  client_email: "synthetic@synthetic-project.iam.gserviceaccount.com", private_key: privateKey,
})).toString("base64");
const serverValues = (): Partial<Record<ServerInputName, string>> => ({
  VERCEL: "1", VERCEL_ENV: "production", ODDS_DATA_SOURCE: "live",
  ODDS_API_KEY: "synthetic-odds-key", DATABASE_URL: "postgresql://synthetic:synthetic@database.invalid:5432/synthetic?sslmode=require",
  FIREBASE_SERVICE_ACCOUNT_KEY_BASE64: account(), ADMIN_UID: "synthetic-admin",
  CRON_SECRET: "synthetic-cron", ODDS_HEALTH_SECRET: "synthetic-health", DB_READINESS_SECRET: "synthetic-readiness",
});
const publicValues: Record<PublicInputName, string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-public-key", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "synthetic.invalid",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "synthetic-project", NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "synthetic.invalid",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123456789", NEXT_PUBLIC_FIREBASE_APP_ID: "synthetic-app",
  NODE_ENV: "production",
};
const caught = (operation: () => unknown): ConfigurationError => {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error("Synthetic refusal did not occur.");
};
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("#99 isolated configuration boundary", () => {
  it("qualifies the pre-migration spike with measured reads, parses, caches and Firebase ordering", () => {
    const serverNames = Object.keys(serverInputDefinitions) as ServerInputName[];
    const publicNames = Object.keys(publicInputDefinitions) as PublicInputName[];
    const serverParses = serverNames.map(name => vi.spyOn(serverInputDefinitions[name], "parse"));
    const publicParses = publicNames.map(name => vi.spyOn(publicInputDefinitions[name], "parse"));
    const values = serverValues();
    const read = vi.fn((name: ServerInputName) => values[name]);
    const readPublic = vi.fn((name: PublicInputName) => publicValues[name]);
    const browser = createPublicConfig(readPublic);
    const events: string[] = [];
    const config = createServerConfig(read, {
      firebaseProjectId: () => { events.push("project-check"); return browser.firebaseProjectId(); },
    });
    // Importing definitions/creating either instance has not read a value.
    expect(read).not.toHaveBeenCalled();
    expect(readPublic).not.toHaveBeenCalled();
    sdk.cert.mockImplementation(() => { events.push("cert"); return "synthetic-certificate"; });
    sdk.initializeApp.mockImplementation(() => { events.push("initialize"); return Object.freeze({ name: "synthetic-owned-app" }) as App; });
    const foreignApp = { name: "synthetic-unverified-global" } as App;
    sdk.getApp.mockReturnValue(foreignApp);
    sdk.getApps.mockReturnValue([foreignApp]);
    const initialize = (credential: Readonly<ServiceAccount>) => initializeApp({ credential: cert(credential) });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected network."); });
    const first = {
      paidOdds: config.paidOdds(), odds: config.odds(), collector: config.collector(), health: config.collectorHealth(),
      firebase: config.firebase(), app: config.firebaseApp(initialize), database: config.database(),
      admin: config.adminUid(), cron: config.cronSecret(), oddsHealth: config.oddsHealthSecret(),
      readiness: config.dbReadinessSecret(), browser: browser.firebase(),
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(config.paidOdds()).toBe(first.paidOdds);
      expect(config.odds()).toBe(first.odds);
      expect(config.liveOdds()).toBe(first.odds);
      expect(config.collector()).toBe(first.collector);
      expect(config.collectorHealth()).toBe(first.health);
      expect(config.firebase()).toBe(first.firebase);
      const checksBefore = events.filter(event => event === "project-check").length;
      expect(config.firebaseApp(initialize)).toBe(first.app);
      expect(events.filter(event => event === "project-check")).toHaveLength(checksBefore + 1);
      expect(config.database()).toBe(first.database);
      expect(config.databaseConfigured()).toBe(true);
      expect(config.adminUid()).toBe(first.admin);
      expect(config.cronSecret()).toBe(first.cron);
      expect(config.oddsHealthSecret()).toBe(first.oddsHealth);
      expect(config.dbReadinessSecret()).toBe(first.readiness);
      expect(browser.firebase()).toBe(first.browser);
      expect(browser.devtoolsEnabled()).toBe(false);
    }
    for (const name of serverNames) expect(read.mock.calls.filter(([key]) => key === name)).toHaveLength(1);
    for (const name of publicNames) expect(readPublic.mock.calls.filter(([key]) => key === name)).toHaveLength(1);
    for (const parse of [...serverParses, ...publicParses]) expect(parse).toHaveBeenCalledTimes(1);
    expect(events.indexOf("project-check")).toBeLessThan(events.indexOf("cert"));
    expect(events.indexOf("cert")).toBeLessThan(events.indexOf("initialize"));
    expect(sdk.cert).toHaveBeenCalledTimes(1);
    expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    expect(sdk.getApp).not.toHaveBeenCalled();
    expect(sdk.getApps).not.toHaveBeenCalled();
    expect(Object.isFrozen(first.collector)).toBe(true);
    expect(Object.isFrozen(first.firebase)).toBe(true);
    expect(Object.isFrozen(first.browser)).toBe(true);
    expect(database.initialize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    const success = {
      rounds: 3, serverInputCount: serverNames.length, publicInputCount: publicNames.length,
      readsPerInput: Object.fromEntries([...read.mock.calls, ...readPublic.mock.calls].map(([name]) => [name, 1])),
      parsesPerInput: Object.fromEntries([...serverNames, ...publicNames].map((name, index) => [name, [...serverParses, ...publicParses][index].mock.calls.length])),
      certCalls: sdk.cert.mock.calls.length, initializeCalls: sdk.initializeApp.mock.calls.length,
      unverifiedGlobalReuses: sdk.getApp.mock.calls.length + sdk.getApps.mock.calls.length, firebaseEvents: [...events], databaseInitializations: database.initialize.mock.calls.length, sqlCalls: database.query.mock.calls.length, networkCalls: network.mock.calls.length,
    };

    // A refusal shared across three capabilities rethrows the cached error;
    // changing the injected value is not an in-process repair/rotation path.
    const certBefore = sdk.cert.mock.calls.length;
    const initBefore = sdk.initializeApp.mock.calls.length;
    const invalidValues: Partial<Record<ServerInputName, string>> = { ...serverValues(), ODDS_API_KEY: undefined };
    const readInvalid = vi.fn((name: ServerInputName) => invalidValues[name]);
    const invalid = createServerConfig(readInvalid, browser);
    const keyParser = serverParses[serverNames.indexOf("ODDS_API_KEY")];
    const keyParsesBefore = keyParser.mock.calls.length;
    const failures = [caught(invalid.liveOdds), caught(invalid.collector), caught(invalid.collectorHealth)];
    invalidValues.ODDS_API_KEY = "synthetic-replacement";
    failures.push(caught(invalid.liveOdds));
    for (const error of failures) expect(error).toBe(failures[0]);
    expect(readInvalid.mock.calls.filter(([name]) => name === "ODDS_API_KEY")).toHaveLength(1);
    const refusalParses = keyParser.mock.calls.length - keyParsesBefore;
    expect(refusalParses).toBe(1);
    const mismatch = createServerConfig(name => ({ ...serverValues(), FIREBASE_SERVICE_ACCOUNT_KEY_BASE64: account("synthetic-other") })[name], browser);
    const mismatchFirst = caught(() => mismatch.firebaseApp(initialize));
    expect(caught(() => mismatch.firebaseApp(initialize))).toBe(mismatchFirst);
    expect(mismatchFirst.code).toBe("firebase-project-mismatch");
    expect(sdk.cert).toHaveBeenCalledTimes(certBefore);
    expect(sdk.initializeApp).toHaveBeenCalledTimes(initBefore);
    expect(database.initialize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    const fixtureRead = vi.fn((name: ServerInputName) => {
      if (name === "VERCEL") return "1";
      if (name === "VERCEL_ENV") return "preview";
      if (name === "ODDS_DATA_SOURCE") return "fixture";
      throw new Error("Fixture attempted a live secret read.");
    });
    const fixture = createServerConfig(fixtureRead);
    expect(fixture.odds()).toEqual({ source: "fixture" });
    expect(fixture.odds()).toBe(fixture.odds());
    expect(fixtureRead).toHaveBeenCalledTimes(3);
    console.info("CONFIGURATION_SPIKE " + JSON.stringify({
      format: "configuration-spike-v1", verdict: "pass", success,
      refusal: { repeatedAttempts: failures.length, keyReads: readInvalid.mock.calls.filter(([name]) => name === "ODDS_API_KEY").length, keyParses: refusalParses, cachedSameError: failures.every(error => error === failures[0]), certCalls: sdk.cert.mock.calls.length - certBefore, initializeCalls: sdk.initializeApp.mock.calls.length - initBefore, databaseInitializations: database.initialize.mock.calls.length, sqlCalls: database.query.mock.calls.length, networkCalls: network.mock.calls.length },
      firebaseMismatch: { attempts: 2, cachedSameError: true, certCalls: sdk.cert.mock.calls.length - certBefore, initializeCalls: sdk.initializeApp.mock.calls.length - initBefore },
      fixture: { repeatedCalls: 3, inputReads: fixtureRead.mock.calls.map(([name]) => name), liveSecretReads: 0 },
    }));
  });

  it("checks project agreement before returning a previously verified app", () => {
    let project = "synthetic-project";
    const values = serverValues();
    const config = createServerConfig(name => values[name], { firebaseProjectId: () => project });
    const initialize = vi.fn(() => ({ name: "owned" }) as App);
    config.firebaseApp(initialize);
    project = "synthetic-other"; // Test seam proves the cached-app path checks too.
    expect(caught(() => config.firebaseApp(initialize)).code).toBe("firebase-project-mismatch");
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("caches safe missing/malformed capability errors without retaining parser inputs", () => {
    const getters = ["cronSecret", "oddsHealthSecret", "dbReadinessSecret", "adminUid", "database", "firebase"] as const;
    const config = createServerConfig(() => undefined, createPublicConfig(() => undefined));
    for (const getter of getters) {
      const error = caught(config[getter]);
      expect(caught(config[getter])).toBe(error);
      expect(error.code).toBe("missing");
    }
    for (const value of ["synthetic-private-marker", "postgresql://%GG:synthetic@database.invalid/synthetic", "https://synthetic.invalid/synthetic"]) {
      const malformed = createServerConfig(name => name === "DATABASE_URL" ? value : undefined);
      const error = caught(malformed.database);
      expect(error.code).toBe("invalid");
      expect(error.message).not.toContain(value);
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain(value);
      expect(caught(malformed.database)).toBe(error);
    }
  });

  it("refuses malformed Firebase credentials and SDK initialization with sanitized cached failures", () => {
    for (const encoded of ["not-base64", Buffer.from("synthetic-json-marker").toString("base64"), Buffer.from(JSON.stringify({ type: "service_account", project_id: "synthetic-project", client_email: "synthetic@synthetic.invalid", private_key: "synthetic-private-marker" })).toString("base64")]) {
      const config = createServerConfig(name => name === "FIREBASE_SERVICE_ACCOUNT_KEY_BASE64" ? encoded : undefined, createPublicConfig(() => "synthetic-project"));
      const initialize = vi.fn();
      const error = caught(() => config.firebaseApp(initialize));
      expect(error.code).toBe("invalid");
      expect(caught(() => config.firebaseApp(initialize))).toBe(error);
      expect(error.message).not.toContain("synthetic");
      expect(error.cause).toBeUndefined();
      expect(initialize).not.toHaveBeenCalled();
    }
    const values = serverValues();
    const config = createServerConfig(name => values[name], createPublicConfig(name => publicValues[name]));
    const initialize = vi.fn(() => { throw new Error("synthetic-sdk-secret-marker"); });
    const error = caught(() => config.firebaseApp(initialize));
    expect(error.code).toBe("initialization-failed");
    expect(caught(() => config.firebaseApp(initialize))).toBe(error);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain("synthetic");
    expect(error.cause).toBeUndefined();
  });

  it("preserves environment refusals and collector bounds without reading unused secrets", () => {
    for (const values of [{ VERCEL: "1" }, { VERCEL_ENV: "unknown" }, { VERCEL_ENV: "preview", ODDS_DATA_SOURCE: "live" }, { VERCEL_ENV: "production", ODDS_DATA_SOURCE: "fixture" }]) {
      const config = createServerConfig(name => (values as Partial<Record<ServerInputName, string>>)[name]);
      expect(() => config.odds()).toThrow(ConfigurationError);
    }
    for (const raw of ["4", "NaN", "55001"]) {
      const values = { ...serverValues(), ODDS_COLLECTION_LEASE_MS: raw };
      const config = createServerConfig(name => values[name]);
      expect(caught(config.collector).code).toBe("invalid");
    }
    const local = createServerConfig(name => {
      if (["VERCEL", "VERCEL_ENV", "ODDS_DATA_SOURCE"].includes(name)) return undefined;
      throw new Error("Local fixture read unused secret.");
    });
    expect(local.odds()).toEqual({ source: "fixture" });
    // Fixture selection succeeds, but asking it for the live-only capability
    // refuses. That refusal has the same cache contract as a missing secret.
    const fixtureRefusal = caught(local.liveOdds);
    expect(caught(local.liveOdds)).toBe(fixtureRefusal);
  });
});
