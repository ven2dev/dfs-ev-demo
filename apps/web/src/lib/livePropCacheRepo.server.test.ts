import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const fetchOddsMock = vi.fn();
const fetchWeatherMock = vi.fn();
const persistObservationMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

vi.mock("./oddsApi", () => ({
  fetchPlayerPropMarketOdds: fetchOddsMock,
}));

vi.mock("./weather", () => ({
  fetchGameWeather: fetchWeatherMock,
}));

vi.mock("./oddsSnapshotRepo", () => ({
  persistOddsObservation: persistObservationMock,
}));

const { getSharedLivePropInputs } = await import("./livePropCacheRepo.ts");

const key = {
  sportKey: "americanfootball_nfl",
  eventId: "evt-1",
  marketKey: "player_pass_yds",
  playerName: "Jalen Hurts",
};

const context = {
  startTime: "2026-10-05T17:00:00Z",
  homeTeam: "Chicago Bears",
  awayTeam: "Seattle Seahawks",
  venueLat: 41.8623,
  venueLon: -87.6167,
};

const oddsByBookmaker = [
  {
    bookmakerKey: "draftkings",
    overPrice: 1.91,
    underPrice: 1.89,
    point: 214.5,
  },
];

const weather = { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 };

const oddsFetch = () => ({
  data: {
    response: {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [
                { name: "Over", description: "Jalen Hurts", point: 214.5, price: 1.91 },
                { name: "Under", description: "Jalen Hurts", point: 214.5, price: 1.89 },
              ],
            },
          ],
        },
      ],
    },
    oddsByBookmaker,
  },
  capturedAt: "2026-10-05T16:00:00.000Z",
  quota: { remaining: 479, used: 21, last: 1 },
});

beforeEach(() => {
  persistObservationMock.mockResolvedValue({ inserted: true });
});

afterEach(() => {
  queryMock.mockReset();
  fetchOddsMock.mockReset();
  fetchWeatherMock.mockReset();
  persistObservationMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getSharedLivePropInputs", () => {
  it("acquires the database lease, fetches both inputs once, and writes one shared payload", async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ event_id: "evt-1" }]);
    fetchOddsMock.mockResolvedValueOnce(oddsFetch());
    fetchWeatherMock.mockResolvedValueOnce(weather);

    await expect(getSharedLivePropInputs(key, context)).resolves.toMatchObject({
      oddsByBookmaker,
      oddsObservation: {
        origin: "upstream",
        capturedAt: "2026-10-05T16:00:00.000Z",
        quota: { remaining: 479, used: 21, last: 1 },
      },
      weather,
    });

    expect(fetchOddsMock).toHaveBeenCalledTimes(1);
    expect(fetchOddsMock).toHaveBeenCalledWith(
      key.sportKey,
      key.eventId,
      key.marketKey,
      key.playerName,
      expect.any(AbortSignal),
      "live"
    );
    expect(fetchWeatherMock).toHaveBeenCalledWith(
      context.startTime,
      context.venueLat,
      context.venueLon,
      expect.any(AbortSignal)
    );
    expect(persistObservationMock).toHaveBeenCalledTimes(1);
    expect(persistObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "live",
        eventStartTime: new Date(context.startTime),
        homeTeam: context.homeTeam,
        awayTeam: context.awayTeam,
        requestedMarketKeys: [key.marketKey],
      }),
      expect.objectContaining({ id: key.eventId })
    );
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[1][0]).toContain("ON CONFLICT");
    expect(queryMock.mock.calls[1][0]).toContain("refresh_lease_until");
  });

  it.each(["string", "Date"] as const)(
    "serves a fresh database payload with a %s timestamp without touching either upstream API",
    async (timestampType) => {
      const fetchedAt = new Date();
      queryMock.mockResolvedValueOnce([
        {
          payload: { oddsByBookmaker, weather },
          fetched_at: timestampType === "Date" ? fetchedAt : fetchedAt.toISOString(),
        },
      ]);

      await expect(getSharedLivePropInputs(key, context)).resolves.toEqual({
        oddsByBookmaker,
        weather,
      });
      expect(fetchOddsMock).not.toHaveBeenCalled();
      expect(fetchWeatherMock).not.toHaveBeenCalled();
      expect(persistObservationMock).not.toHaveBeenCalled();
      expect(queryMock).toHaveBeenCalledTimes(1);
    }
  );

  it("fails open with the fresh upstream result when its cache update fails", async () => {
    const writeError = new Error("write failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockRejectedValueOnce(writeError)
      .mockResolvedValueOnce([]);
    fetchOddsMock.mockResolvedValueOnce(oddsFetch());
    fetchWeatherMock.mockResolvedValueOnce(weather);

    await expect(getSharedLivePropInputs(key, context)).resolves.toMatchObject({
      oddsByBookmaker,
      weather,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[livePropCacheRepo] failed to persist refreshed inputs:",
      writeError
    );
    expect(queryMock.mock.calls[3][0]).toContain("refresh_owner = NULL");
  });

  it("returns and caches fresh inputs when immutable-history persistence fails", async () => {
    const historyError = new Error("history unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ event_id: "evt-1" }]);
    fetchOddsMock.mockResolvedValueOnce(oddsFetch());
    fetchWeatherMock.mockResolvedValueOnce(weather);
    persistObservationMock.mockRejectedValueOnce(historyError);

    await expect(getSharedLivePropInputs(key, context)).resolves.toMatchObject({
      oddsByBookmaker,
      weather,
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("failed to persist observation"),
      historyError
    );
    expect(queryMock.mock.calls[2][0]).toContain("SET payload");
  });

  it("does not log an expected history error when a live refresh arrives at kickoff", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ event_id: "evt-1" }]);
    fetchOddsMock.mockResolvedValueOnce({
      ...oddsFetch(),
      capturedAt: context.startTime,
    });
    fetchWeatherMock.mockResolvedValueOnce(weather);

    await expect(getSharedLivePropInputs(key, context)).resolves.toMatchObject({
      oddsByBookmaker,
      weather,
    });
    expect(persistObservationMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("renews a slow refresh with an owner-guarded database update", async () => {
    vi.useFakeTimers();
    let resolveOdds!: (value: ReturnType<typeof oddsFetch>) => void;
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ event_id: "evt-1" }]);
    fetchOddsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOdds = resolve;
        })
    );
    fetchWeatherMock.mockResolvedValueOnce(weather);

    const refresh = getSharedLivePropInputs(key, context);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_001);

    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[2][0]).toContain("SET refresh_lease_until");
    expect(queryMock.mock.calls[2][0]).toContain("refresh_owner = $5");
    expect(queryMock.mock.calls[2][1][4]).toBe(queryMock.mock.calls[1][1][4]);

    resolveOdds(oddsFetch());
    await expect(refresh).resolves.toMatchObject({ oddsByBookmaker, weather });
    expect(queryMock).toHaveBeenCalledTimes(4);
  });

  it("cancels the sibling upstream request before releasing a failed refresh", async () => {
    let oddsSignal: AbortSignal | undefined;
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([]);
    fetchOddsMock.mockImplementationOnce(
      (
        _sportKey: string,
        _eventId: string,
        _marketKey: string,
        _playerName: string,
        signal: AbortSignal
      ) => {
        oddsSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    );
    fetchWeatherMock.mockRejectedValueOnce(new Error("weather unavailable"));

    await expect(getSharedLivePropInputs(key, context)).rejects.toThrow(
      "weather unavailable"
    );
    expect(oddsSignal?.aborted).toBe(true);
    expect(queryMock.mock.calls[2][0]).toContain("refresh_owner = NULL");
  });
});
