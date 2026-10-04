"use client";

import { useEffect } from "react";
import { STALE_TIMEOUT_MS } from "@/lib/streamConfig";
import { buildWatchPropId } from "@/lib/watchPropId";
import { useAppStore } from "./index";
import { usePrimaryWatch, useSetConnectionStatus, useSampleWindow } from "./hooks";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useLiveOddsStream() {
  const setConnectionStatus = useSetConnectionStatus();
  // Selected via its own granular hook (not the whole matchupConfig
  // object) specifically so this effect only reconnects when the user
  // actually changes the sample window -- not on every tick's
  // environment/line update, which writes into that same object.
  const sampleWindow = useSampleWindow();
  const primaryWatch = usePrimaryWatch();

  useEffect(() => {
    // Nothing to track yet -- no selection has been watched. Make
    // sure a PREVIOUS connection (from before the user cleared it) is
    // reflected as disconnected, not left showing a stale "live" status.
    if (!primaryWatch) {
      setConnectionStatus("disconnected");
      return;
    }

    let eventSource: EventSource | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const expectedPropId = buildWatchPropId(primaryWatch);

    setConnectionStatus("connecting");

    // Clear the selected prop's complete tick snapshot before connecting.
    // This covers both sample-window changes and a new watched identity,
    // so no line, weather, EV, or history can render under a selection
    // that did not produce it.
    const currentWatchlist = useAppStore.getState().watchlist;
    const existingSnapshot = currentWatchlist[expectedPropId];
    useAppStore.getState().setWatchlist({
      ...currentWatchlist,
      [expectedPropId]: {
        ...existingSnapshot,
        propId: expectedPropId,
        dataSource: undefined,
        stages: undefined,
        evHistory: [],
        evScore: undefined,
        recentStatAverage: undefined,
        line: undefined,
        marketConsensus: undefined,
        weather: undefined,
      },
    });

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => setConnectionStatus("stale"), STALE_TIMEOUT_MS);
    };

    const connect = () => {
      const params = new URLSearchParams({
        eventId: primaryWatch.eventId,
        sportKey: primaryWatch.sportKey,
        marketKey: primaryWatch.marketKey,
        playerName: primaryWatch.playerName,
        bookmakerKey: primaryWatch.bookmakerKey,
        direction: primaryWatch.direction,
        sampleWindow: String(sampleWindow),
      });
      eventSource = new EventSource(`/api/stream?${params.toString()}`);

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
        if (data.propId !== expectedPropId) return;

        setConnectionStatus("live");
        resetStaleTimer();

        const currentWatchlist = useAppStore.getState().watchlist;
        const existing = currentWatchlist[data.propId];
        useAppStore.getState().setWatchlist({
          ...currentWatchlist,
          [data.propId]: {
            propId: data.propId,
            dataSource: data.dataSource,
            evScore: data.evScore,
            evHistory: [
              ...(existing?.evHistory ?? []),
              { timestamp: data.timestamp, evScore: data.evScore.edge },
            ],
            // Computed server-side from the tick's declared source and
            // carried through as-is rather than recomputed client-side
            // against stale data, which is what page.tsx used to do.
            stages: data.stages,
            recentStatAverage: data.recentStatAverage,
            line: data.line,
            marketConsensus: data.marketConsensus,
            weather: data.weather,
          },
        });
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
  }, [setConnectionStatus, sampleWindow, primaryWatch]);
}
