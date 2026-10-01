import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const fetchSlateEventsMock = vi.fn();
const getVenueForTeamMock = vi.fn();
const getNflverseTeamAbbreviationMock = vi.fn();
const getRealRecentGameStatsMock = vi.fn();

vi.mock("./oddsApi", () => ({
  DEFAULT_SPORT_KEY: "americanfootball_nfl",
  fetchSlateEvents: fetchSlateEventsMock,
}));

vi.mock("./nflStadiums", () => ({
  getVenueForTeam: getVenueForTeamMock,
  getNflverseTeamAbbreviation: getNflverseTeamAbbreviationMock,
}));

vi.mock("./playerStatsRepo", () => ({
  getRealRecentGameStats: getRealRecentGameStatsMock,
}));

vi.mock("./livePropCacheRepo", () => ({
  getSharedLivePropInputs: vi.fn(),
}));

const { GET } = await import("@/app/api/stream/route");

const requestFor = (searchParams: Record<string, string>) =>
  ({
    nextUrl: new URL(`https://example.test/api/stream?${new URLSearchParams(searchParams)}`),
  }) as NextRequest;

beforeEach(() => {
  fetchSlateEventsMock.mockResolvedValue([
    {
      id: "evt-1",
      sportKey: "americanfootball_nfl",
      homeTeam: "Philadelphia Eagles",
      awayTeam: "Dallas Cowboys",
      commenceTime: "2026-10-05T17:00:00Z",
    },
  ]);
  getVenueForTeamMock.mockReturnValue({ lat: 39.9008, lon: -75.1675 });
  getNflverseTeamAbbreviationMock.mockImplementation((team: string) =>
    team === "Philadelphia Eagles" ? "PHI" : "DAL"
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

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

  it("resolves an unseen player within the selected event and market safety scope", async () => {
    getRealRecentGameStatsMock.mockResolvedValue(null);

    const response = await GET(
      requestFor({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "J. Hurts",
        bookmakerKey: "draftkings",
        direction: "over",
      })
    );

    expect(response.status).toBe(422);
    expect(getRealRecentGameStatsMock).toHaveBeenCalledWith(
      "J. Hurts",
      "passing_yards",
      {
        season: 2026,
        eventTeams: ["PHI", "DAL"],
        marketKey: "player_pass_yds",
      }
    );
  });

  it("returns 503 when roster or crosswalk persistence is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getRealRecentGameStatsMock.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(
      requestFor({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "Jalen Hurts",
        bookmakerKey: "draftkings",
        direction: "over",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      reason: "Historical stats are temporarily unavailable",
    });
    expect(consoleError).toHaveBeenCalled();
  });
});
