import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const runCollectorMock = vi.fn();

vi.mock("./oddsCollector", () => ({
  runOddsCollector: runCollectorMock,
}));

const { GET } = await import("@/app/api/cron/collect-odds/route");

const request = (authorization?: string) =>
  ({
    headers: new Headers(authorization ? { authorization } : {}),
  }) as NextRequest;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("ODDS_COLLECTION_PROFILE", "free-pilot");
  runCollectorMock.mockResolvedValue({ profile: "free-pilot", completed: 1 });
});

afterEach(() => {
  runCollectorMock.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/collect-odds", () => {
  it("rejects unauthorized requests before reading collector configuration", async () => {
    const response = await GET(request("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(runCollectorMock).not.toHaveBeenCalled();
  });

  it("runs with bounded defaults and returns an operational summary", async () => {
    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      result: { profile: "free-pilot", completed: 1 },
    });
    expect(runCollectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "free-pilot",
        eveningHourEastern: 20,
        leaseMs: 45_000,
        claimLimit: 2,
        requestTimeoutMs: 15_000,
        retryDelayMs: 60_000,
        quotaReserve: 100,
        priorityFarIntervalMs: 3_600_000,
        priorityActiveIntervalMs: 300_000,
        ownerId: expect.any(String),
      })
    );
  });

  it("fails closed on an invalid or accidental paid profile value", async () => {
    vi.stubEnv("ODDS_COLLECTION_PROFILE", "paid");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(request("Bearer cron-secret"));

    expect(response.status).toBe(500);
    expect(runCollectorMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
