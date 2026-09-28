"use client";

import { useEffect } from "react";
import { STALE_TIMEOUT_MS } from "@/lib/streamConfig";
import { useAppStore } from "./index";
import { useSetConnectionStatus, useSampleWindow } from "./hooks";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useLiveOddsStream() {
  const setConnectionStatus = useSetConnectionStatus();
  // Selected via its own granular hook (not the whole matchupConfig
  // object) specifically so this effect only reconnects when the user
  // actually changes the sample window -- not on every tick's
  // environment/line update, which writes into that same object.
  const sampleWindow = useSampleWindow();

  useEffect(() => {
    let eventSource: EventSource | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    // Every previously-recorded stages/evHistory value was computed
    // under whatever sampleWindow was active AT THE TIME -- on a
    // reconnect (this effect re-running because sampleWindow changed),
    // those numbers are stale relative to the label now showing the NEW
    // window, until the first fresh tick lands. A no-op on initial
    // mount (nothing to clear yet); real on every window change.
    const currentWatchlist = useAppStore.getState().watchlist;
    useAppStore.getState().setWatchlist(
      Object.fromEntries(
        Object.entries(currentWatchlist).map(([id, entry]) => [
          id,
          { ...entry, stages: undefined, evHistory: [] },
        ])
      )
    );

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => setConnectionStatus("stale"), STALE_TIMEOUT_MS);
    };

    const connect = () => {
      eventSource = new EventSource(`/api/stream?sampleWindow=${sampleWindow}`);

      eventSource.onopen = () => {
        setConnectionStatus("live");
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        resetStaleTimer();
      };

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "error") {
          // Transient fetch failure server-side (e.g. odds/weather API
          // hiccup) — the connection itself is fine and will retry next
          // interval, but this must be visible somewhere, not silently
          // dropped.
          console.error("[useLiveOddsStream] server-side tick error:", data.message);
          return;
        }

        if (data.type === "idle") {
          // Server hit its per-connection request-safety cap and stopped
          // polling — no more ticks are coming until a refresh, so reflect
          // that immediately rather than waiting for the passive staleness
          // timeout to eventually catch up.
          console.warn("[useLiveOddsStream] stream idle:", data.message);
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        if (data.type !== "tick") return;

        setConnectionStatus("live");
        resetStaleTimer();

        const currentWatchlist = useAppStore.getState().watchlist;
        const existing = currentWatchlist[data.propId];
        useAppStore.getState().setWatchlist({
          ...currentWatchlist,
          [data.propId]: {
            propId: data.propId,
            evScore: data.evScore,
            evHistory: [
              ...(existing?.evHistory ?? []),
              { timestamp: data.timestamp, evScore: data.evScore.edge },
            ],
            // Computed server-side (real odds/weather) on every tick --
            // carried through as-is rather than recomputed client-side
            // against stale data, which is what page.tsx used to do.
            stages: data.stages,
            recentStatAverage: data.recentStatAverage,
          },
        });

        if (data.weather) {
          const currentConfig = useAppStore.getState().matchupConfig;
          useAppStore.getState().setMatchupConfig({
            ...currentConfig,
            environment: {
              ...currentConfig.environment,
              windSpeedMph: data.weather.windSpeedMph,
              precipitationMm: data.weather.precipitationMm,
              temperatureF: data.weather.temperatureF,
              // Live line, kept alongside environment so every input to a
              // client-side recompute is consistently sourced from the
              // same latest tick, rather than mixing live and seeded values.
              currentLine: data.line,
            },
          });
        }
      };

      eventSource.onerror = () => {
        setConnectionStatus("disconnected");
        eventSource?.close();
        if (staleTimer) clearTimeout(staleTimer);
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [setConnectionStatus, sampleWindow]);
}
