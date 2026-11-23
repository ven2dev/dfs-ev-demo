import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { buildWatchPropId } from "@/lib/watchPropId";
import { STALE_TIMEOUT_MS } from "@/lib/streamConfig";
import { useLiveOddsStream } from "./useLiveOddsStream";

vi.mock("@/lib/authHeaders", () => ({ getAuthHeaders: vi.fn(async () => ({})) }));

// Real byte stream behind a deferred HTTP response; no EventSource shim in production.
class FakeStream {
  static instances: FakeStream[] = [];
  closed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolve!: (value: Response) => void;
  private reject!: (reason: Error) => void;
  private opened = false;
  private body = new ReadableStream<Uint8Array>({
    start: controller => { this.controller = controller; },
    cancel: () => { this.closed = true; },
  });
  response = new Promise<Response>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(readonly url: string, signal: AbortSignal) {
    FakeStream.instances.push(this);
    signal.addEventListener("abort", () => { this.closed = true; this.reject(new Error("aborted")); }, { once: true });
  }
  onopen = () => {
    if (this.closed || this.opened) return;
    this.opened = true;
    this.resolve(new Response(this.body, { headers: { "Content-Type": "text/event-stream" } }));
  };
  onmessage = (event: { data: string }) => {
    if (this.closed) return;
    this.onopen();
    this.controller.enqueue(new TextEncoder().encode(`data: ${event.data}\n\n`));
  };
  onerror = () => {
    if (this.closed) return;
    this.closed = true;
    if (this.opened) this.controller.error(new Error("fixture network failure"));
    else this.reject(new Error("fixture network failure"));
  };
}
const installFetch = () => vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) =>
  new FakeStream(url, init.signal!).response));
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
    await flush();

const initialState = useAppStore.getState();

afterEach(async () => {
  await flush();
  useAppStore.setState(initialState, true);
  FakeStream.instances = [];
  vi.mocked(getAuthHeaders).mockReset().mockResolvedValue({});
  vi.restoreAllMocks();
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
  it("does not open a connection, and reports disconnected, when nothing is being watched", async () => {
    installFetch();
    useAppStore.setState({ connectionStatus: "live" }); // simulate a stale prior status

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();

    expect(FakeStream.instances).toHaveLength(0);
    expect(useAppStore.getState().connectionStatus).toBe("disconnected");
    unmount();
  });

  it("connects once a real selection is watched, without needing a remount", async () => {
    installFetch();
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();
    expect(FakeStream.instances).toHaveLength(0);

    await act(() => {
      useAppStore.getState().setPrimaryWatch(samplePrimaryWatch);
    });
    await flush();

    expect(FakeStream.instances).toHaveLength(1);
    expect(FakeStream.instances[0].url).toBe(expectedUrl(5));
    unmount();
  });
});

