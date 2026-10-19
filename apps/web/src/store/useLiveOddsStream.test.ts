import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { buildWatchPropId } from "@/lib/watchPropId";
import { STALE_TIMEOUT_MS } from "@/lib/streamConfig";
import { useLiveOddsStream } from "./useLiveOddsStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const samplePrimaryWatch = {
  eventId: "evt-1",
  sportKey: "americanfootball_nfl",
  homeTeam: "Chicago Bears",
  awayTeam: "Philadelphia Eagles",
  startTime: "2026-10-05T17:00:00Z",
  marketKey: "player_pass_yds",
  propType: "Passing Yards",
  playerName: "Jalen Hurts",
  bookmakerKey: "draftkings",
  direction: "over" as const,
};

const samplePropId = buildWatchPropId(samplePrimaryWatch);

const expectedUrl = (sampleWindow: number, overrides: Partial<typeof samplePrimaryWatch> = {}) => {
  const selection = { ...samplePrimaryWatch, ...overrides };
  const params = new URLSearchParams({
    eventId: selection.eventId,
    sportKey: selection.sportKey,
    marketKey: selection.marketKey,
    playerName: selection.playerName,
    bookmakerKey: selection.bookmakerKey,
    direction: selection.direction,
    sampleWindow: String(sampleWindow),
  });
  return `/api/stream?${params.toString()}`;
};

describe("useLiveOddsStream: no watched selection yet", () => {
  it("does not open a connection, and reports disconnected, when nothing is being watched", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({ connectionStatus: "live" }); // simulate a stale prior status

    const { unmount } = renderHook(() => useLiveOddsStream());

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(useAppStore.getState().connectionStatus).toBe("disconnected");
    unmount();
  });

  it("connects once a real selection is watched, without needing a remount", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    expect(FakeEventSource.instances).toHaveLength(0);

    act(() => {
      useAppStore.getState().setPrimaryWatch(samplePrimaryWatch);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(expectedUrl(5));
    unmount();
  });
});

describe("useLiveOddsStream: connection URL", () => {
  it("opens the initial connection with the watched selection and current sampleWindow", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 7 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(expectedUrl(7));
    unmount();
  });

  it("reconnects with the new sampleWindow when the user changes it", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    const first = FakeEventSource.instances[0];
    expect(first.url).toBe(expectedUrl(5));

    act(() => {
      useAppStore.setState({
        matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      });
    });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe(expectedUrl(3));
    unmount();
  });

  it("reconnects to the new selection when the user watches a DIFFERENT prop, not just on a sampleWindow change", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    const first = FakeEventSource.instances[0];

    act(() => {
      useAppStore.getState().setPrimaryWatch({ ...samplePrimaryWatch, playerName: "Sam Darnold" });
    });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe(expectedUrl(5, { playerName: "Sam Darnold" }));
    unmount();
  });

  it("does NOT reconnect on a non-window matchup-config update", () => {
    // useSampleWindow's granular selector ensures unrelated config
    // updates do not tear down and reopen the SSE connection.
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      const current = useAppStore.getState().matchupConfig;
      useAppStore.setState({
        matchupConfig: {
          ...current,
          environment: { ...current.environment, windSpeedMph: 12, currentLine: 231.5 },
        },
      });
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
    unmount();
  });

  it("retains the selected prop's complete snapshot with its original window while reconnecting", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
      watchlist: {
        [samplePropId]: {
          propId: samplePropId,
          dataSource: "live",
          sampleWindow: 5,
          sampleSize: 4,
          updatedAt: 123,
          evScore: { modelProb: 0.6, impliedProb: 0.5, edge: 0.1 },
          evHistory: [{ timestamp: 1, evScore: 0.1 }],
          stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.5 },
          recentStatAverage: 233.5,
          line: 214.5,
          marketConsensus: {
            method: "exact-line-median",
            version: 1,
            contributingBookCount: 4,
          },
          weather: { temperatureF: 60, windSpeedMph: 8, precipitationMm: 0 },
        },
      },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());

    act(() => {
      useAppStore.setState({
        matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      });
    });

    const entry = useAppStore.getState().watchlist[samplePropId];
    expect(entry).toMatchObject({
      propId: samplePropId,
      sampleWindow: 5,
      sampleSize: 4,
      updatedAt: 123,
      refreshState: "updating",
      stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.5 },
      dataSource: "live",
      evHistory: [{ timestamp: 1, evScore: 0.1 }],
      evScore: { modelProb: 0.6, impliedProb: 0.5, edge: 0.1 },
      recentStatAverage: 233.5,
      line: 214.5,
      marketConsensus: { method: "exact-line-median", version: 1, contributingBookCount: 4 },
      weather: { temperatureF: 60, windSpeedMph: 8, precipitationMm: 0 },
    });
    act(() => FakeEventSource.instances[1].onopen?.());
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBe("updating");
    unmount();
  });

  it("creates a blank keyed snapshot immediately when switching watches", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      primaryWatch: samplePrimaryWatch,
      watchlist: {
        [samplePropId]: {
          propId: samplePropId,
          evHistory: [],
          line: 214.5,
          weather: { temperatureF: 60, windSpeedMph: 8, precipitationMm: 0 },
        },
      },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    const nextWatch = { ...samplePrimaryWatch, playerName: "Sam Darnold" };

    act(() => useAppStore.getState().setPrimaryWatch(nextWatch));

    const nextSnapshot = useAppStore.getState().watchlist[buildWatchPropId(nextWatch)];
    expect(nextSnapshot.line).toBeUndefined();
    expect(nextSnapshot.weather).toBeUndefined();
    expect(useAppStore.getState().connectionStatus).toBe("connecting");
    unmount();
  });

  it("stores consensus provenance from a matching live tick", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({ primaryWatch: samplePrimaryWatch });

    const { unmount } = renderHook(() => useLiveOddsStream());
    const source = FakeEventSource.instances[0];

    act(() => {
      source.onmessage?.({
        data: JSON.stringify({
          type: "tick",
          dataSource: "fixture",
          propId: samplePropId,
          timestamp: 123,
          sampleWindow: 5,
          sampleSize: 3,
          line: 250.5,
          weather: { temperatureF: 65, windSpeedMph: 5, precipitationMm: 0 },
          evScore: { modelProb: 0.6, impliedProb: 0.52, edge: 0.08 },
          stages: { baseRate: 0.7, afterEnvironment: 0.65, afterCoverage: 0.6 },
          recentStatAverage: 255,
          marketConsensus: {
            method: "exact-line-median",
            version: 1,
            contributingBookCount: 4,
          },
        }),
      });
    });

    expect(useAppStore.getState().watchlist[samplePropId].marketConsensus).toEqual({
      method: "exact-line-median",
      version: 1,
      contributingBookCount: 4,
    });
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({
      dataSource: "fixture", sampleWindow: 5, sampleSize: 3, updatedAt: 123,
    });
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    unmount();
  });
});

