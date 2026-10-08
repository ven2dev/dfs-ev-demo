import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { DB_READINESS_MANIFEST } from "./dbReadinessManifest";

const snapshotMock = vi.fn();
vi.mock("./dbReadinessRepo", () => ({ getDatabaseReadinessSnapshot: snapshotMock }));
const { GET } = await import("@/app/api/health/database/route");
const request = (authorization?: string) => ({
  headers: new Headers(authorization ? { authorization } : {}),
}) as NextRequest;
const history = () => DB_READINESS_MANIFEST.migrations.map((migration) => ({
  ...migration, runner_version: 1, provenance: "adopted", applied_at: "2026-10-07T00:00:00.000Z",
}));
beforeEach(() => {
  vi.stubEnv("DB_READINESS_SECRET", "readiness-secret");
  vi.stubEnv("DATABASE_URL", "synthetic-only-not-a-connection-string");
  snapshotMock.mockResolvedValue({ ledgerPresent: true, requiredTablesPresent: true, history: history() });
});
afterEach(() => { snapshotMock.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("GET /api/health/database", () => {
  it("returns 503 not-configured without database access when the dedicated secret is absent", async () => {
    for (const secret of [undefined, "", "   "]) {
      vi.stubEnv("DB_READINESS_SECRET", secret);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ status: "not-ready", reasons: ["not-configured"] });
    }
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong bearer credentials before database access", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("ODDS_HEALTH_SECRET", "health-secret");
    for (const header of [undefined, "Bearer wrong", "Bearer cron-secret", "Bearer health-secret", "Basic readiness-secret"]) {
      const response = await GET(request(header));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("requires application database configuration only after authorization", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const response = await GET(request("Bearer readiness-secret"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", reasons: ["not-configured"] });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("returns 200 for adopted history and 200 with a warning for valid ahead history", async () => {
    const response = await GET(request("Bearer readiness-secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ready", schemaVersion: 2,
      minimumVersion: 2, maximumKnownVersion: 2, reasons: [], warnings: [] });
    snapshotMock.mockResolvedValueOnce({ ledgerPresent: true, requiredTablesPresent: true, history: [...history(), {
      version: 3, filename: "0003_future.sql", sha256: "a".repeat(64), runner_version: 1,
      provenance: "executed", applied_at: "2026-10-08T00:00:00.000Z",
    }] });
    const ahead = await GET(request("Bearer readiness-secret"));
    expect(ahead.status).toBe(200);
    expect(await ahead.json()).toMatchObject({ schemaVersion: 3, warnings: ["schema-ahead"] });
  });

  it("returns 503 for absent, behind, corrupt and incomplete schema states", async () => {
    for (const [snapshot, reason] of [
      [{ ledgerPresent: false, requiredTablesPresent: true, history: [] }, "migration-ledger-missing"],
      [{ ledgerPresent: true, requiredTablesPresent: true, history: history().slice(0, 1) }, "schema-behind"],
      [{ ledgerPresent: true, requiredTablesPresent: true, history: [] }, "migration-history-invalid"],
      [{ ledgerPresent: true, requiredTablesPresent: false, history: history() }, "required-tables-missing"],
    ]) {
      snapshotMock.mockResolvedValueOnce(snapshot);
      const response = await GET(request("Bearer readiness-secret"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "not-ready", reasons: [reason] });
    }
  });

  it("returns only a safe 503 code for database errors and never logs driver details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    snapshotMock.mockRejectedValueOnce(new Error("postgresql://owner:private@example.invalid/production"));
    const response = await GET(request("Bearer readiness-secret"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", reasons: ["database-unavailable"] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(error).not.toHaveBeenCalled();
  });
});