describe("useLiveOddsStream: connection URL", () => {
  it("opens the initial connection with the watched selection and current sampleWindow", async () => {
    installFetch();
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 7 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();

    expect(FakeStream.instances).toHaveLength(1);
    expect(FakeStream.instances[0].url).toBe(expectedUrl(7));
    unmount();
  });

  it("reconnects with the new sampleWindow when the user changes it", async () => {
    installFetch();
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();
    const first = FakeStream.instances[0];
    expect(first.url).toBe(expectedUrl(5));

    await act(() => {
      useAppStore.setState({
        matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      });
    });
    await flush();

    expect(first.closed).toBe(true);
    expect(FakeStream.instances).toHaveLength(2);
    expect(FakeStream.instances[1].url).toBe(expectedUrl(3));
    unmount();
  });

  it("reconnects to the new selection when the user watches a DIFFERENT prop, not just on a sampleWindow change", async () => {
    installFetch();
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();
    const first = FakeStream.instances[0];

    await act(() => {
      useAppStore.getState().setPrimaryWatch({ ...samplePrimaryWatch, playerName: "Sam Darnold" });
    });
    await flush();

    expect(first.closed).toBe(true);
    expect(FakeStream.instances).toHaveLength(2);
    expect(FakeStream.instances[1].url).toBe(expectedUrl(5, { playerName: "Sam Darnold" }));
    unmount();
  });

  it("does NOT reconnect on a non-window matchup-config update", async () => {
    // useSampleWindow's granular selector ensures unrelated config
    // updates do not tear down and reopen the SSE connection.
    installFetch();
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
      primaryWatch: samplePrimaryWatch,
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();
    expect(FakeStream.instances).toHaveLength(1);

    await act(() => {
      const current = useAppStore.getState().matchupConfig;
      useAppStore.setState({
        matchupConfig: {
          ...current,
          environment: { ...current.environment, windSpeedMph: 12, currentLine: 231.5 },
        },
      });
    });
    await flush();

    expect(FakeStream.instances).toHaveLength(1);
    expect(FakeStream.instances[0].closed).toBe(false);
    unmount();
  });

  it("retains the selected prop's complete snapshot with its original window while reconnecting", async () => {
    installFetch();
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
    await flush();

    await act(() => {
      useAppStore.setState({
        matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      });
    });
    await flush();

    const entry = useAppStore.getState().watchlist[samplePropId];
    expect(entry).toMatchObject({
      propId: samplePropId,
      sampleWindow: 5,
      sampleSize: 4,
      updatedAt: 123,
      refreshState: "updating",
      stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.5 },
      dataSource: "live",
      evHistory: [],
      evScore: { modelProb: 0.6, impliedProb: 0.5, edge: 0.1 },
      recentStatAverage: 233.5,
      line: 214.5,
      marketConsensus: { method: "exact-line-median", version: 1, contributingBookCount: 4 },
      weather: { temperatureF: 60, windSpeedMph: 8, precipitationMm: 0 },
    });
    await act(() => FakeStream.instances[1].onopen?.());
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBe("updating");
    unmount();
  });

  it("creates a blank keyed snapshot immediately when switching watches", async () => {
    installFetch();
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
    await flush();
    const nextWatch = { ...samplePrimaryWatch, playerName: "Sam Darnold" };

    await act(() => useAppStore.getState().setPrimaryWatch(nextWatch));
    await flush();

    const nextSnapshot = useAppStore.getState().watchlist[buildWatchPropId(nextWatch)];
    expect(nextSnapshot.line).toBeUndefined();
    expect(nextSnapshot.weather).toBeUndefined();
    expect(useAppStore.getState().connectionStatus).toBe("connecting");
    unmount();
  });

  it("stores consensus provenance from a matching live tick", async () => {
    installFetch();
    useAppStore.setState({ primaryWatch: samplePrimaryWatch });

    const { unmount } = renderHook(() => useLiveOddsStream());
    await flush();
    const source = FakeStream.instances[0];

    await act(() => {
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
    await flush();

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
  const receive = async (source: FakeStream, data: unknown) => {
    await act(() => source.onmessage({ data: JSON.stringify(data) }));
    await flush();
  };
  const start = async () => {
    installFetch();
    useAppStore.setState({ primaryWatch: samplePrimaryWatch });
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    const source = FakeStream.instances[0];
    await receive(source, tick(5, 123));
    return { ...hook, source };
  };

  it("replaces the old window atomically and rejects a late callback from the retired stream", async () => {
    const { source, unmount } = await start();
    await act(() => useAppStore.setState({ matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 } }));
    await flush();
    const replacement = FakeStream.instances[1];
    await receive(replacement, tick(3, 456, 0.12));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({
      sampleWindow: 3, sampleSize: 3, updatedAt: 456,
      evHistory: [{ timestamp: 456, evScore: 0.12 }],
    });
    await receive(source, tick(5, 999, 0.99));
    await act(() => source.onerror?.());
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(456);
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().connectionStatus).toBe("live");
    unmount();
  });

  it("retains values after an upstream tick failure and clears the failure on recovery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, unmount } = await start();
    await receive(source, { type: "error", message: "provider unavailable" });
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "failed", line: 250.5 });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    expect(error.mock.calls).toEqual([["[live-stream] payload-error"]]);
    await receive(source, tick(5, 456));
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(456);
    unmount();
    error.mockRestore();
  });

  it("keeps the last result through disconnect, reconnect and opening until a valid tick arrives", async () => {
    vi.useFakeTimers();
    const { source, unmount } = await start();
    await act(() => source.onerror?.());
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "failed" });
    await act(() => vi.advanceTimersByTime(1000));
    await flush();
    const next = FakeStream.instances[1];
    await act(() => next.onopen?.());
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "updating" });
    await receive(source, tick(5, 999));
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBe(123);
    await receive(next, tick(5, 456));
    expect(useAppStore.getState().watchlist[samplePropId].refreshState).toBeUndefined();
    expect(useAppStore.getState().watchlist[samplePropId].evHistory).toHaveLength(2);
    unmount();
  });

  it.each(["idle", "timeout"])("marks a retained value paused on %s", async (state) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, unmount } = await start();
    if (state === "idle") await receive(source, { type: "idle", message: "polling cap" });
    else await act(() => vi.advanceTimersByTime(STALE_TIMEOUT_MS));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "paused" });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    unmount();
    warn.mockRestore();
  });

  it("restores only the previously selected prop's own snapshot when returning to it", async () => {
    const { unmount } = await start();
    await act(() => useAppStore.getState().setPrimaryWatch({ ...samplePrimaryWatch, playerName: "Sam Darnold" }));
    await flush();
    const other = useAppStore.getState().watchlist[buildWatchPropId({ ...samplePrimaryWatch, playerName: "Sam Darnold" })];
    expect(other.evScore).toBeUndefined();
    await act(() => useAppStore.getState().setPrimaryWatch(samplePrimaryWatch));
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 123, refreshState: "updating", line: 250.5 });
    unmount();
  });
});

