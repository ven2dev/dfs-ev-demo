import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POLL_INTERVAL_MS } from "./streamConfig";

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
  vi.stubEnv("ODDS_DATA_SOURCE", "live");
  vi.stubEnv("ODDS_API_KEY", "test-key");
  fetchSlateEventsMock.mockResolvedValue({
    data: [
      {
        id: "evt-1",
        sportKey: "americanfootball_nfl",
        homeTeam: "Philadelphia Eagles",
        awayTeam: "Dallas Cowboys",
        commenceTime: "2026-10-05T17:00:00Z",
      },
    ],
    capturedAt: "2026-10-05T12:00:00.000Z",
    quota: { remaining: 500, used: 0, last: 0 },
  });
  getVenueForTeamMock.mockReturnValue({ lat: 39.9008, lon: -75.1675 });
  getNflverseTeamAbbreviationMock.mockImplementation((team: string) =>
    team === "Philadelphia Eagles" ? "PHI" : "DAL"
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/stream market capability validation", () => {
  it.each([
    ["sportKey", "basketball_nba"],
    ["sportKey", "../../other?apiKey=other#"],
    ["sportKey", ""],
    ["eventId", "../other"],
    ["eventId", "evt?markets=h2h#"],
    ["eventId", "%2e%2e"],
    ["eventId", "evt\n"],
  ])("rejects unsafe %s=%j before any upstream or database access", async (key, value) => {
    const response = await GET(requestFor({
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Jalen Hurts",
      bookmakerKey: "draftkings",
      direction: "over",
      [key]: value,
    }));
    expect(response.status).toBe(400);
    expect(fetchSlateEventsMock).not.toHaveBeenCalled();
    expect(getSharedLivePropInputsMock).not.toHaveBeenCalled();
    expect(getRealRecentGameStatsMock).not.toHaveBeenCalled();
  });

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
    expect(tick.dataSource).toBe("live");
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

describe("GET /api/stream fixture ticks", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("ODDS_DATA_SOURCE", "fixture");
  });

  it("runs the signed-out EV path without live roster, provider, weather, or cache access", async () => {
    const { getFixtureSlateEvents } = await import("./oddsFixtures");
    const eventId = getFixtureSlateEvents("americanfootball_nfl", new Date())[0].id;
    const response = await GET(
      requestFor({
        eventId,
        marketKey: "player_pass_yds",
        playerName: "Avery Stone",
        bookmakerKey: "fixture-northstar",
        direction: "over",
        sampleWindow: "5",
      })
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");
    const { value } = await reader.read();
    await reader.cancel();
    const tick = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());

    expect(response.status).toBe(200);
    expect(tick).toMatchObject({
      type: "tick",
      dataSource: "fixture",
      line: 244.5,
      marketConsensus: {
        method: "exact-line-median",
        version: 1,
        contributingBookCount: 3,
      },
    });
    expect(fetchSlateEventsMock).not.toHaveBeenCalled();
    expect(getVenueForTeamMock).not.toHaveBeenCalled();
    expect(getNflverseTeamAbbreviationMock).not.toHaveBeenCalled();
    expect(getRealRecentGameStatsMock).not.toHaveBeenCalled();
    expect(getSharedLivePropInputsMock).not.toHaveBeenCalled();
  });

  it("advances fixture prices deterministically across scheduled SSE ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    const { getFixtureSlateEvents } = await import("./oddsFixtures");
    const eventId = getFixtureSlateEvents("americanfootball_nfl", new Date())[0].id;
    const response = await GET(
      requestFor({
        eventId,
        marketKey: "player_pass_yds",
        playerName: "Avery Stone",
        bookmakerKey: "fixture-northstar",
        direction: "over",
      })
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");
    const first = await reader.read();
    const nextRead = reader.read();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const second = await nextRead;
    await reader.cancel();
    const decode = (value: Uint8Array | undefined) =>
      JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
    const firstTick = decode(first.value);
    const secondTick = decode(second.value);

    expect(secondTick.timestamp - firstTick.timestamp).toBe(POLL_INTERVAL_MS);
    expect(secondTick.evScore.impliedProb).not.toBe(firstTick.evScore.impliedProb);
    expect(getSharedLivePropInputsMock).not.toHaveBeenCalled();
  });
});
