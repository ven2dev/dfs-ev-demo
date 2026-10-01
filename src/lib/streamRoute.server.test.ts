import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

const { GET } = await import("@/app/api/stream/route");

const requestFor = (searchParams: Record<string, string>) =>
  ({
    nextUrl: new URL(`https://example.test/api/stream?${new URLSearchParams(searchParams)}`),
  }) as NextRequest;

describe("GET /api/stream market capability validation", () => {
  it("rejects a browse-only market before opening a live stream", async () => {
    const response = await GET(
      requestFor({
        eventId: "evt-1",
        marketKey: "player_anytime_td",
        playerName: "Jalen Hurts",
        bookmakerKey: "draftkings",
        direction: "over",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      reason: 'Market "player_anytime_td" is browse-only and cannot be watched',
    });
  });

  it("rejects an invalid direction", async () => {
    const response = await GET(
      requestFor({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "Jalen Hurts",
        bookmakerKey: "draftkings",
        direction: "yes",
      })
    );

    expect(response.status).toBe(400);
  });
});