describe("useLiveOddsStream: observed quote history", () => {
  const tick = (timestamp: number, extra: Record<string, unknown> = {}) => ({
    type: "tick", propId: samplePropId, dataSource: "fixture", timestamp, sampleWindow: 5,
    line: 247.5, quote: { bookmakerKey: "draftkings", price: 1.8 },
    evScore: { modelProb: 0.6, impliedProb: 0.52, edge: 0.08 },
    stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.6 }, ...extra,
  });
  const receive = async (source: FakeStream, data: unknown) => {
    await act(() => source.onmessage({ data: JSON.stringify(data) }));
    await flush();
  };
  const start = async () => {
    installFetch();
    useAppStore.setState({ primaryWatch: samplePrimaryWatch });
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    return { ...hook, source: FakeStream.instances[0] };
  };

  it("captures immutable per-tick context rather than backfilling earlier quotes", async () => {
    const { source, unmount } = await start();
    await receive(source, tick(100));
    await receive(source, tick(200, { line: 249.5, quote: { bookmakerKey: "draftkings", price: 2 } }));
    const current = useAppStore.getState().watchlist[samplePropId];
    expect(current.evHistory[0].context).toEqual({ propId: samplePropId, bookmakerKey: "draftkings", direction: "over",
      sampleWindow: 5, dataSource: "fixture", line: 247.5, price: 1.8, marketProbability: 0.52 });
    expect(current.evHistory[1].context).toMatchObject({ line: 249.5, price: 2 });
    expect(current.quote).toEqual({ bookmakerKey: "draftkings", price: 2, line: 249.5, timestamp: 200, dataSource: "fixture" });
    expect(FakeStream.instances).toHaveLength(1);
    unmount();
  });

  it("keeps an earlier valid quote but does not insert it into a context-less new observation", async () => {
    const { source, unmount } = await start();
    await receive(source, tick(100));
    await receive(source, tick(200, { line: 249.5, quote: undefined }));
    const current = useAppStore.getState().watchlist[samplePropId];
    expect(current.quote).toMatchObject({ price: 1.8, line: 247.5, timestamp: 100 });
    expect(current.evHistory[1].context?.price).toBeUndefined();
    expect(current.evHistory[1].context?.bookmakerKey).toBeUndefined();
    unmount();
  });

  it("starts a new observation history after remount while retaining the last valid result", async () => {
    const first = await start();
    await receive(first.source, tick(100));
    const previousSession = first.result.current;
    first.unmount();
    const second = renderHook(() => useLiveOddsStream());
    await flush();
    const retained = useAppStore.getState().watchlist[samplePropId];
    expect(second.result.current).not.toBe(previousSession);
    expect(retained.evHistory).toEqual([]);
    expect(retained.line).toBe(247.5);
    expect(retained.updatedAt).toBe(100);
    expect(retained.refreshState).toBe("updating");
    await receive(FakeStream.instances.at(-1)!, tick(200));
    expect(useAppStore.getState().watchlist[samplePropId].evHistory).toHaveLength(1);
    second.unmount();
  });

  it("drops hydrated legacy history at the next observed tick without inventing price context", async () => {
    const { source, unmount } = await start();
    await act(() => useAppStore.setState({ watchlist: { [samplePropId]: {
      propId: samplePropId, sampleWindow: 5, evHistory: [{ timestamp: 1, evScore: 0.99 }],
    } } }));
    await flush();
    await receive(source, tick(200, { quote: undefined }));
    const current = useAppStore.getState().watchlist[samplePropId];
    expect(current.evHistory).toHaveLength(1);
    expect(current.evHistory[0].timestamp).toBe(200);
    expect(current.evHistory[0].context?.price).toBeUndefined();
    unmount();
  });
  it("marks stale odds as paused without inventing a new history point or observation time", async () => {
    const { source, unmount } = await start();
    await receive(source, tick(100));
    const history = useAppStore.getState().watchlist[samplePropId].evHistory;
    await receive(source, tick(500, { type: "stale", oddsStatus: "stale", oddsCapturedAt: new Date(50).toISOString(),
      line: 249.5, quote: { bookmakerKey: "draftkings", price: 2 } }));
    const current = useAppStore.getState().watchlist[samplePropId];
    expect(current.evHistory).toEqual(history);
    expect(current).toMatchObject({ line: 249.5, updatedAt: 50, refreshState: "paused",
      quote: { timestamp: 50, price: 2 } });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    await receive(source, tick(600, { oddsStatus: "fresh" }));
    expect(useAppStore.getState().watchlist[samplePropId].evHistory).toHaveLength(2);
    expect(useAppStore.getState().connectionStatus).toBe("live");
    unmount();
  });

  it("can show a first stale result without creating an observed-price history", async () => {
    const { source, unmount } = await start();
    await receive(source, tick(500, { type: "stale", oddsStatus: "stale", oddsCapturedAt: new Date(50).toISOString() }));
    expect(useAppStore.getState().watchlist[samplePropId]).toMatchObject({ updatedAt: 50,
      evHistory: [], refreshState: "paused", line: 247.5 });
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    unmount();
  });

  it.each([{ oddsStatus: "stale" }, { oddsStatus: "unavailable" }, { oddsStatus: "unexpected" }])(
    "does not treat malformed availability metadata as fresh: %j", async extra => {
      const { source, unmount } = await start();
      await receive(source, tick(100));
      await receive(source, tick(500, extra));
      const current = useAppStore.getState().watchlist[samplePropId];
      expect(current.updatedAt).toBe(100);
      expect(current.evHistory).toHaveLength(1);
      expect(useAppStore.getState().connectionStatus).toBe("stale");
      unmount();
    }
  );

});

