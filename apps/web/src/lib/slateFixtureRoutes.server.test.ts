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
    expect(body.dataSource).toBe("fixture");
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
      dataSource: "fixture",
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

describe.each(["live", "fixture"])("%s slate request validation", (mode) => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("ODDS_DATA_SOURCE", mode);
  });

  it.each(["basketball_nba", "../../other", "americanfootball_nfl?apiKey=other#", ""])(
    "returns 400 for sport %j before provider or cache access", async (sportKey) => {
      const query = new URLSearchParams({ sportKey, markets: "player_pass_yds" });
      const slate = await getSlate(new NextRequest(`http://localhost/api/slate?${query}`));
      const props = await getProps(new NextRequest(`http://localhost/api/slate/evt-1/props?${query}`), {
        params: Promise.resolve({ eventId: "evt-1" }),
      });
      expect(slate.status).toBe(400);
      expect(props.status).toBe(400);
      expect(fetchSlateEventsMock).not.toHaveBeenCalled();
      expect(getOrFetchMarketOddsMock).not.toHaveBeenCalled();
    }
  );

  it.each(["../other", "evt?regions=eu", "evt#fragment", "%2e%2e", "evt\n", "a".repeat(129)])(
    "returns 400 for resolved event ID %j before cache access", async (eventId) => {
      const response = await getProps(new NextRequest("http://localhost/api/slate/placeholder/props?markets=player_pass_yds&refresh=true"), {
        params: Promise.resolve({ eventId }),
      });
      expect(response.status).toBe(400);
      expect(getOrFetchMarketOddsMock).not.toHaveBeenCalled();
      expect(fetchSlateEventsMock).not.toHaveBeenCalled();
    }
  );

  it("rejects a decoded query injection in markets before cache access", async () => {
    const query = new URLSearchParams({ markets: "player_pass_yds&regions=eu" });
    const response = await getProps(new NextRequest(`http://localhost/api/slate/evt-1/props?${query}`), {
      params: Promise.resolve({ eventId: "evt-1" }),
    });
    expect(response.status).toBe(400);
    expect(getOrFetchMarketOddsMock).not.toHaveBeenCalled();
  });
});
