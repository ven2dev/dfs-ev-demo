import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { buildWatchPropId } from "@/lib/watchPropId";
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

  it("clears the selected prop's complete live snapshot on reconnect", () => {
    // Reproduces a real review finding, twice over: an earlier fix only
    // cleared stages/evHistory, missing evScore and recentStatAverage --
    // neither is gated behind `stages` in the UI, so the live edge, the
    // sparkline, "Avg last N games," and the PickEm entry-impact number
    // all kept showing OLD-window values under the NEW window's label
    // until the first fresh tick landed.
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
      watchlist: {
        [samplePropId]: {
          propId: samplePropId,
          evScore: { modelProb: 0.6, impliedProb: 0.5, edge: 0.1 },
          evHistory: [{ timestamp: 1, evScore: 0.1 }],
          stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.5 },
          recentStatAverage: 233.5,
          line: 214.5,
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
    expect(entry.stages).toBeUndefined();
    expect(entry.evHistory).toEqual([]);
    expect(entry.evScore).toBeUndefined();
    expect(entry.recentStatAverage).toBeUndefined();
    expect(entry.line).toBeUndefined();
    expect(entry.weather).toBeUndefined();
    // The entry's identity (propId) survives -- only the window-
    // dependent fields are cleared.
    expect(entry.propId).toBe(samplePropId);
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
});
