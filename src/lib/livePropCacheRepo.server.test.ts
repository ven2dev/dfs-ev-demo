import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const fetchOddsMock = vi.fn();
const fetchWeatherMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

vi.mock("./oddsApi", () => ({
  fetchPlayerPropMarketOdds: fetchOddsMock,
}));

vi.mock("./weather", () => ({
  fetchGameWeather: fetchWeatherMock,
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

afterEach(() => {
  queryMock.mockReset();
  fetchOddsMock.mockReset();
  fetchWeatherMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getSharedLivePropInputs", () => {
  it("acquires the database lease, fetches both inputs once, and writes one shared payload", async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockResolvedValueOnce([{ event_id: "evt-1" }]);
    fetchOddsMock.mockResolvedValueOnce(oddsByBookmaker);
    fetchWeatherMock.mockResolvedValueOnce(weather);

    await expect(getSharedLivePropInputs(key, context)).resolves.toEqual({
      oddsByBookmaker,
      weather,
    });

    expect(fetchOddsMock).toHaveBeenCalledTimes(1);
    expect(fetchOddsMock).toHaveBeenCalledWith(
      key.sportKey,
      key.eventId,
      key.marketKey,
      key.playerName,
      expect.any(AbortSignal)
    );
    expect(fetchWeatherMock).toHaveBeenCalledWith(
      context.startTime,
      context.venueLat,
      context.venueLon,
      expect.any(AbortSignal)
    );
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[1][0]).toContain("ON CONFLICT");
    expect(queryMock.mock.calls[1][0]).toContain("refresh_lease_until");
  });

  it("serves a fresh database payload without touching either upstream API", async () => {
    queryMock.mockResolvedValueOnce([
      {
        payload: { oddsByBookmaker, weather },
        fetched_at: new Date().toISOString(),
      },
    ]);

    await expect(getSharedLivePropInputs(key, context)).resolves.toEqual({
      oddsByBookmaker,
      weather,
    });
    expect(fetchOddsMock).not.toHaveBeenCalled();
    expect(fetchWeatherMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("fails open with the fresh upstream result when its cache update fails", async () => {
    const writeError = new Error("write failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ refresh_owner: "owner" }])
      .mockRejectedValueOnce(writeError)
      .mockResolvedValueOnce([]);
    fetchOddsMock.mockResolvedValueOnce(oddsByBookmaker);
    fetchWeatherMock.mockResolvedValueOnce(weather);

    await expect(getSharedLivePropInputs(key, context)).resolves.toEqual({
      oddsByBookmaker,
      weather,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[livePropCacheRepo] failed to persist refreshed inputs:",
      writeError
    );
    expect(queryMock.mock.calls[3][0]).toContain("refresh_owner = NULL");
  });

  it("renews a slow refresh with an owner-guarded database update", async () => {
    vi.useFakeTimers();
    let resolveOdds!: (value: typeof oddsByBookmaker) => void;
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

    resolveOdds(oddsByBookmaker);
    await expect(refresh).resolves.toEqual({ oddsByBookmaker, weather });
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
