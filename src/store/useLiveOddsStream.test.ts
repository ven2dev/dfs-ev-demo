import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
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

describe("useLiveOddsStream: sampleWindow in the connection URL", () => {
  it("opens the initial connection with the current sampleWindow", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 7 },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/stream?sampleWindow=7");
    unmount();
  });

  it("reconnects with the new sampleWindow when the user changes it", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
    });

    const { unmount } = renderHook(() => useLiveOddsStream());
    const first = FakeEventSource.instances[0];
    expect(first.url).toBe("/api/stream?sampleWindow=5");

    act(() => {
      useAppStore.setState({
        matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      });
    });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe("/api/stream?sampleWindow=3");
    unmount();
  });

  it("does NOT reconnect on an environment-only update from a live tick (same sampleWindow)", () => {
    // This is the exact regression useSampleWindow's granular selector
    // guards against: a tick's setMatchupConfig call updates
    // environment/currentLine on the same matchupConfig object every
    // ~90s -- that must never tear down and reopen the SSE connection.
    vi.stubGlobal("EventSource", FakeEventSource);
    useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 5 },
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
});
