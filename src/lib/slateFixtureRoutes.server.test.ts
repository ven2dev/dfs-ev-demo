import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchSlateEventsMock = vi.fn();
const getOrFetchMarketOddsMock = vi.fn();

vi.mock("./oddsApi", () => ({
  DEFAULT_SPORT_KEY: "americanfootball_nfl",
  fetchSlateEvents: fetchSlateEventsMock,
}));

vi.mock("./oddsCacheRepo", () => ({
  getOrFetchMarketOdds: getOrFetchMarketOddsMock,
}));

const { GET: getSlate } = await import("@/app/api/slate/route");
const { GET: getProps } = await import("@/app/api/slate/[eventId]/props/route");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("ODDS_DATA_SOURCE", "fixture");
  vi.stubEnv("ODDS_API_KEY", "must-not-be-used");
});

afterEach(() => {
  fetchSlateEventsMock.mockReset();
  getOrFetchMarketOddsMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("fixture slate routes", () => {
  it("serves a current synthetic slate without calling the provider", async () => {
    const response = await getSlate(new NextRequest("http://localhost/api/slate"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.events).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^fixture-week-/) }),
    ]);
    expect(fetchSlateEventsMock).not.toHaveBeenCalled();
  });

  it("discovers fixture props without reading or writing the odds cache", async () => {
    const slateResponse = await getSlate(new NextRequest("http://localhost/api/slate"));
    const eventId = (await slateResponse.json()).events[0].id as string;
    const request = new NextRequest(
      `http://localhost/api/slate/${eventId}/props?markets=player_pass_yds,player_receptions&refresh=true`
    );
    const response = await getProps(request, { params: Promise.resolve({ eventId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      eventId,
      players: expect.arrayContaining([
        expect.objectContaining({ playerName: "Avery Stone" }),
        expect.objectContaining({ playerName: "Morgan Reed" }),
      ]),
    });
    expect(getOrFetchMarketOddsMock).not.toHaveBeenCalled();
    expect(fetchSlateEventsMock).not.toHaveBeenCalled();
  });

  it("rejects non-fixture event ids before any provider or database access", async () => {
    const eventId = "real-provider-event";
    const request = new NextRequest(
      `http://localhost/api/slate/${eventId}/props?markets=player_pass_yds`
    );
    const response = await getProps(request, { params: Promise.resolve({ eventId }) });

    expect(response.status).toBe(404);
    expect(getOrFetchMarketOddsMock).not.toHaveBeenCalled();
    expect(fetchSlateEventsMock).not.toHaveBeenCalled();
  });
});