describe("useLiveOddsStream: retained-result lifecycle", () => {
  const tick = (window: 3 | 5 | 7, timestamp: number, edge = 0.08) => ({
    type: "tick", dataSource: "live", propId: samplePropId, timestamp,
    sampleWindow: window, sampleSize: window, line: 250.5,
    evScore: { modelProb: 0.6, impliedProb: 0.52, edge },
    stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.6 },
    recentStatAverage: 255,
  });
  const receive = (source: FakeEventSource, data: unknown) => act(() => {
    source.onmessage?.({ data: JSON.stringify(data) });
  });
  const start = () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({ primaryWatch: samplePrimaryWatch });
    const hook = renderHook(() => useLiveOddsStream());
    const source = FakeEventSource.instances[0];
    receive(source, tick(5, 123));
    return { ...hook, source };
  };

  it("replaces the old window atomically and rejects a late callback from the retired stream", () => {
    const { source, unmount } = start();
    act(() => useAppStore.setState({ matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 } }));
    const replacement = FakeEventSource.instances[1];
    receive(replacement, tick(3, 456, 0.12));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({
      sampleWindow: 3, sampleSize: 3, updatedAt: 456,
      evHistory: [{ timestamp: 456, evScore: 0.12 }],
    });
    receive(source, tick(5, 999, 0.99));
    act(() => source.onerror?.());
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(456);
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().connectionStatus).toBe("live");
    unmount();
  });

  it("retains values after an upstream tick failure and clears the failure on recovery", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, unmount } = start();
    receive(source, { type: "error", message: "provider unavailable" });
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "failed", line: 250.5 });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    receive(source, tick(5, 456));
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(456);
    unmount();
    error.mockRestore();
  });

  it("keeps the last result through disconnect, reconnect and opening until a valid tick arrives", () => {
    vi.useFakeTimers();
    const { source, unmount } = start();
    act(() => source.onerror?.());
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "failed" });
    act(() => vi.advanceTimersByTime(1000));
    const next = FakeEventSource.instances[1];
    act(() => next.onopen?.());
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "updating" });
    receive(source, tick(5, 999));
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(123);
    receive(next, tick(5, 456));
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().watchlist[samplePropId].evHistory).toHaveLength(2);
    unmount();
  });

  it.each(["idle", "timeout"])("marks a retained value paused on %s", (state) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, unmount } = start();
    if (state === "idle") receive(source, { type: "idle", message: "polling cap" });
    else act(() => vi.advanceTimersByTime(STALE_TIMEOUT_MS));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "paused" });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    unmount();
    warn.mockRestore();
  });

  it("restores only the previously selected prop's own snapshot when returning to it", () => {
    const { unmount } = start();
    act(() => useAppStore.getState().setPrimaryWatch({ ...samplePrimaryWatch, playerName: "Sam Darnold" }));
    const other = useAppStore.getState().watchlist[buildWatchPropId({ ...samplePrimaryWatch, playerName: "Sam Darnold" })];
    expect(other.evScore).toBeUndefined();
    act(() => useAppStore.getState().setPrimaryWatch(samplePrimaryWatch));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "updating", line: 250.5 });
    unmount();
  });
});
