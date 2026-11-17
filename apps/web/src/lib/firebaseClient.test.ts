import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ initialize: vi.fn(), auth: vi.fn(), getApp: vi.fn(), getApps: vi.fn() }));
vi.mock("firebase/app", () => ({ initializeApp: m.initialize, getApp: m.getApp, getApps: m.getApps }));
vi.mock("firebase/auth", () => ({ getAuth: m.auth, GoogleAuthProvider: class {} }));

beforeEach(() => {
  vi.resetModules();
  Object.values(m).forEach(mock => mock.mockReset());
  m.getApps.mockReturnValue([]);
  for (const name of ["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "STORAGE_BUCKET", "MESSAGING_SENDER_ID", "APP_ID"]) {
    vi.stubEnv(`NEXT_PUBLIC_FIREBASE_${name}`, `synthetic-public-${name.toLowerCase()}`);
  }
  m.initialize.mockImplementation((options, name) => ({ options: { ...options }, name }));
  m.auth.mockImplementation(app => ({ app }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("#99 browser Firebase configuration", () => {
  it("preserves the default app identity and verifies cached client options", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getFirebaseAuth } = await import("./firebaseClient");
    const first = getFirebaseAuth();
    expect(first).not.toBeNull();
    expect(getFirebaseAuth()).toBe(first);
    expect(m.initialize).toHaveBeenCalledOnce();
    expect(m.initialize.mock.calls[0]).toHaveLength(1);
    expect(m.auth).toHaveBeenCalledOnce();
    expect(m.getApp).not.toHaveBeenCalled();
    expect(m.getApps).toHaveBeenCalledOnce();
    // The real cached-client path asks the boundary to compare SDK options.
    first!.app.options.projectId = "synthetic-mismatched-project";
    expect(getFirebaseAuth()).toBeNull();
    expect(m.auth).toHaveBeenCalledOnce();
    expect(inspect(log.mock.calls)).not.toContain("synthetic-mismatched-project");
  });

  it("checks an existing default app before reuse, without requiring unused settings", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", undefined);
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { publicConfig } = await import("./config.client");
    const app = { name: "[DEFAULT]", options: { ...publicConfig.firebase() } };
    m.getApps.mockReturnValue([app]);
    m.getApp.mockReturnValue(app);
    let { getFirebaseAuth } = await import("./firebaseClient");
    expect(getFirebaseAuth()?.app).toBe(app);
    expect(m.initialize).not.toHaveBeenCalled();
    expect(m.auth).toHaveBeenCalledOnce();
    // Simulate hot reload encountering an app for a different project.
    vi.resetModules();
    app.options.projectId = "synthetic-mismatched-project";
    ({ getFirebaseAuth } = await import("./firebaseClient"));
    expect(getFirebaseAuth()).toBeNull();
    expect(m.auth).toHaveBeenCalledOnce();
    expect(m.initialize).not.toHaveBeenCalled();
    expect(inspect(log.mock.calls)).not.toContain("synthetic-mismatched-project");
  });

  it("returns cached unavailability for missing inputs before SDK initialization", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getFirebaseAuth } = await import("./firebaseClient");
    expect(getFirebaseAuth()).toBeNull();
    expect(getFirebaseAuth()).toBeNull();
    expect(m.initialize).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not retain or log raw SDK failures or retry failed initialization", async () => {
    const marker = "synthetic-browser-sdk-marker-99";
    m.initialize.mockImplementation(() => {
      throw Object.assign(new Error(marker, { cause: marker }), { code: "auth/invalid-api-key" });
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getFirebaseAuth } = await import("./firebaseClient");
    expect(getFirebaseAuth()).toBeNull();
    expect(getFirebaseAuth()).toBeNull();
    expect(m.initialize).toHaveBeenCalledOnce();
    expect(m.auth).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[firebaseClient] Firebase Auth failed to initialize:", "Browser configuration unavailable.", { code: "auth/invalid-api-key" });
    expect(inspect(log.mock.calls, { depth: 10 })).not.toContain(marker);
  });

  it("omits a browser SDK code outside the Firebase code format", async () => {
    const marker = "synthetic-browser-sdk-marker-99";
    m.initialize.mockImplementation(() => { throw Object.assign(new Error(marker), { code: marker }); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getFirebaseAuth } = await import("./firebaseClient");
    expect(getFirebaseAuth()).toBeNull();
    expect(log).toHaveBeenCalledWith("[firebaseClient] Firebase Auth failed to initialize:", "Browser configuration unavailable.");
    expect(inspect(log.mock.calls, { depth: 10 })).not.toContain(marker);
  });
});
