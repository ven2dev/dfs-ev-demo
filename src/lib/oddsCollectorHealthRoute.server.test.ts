import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { OddsCollectorHealthSnapshot } from "./oddsCollectorHealth";

const snapshotMock = vi.fn();

vi.mock("./oddsCollectorHealthRepo", () => ({
  getOddsCollectorHealthSnapshot: snapshotMock,
}));

const { GET } = await import("@/app/api/health/odds-collector/route");

const request = (authorization?: string) =>
  ({
    headers: new Headers(authorization ? { authorization } : {}),
  }) as NextRequest;

const healthySnapshot = (): OddsCollectorHealthSnapshot => ({
  currentWeekStartTime: new Date("2026-09-29T04:00:00.000Z"),
  hasCurrentWeekPin: true,
  hasCurrentWeekScheduledWake: true,
  latestScheduledWake: {
    requestedAt: new Date("2026-10-03T11:55:00.000Z"),
    outcome: "success",
  },
  recentSuccessfulUnknownCostCount: 0,
  repeatedFailureCount: 0,
  terminalFailureCount: 0,
  staleClaimCount: 0,
  missedCheckpointCount: 0,
  activeNonPilotCheckpointCount: 0,
  activePriorityTargetCount: 0,
  latestQuotaRemaining: 478,
  nextPilotCheckpoint: { priorityRank: 40, marketCreditCost: 9 },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
  vi.stubEnv("ODDS_HEALTH_SECRET", "health-secret");
  vi.stubEnv("ODDS_COLLECTION_PROFILE", "free-pilot");
  snapshotMock.mockResolvedValue(healthySnapshot());
});

afterEach(() => {
  snapshotMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health/odds-collector", () => {
  it("rejects unauthorized requests without querying Postgres", async () => {
    const response = await GET(request("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ status: "unauthorized" });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("returns only public-safe health reason codes", async () => {
    const response = await GET(request("Bearer health-secret"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "healthy",
      reasons: [],
      warnings: [],
    });
    expect(snapshotMock).toHaveBeenCalledWith(new Date("2026-10-03T12:00:00.000Z"), {
      unknownCostLookbackMs: 86_400_000,
      staleClaimGraceMs: 600_000,
    });
  });

  it("uses 503 for an unhealthy collector and keeps warnings non-failing", async () => {
    const unhealthy = healthySnapshot();
    unhealthy.repeatedFailureCount = 1;
    snapshotMock.mockResolvedValueOnce(unhealthy);
    const unhealthyResponse = await GET(request("Bearer health-secret"));
    expect(unhealthyResponse.status).toBe(503);
    await expect(unhealthyResponse.json()).resolves.toEqual({
      status: "unhealthy",
      reasons: ["repeated-checkpoint-failure"],
      warnings: [],
    });

    const warning = healthySnapshot();
    warning.latestQuotaRemaining = 100;
    warning.nextPilotCheckpoint = { priorityRank: 20, marketCreditCost: 9 };
    snapshotMock.mockResolvedValueOnce(warning);
    const warningResponse = await GET(request("Bearer health-secret"));
    expect(warningResponse.status).toBe(200);
    await expect(warningResponse.json()).resolves.toEqual({
      status: "healthy",
      reasons: [],
      warnings: ["quota-policy-degraded"],
    });
  });

  it("fails closed without exposing a database error", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("connection string leaked here"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(request("Bearer health-secret"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      status: "error",
      reasons: ["health-query-failed"],
    });
    expect(JSON.stringify(body)).not.toContain("connection string");
    expect(consoleError).toHaveBeenCalledWith(
      "[api/health/odds-collector] health query failed:",
      "Error"
    );
  });
});