describe("useLiveOddsStream: authenticated fetch lifecycle", () => {
  const watch = () => useAppStore.setState({ primaryWatch: samplePrimaryWatch });
  const changeIdentity = async () => {
    await act(() => useAppStore.setState(state => ({ identityGeneration: state.identityGeneration + 1 })));
    await flush();
  };

  it("refreshes headers on EOF reconnect, keeps secrets out of URLs, and cancels on unmount", async () => {
    vi.useFakeTimers();
    installFetch();
    vi.mocked(getAuthHeaders).mockResolvedValue({ Authorization: "Bearer synthetic" });
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    const first = FakeStream.instances[0];
    expect(first.url).not.toContain("synthetic");
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic");
    await act(() => first.onerror());
    await flush();
    await act(() => vi.advanceTimersByTime(1_000));
    await flush();
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
    expect(FakeStream.instances).toHaveLength(2);
    hook.unmount();
    await flush();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(FakeStream.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps 1→30 second backoff and the 300 second Retry-After deadline across identity changes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      const before = fetch.mock.calls.length;
      await act(() => vi.advanceTimersByTime(delay - 1));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(before);
      await act(() => vi.advanceTimersByTime(1));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(before + 1);
    }
    fetch.mockImplementation(async () => new Response(null, { status: 429, headers: { "Retry-After": "999" } }));
    await act(() => vi.advanceTimersByTime(30_000));
    await flush();
    const before = fetch.mock.calls.length;
    await changeIdentity();
    await act(() => vi.advanceTimersByTime(299_999));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(before);
    await act(() => vi.advanceTimersByTime(1));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(before + 1);
    hook.unmount();
  });

  it("connects immediately on a prop change during the previous effect's 16 second network backoff", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("synthetic network failure"));
    vi.stubGlobal("fetch", fetch);
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await act(() => vi.advanceTimersByTime(delay));
      await flush();
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    // The next retry would wait 16s, but a new selection gets its own local backoff.
    await act(() => useAppStore.getState().setPrimaryWatch({ ...samplePrimaryWatch, playerName: "Sam Darnold" }));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls[5][0]).toBe(expectedUrl(5, { playerName: "Sam Darnold" }));
    hook.unmount();
  });

  it("preserves a server's 120 second Retry-After across an identity change", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {
      status: 429, headers: { "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", fetch);
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    await act(() => vi.advanceTimersByTime(20_000));
    await changeIdentity();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(99_999));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(1));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("ignores late auth completions through StrictMode and A→B→A identity changes", async () => {
    installFetch();
    const finishes: ((headers: HeadersInit) => void)[] = [];
    vi.mocked(getAuthHeaders).mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    watch();
    const hook = renderHook(() => useLiveOddsStream(), { wrapper: StrictMode });
    await flush();
    await changeIdentity();
    await changeIdentity();
    for (const finish of finishes) finish({ Authorization: "Bearer synthetic" });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    hook.unmount();
    await flush();
  });

  it("ignores a queued frame when the prop window changes before delivery", async () => {
    installFetch();
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    const first = FakeStream.instances[0];
    await act(() => first.onopen());
    await flush();
    act(() => {
      first.onmessage({ data: JSON.stringify({
        type: "tick", propId: samplePropId, sampleWindow: 5, timestamp: 999,
        evScore: { edge: 0.1 }, stages: { baseRate: 0.5 },
      }) });
      useAppStore.setState(state => ({ matchupConfig: { ...state.matchupConfig, sampleWindow: 7 } }));
    });
    await flush();
    expect(useAppStore.getState().watchlist[samplePropId].updatedAt).toBeUndefined();
    expect(first.closed).toBe(true);
    expect(FakeStream.instances).toHaveLength(2);
    expect(FakeStream.instances[1].url).toBe(expectedUrl(7));
    hook.unmount();
  });

  it("keeps one independent attempt per client without reconnecting on unrelated auth status changes", async () => {
    installFetch();
    watch();
    const first = renderHook(() => useLiveOddsStream());
    const second = renderHook(() => useLiveOddsStream());
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
    await act(() => useAppStore.setState({ authStatus: "loading" }));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    first.unmount();
    second.unmount();
    await flush();
    expect(FakeStream.instances.every(stream => stream.closed)).toBe(true);
  });

  it("waits for slow reader cancellation before the newest identity opens a replacement", async () => {
    let finishCancellation!: () => void;
    const cancel = vi.fn(() => new Promise<void>(resolve => { finishCancellation = resolve; }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "text/event-stream" } },
    )).mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    await changeIdentity();
    await changeIdentity();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    finishCancellation();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it.each(["idle", "malformed"])("never reconnects after terminal %s", async kind => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      kind === "idle" ? 'data: {"type":"idle"}\n\n' : 'data: not-json\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetch);
    watch();
    const hook = renderHook(() => useLiveOddsStream());
    await flush();
    await act(() => vi.advanceTimersByTime(600_000));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().connectionStatus).toBe("stale");
    hook.unmount();
    warn.mockRestore();
  });
});
