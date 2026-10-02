import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const fetchSlateEventsMock = vi.fn();
const getVenueForTeamMock = vi.fn();
const getNflverseTeamAbbreviationMock = vi.fn();
const getRealRecentGameStatsMock = vi.fn();
const getSharedLivePropInputsMock = vi.fn();

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
  getSharedLivePropInputs: getSharedLivePropInputsMock,
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

describe("GET /api/stream consensus devig ticks", () => {
  const openStream = async (direction: "over" | "under" = "over") => {
    const response = await GET(
      requestFor({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "Jalen Hurts",
        bookmakerKey: "draftkings",
        direction,
        sampleWindow: "3",
      })
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");
    const { value } = await reader.read();
    await reader.cancel();
    const event = new TextDecoder().decode(value);
    return JSON.parse(event.replace(/^data: /, "").trim());
  };

  beforeEach(() => {
    getRealRecentGameStatsMock.mockResolvedValue([240, 260, 280]);
    getSharedLivePropInputsMock.mockResolvedValue({
      oddsByBookmaker: [
        {
          bookmakerKey: "draftkings",
          overPrice: 1.8,
          underPrice: 2,
          point: 250.5,
        },
        {
          bookmakerKey: "fanduel",
          overPrice: 1.9,
          underPrice: 2.1,
          point: 250.5,
        },
        {
          bookmakerKey: "betmgm",
          overPrice: 1.91,
          underPrice: 1.91,
          point: 250.5,
        },
        {
          bookmakerKey: "other-line",
          overPrice: 1.2,
          underPrice: 5,
          point: 251.5,
        },
      ],
      weather: { temperatureF: 65, windSpeedMph: 5, precipitationMm: 0 },
    });
  });

  it("uses exact-line multi-book median probability and exposes its provenance", async () => {
    const tick = await openStream("over");

    expect(tick.type).toBe("tick");
    expect(tick.line).toBe(250.5);
    expect(tick.evScore.impliedProb).toBeCloseTo(0.525, 12);
    expect(tick.marketConsensus).toEqual({
      method: "exact-line-median",
      version: 1,
      contributingBookCount: 3,
    });
  });

  it("derives the Under consensus as the complement of Over", async () => {
    const tick = await openStream("under");

    expect(tick.type).toBe("tick");
    expect(tick.evScore.impliedProb).toBeCloseTo(0.475, 12);
    expect(tick.marketConsensus.contributingBookCount).toBe(3);
  });

  it("reuses the existing per-tick error shape when the selected quote is invalid", async () => {
    getSharedLivePropInputsMock.mockResolvedValue({
      oddsByBookmaker: [
        {
          bookmakerKey: "draftkings",
          overPrice: 1,
          underPrice: 2,
          point: 250.5,
        },
        {
          bookmakerKey: "fanduel",
          overPrice: 1.9,
          underPrice: 1.9,
          point: 250.5,
        },
      ],
      weather: { temperatureF: 65, windSpeedMph: 5, precipitationMm: 0 },
    });

    await expect(openStream()).resolves.toEqual({
      type: "error",
      message:
        'Bookmaker "draftkings" no longer offers a valid two-way quote for this prop',
    });
  });

  it("reuses the existing per-tick error shape when no valid cohort quote remains", async () => {
    getSharedLivePropInputsMock.mockResolvedValue({
      oddsByBookmaker: [
        {
          bookmakerKey: "draftkings",
          overPrice: 1,
          underPrice: 2,
          point: 250.5,
        },
        {
          bookmakerKey: "fanduel",
          overPrice: Number.NaN,
          underPrice: 1.9,
          point: 250.5,
        },
      ],
      weather: { temperatureF: 65, windSpeedMph: 5, precipitationMm: 0 },
    });

    await expect(openStream()).resolves.toEqual({
      type: "error",
      message: "No valid two-way market quotes remain at line 250.5",
    });
  });
});
