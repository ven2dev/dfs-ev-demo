"use client";

import { useEffect } from "react";
import { STALE_TIMEOUT_MS } from "@/lib/streamConfig";
import { buildWatchPropId } from "@/lib/watchPropId";
import type { WatchedProp } from "@/types";
import { useAppStore } from "./index";
import { usePrimaryWatch, useSetConnectionStatus, useSampleWindow } from "./hooks";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useLiveOddsStream() {
  const setConnectionStatus = useSetConnectionStatus();
  const sampleWindow = useSampleWindow();
  const primaryWatch = usePrimaryWatch();

  useEffect(() => {
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

    const markRefresh = (refreshState: WatchedProp["refreshState"]) => {
      const state = useAppStore.getState();
      const existing = state.watchlist[expectedPropId];
      // Retain the exact prop's last successful result and its own window.
      // Never copy values from the previously selected prop.
      state.setWatchlist({
        ...state.watchlist,
        [expectedPropId]: {
          ...existing,
          propId: expectedPropId,
          evHistory: existing?.evHistory ?? [],
          refreshState,
        },
      });
    };

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        markRefresh("paused");
        setConnectionStatus("stale");
      }, STALE_TIMEOUT_MS);
    };

    const connect = () => {
      if (cancelled) return;
      setConnectionStatus("connecting");
      markRefresh("updating");
      const params = new URLSearchParams({
        eventId: primaryWatch.eventId,
        sportKey: primaryWatch.sportKey,
        marketKey: primaryWatch.marketKey,
        playerName: primaryWatch.playerName,
        bookmakerKey: primaryWatch.bookmakerKey,
        direction: primaryWatch.direction,
        sampleWindow: String(sampleWindow),
      });
      const source = new EventSource(`/api/stream?${params.toString()}`);
      eventSource = source;
      const isCurrent = () => !cancelled && source === eventSource;

      source.onopen = () => {
        if (!isCurrent()) return;
        setConnectionStatus("live");
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        // Opening a connection does not replace the retained result.
        resetStaleTimer();
      };

      source.onmessage = (event) => {
        if (!isCurrent()) return;
        const data = JSON.parse(event.data);

        if (data.type === "error") {
          console.error("[useLiveOddsStream] server-side tick error:", data.message);
          markRefresh("failed");
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        if (data.type === "idle") {
          console.warn("[useLiveOddsStream] stream idle:", data.message);
          markRefresh("paused");
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        if (data.type !== "tick" || data.propId !== expectedPropId) return;
        if (data.sampleWindow !== undefined && data.sampleWindow !== sampleWindow) return;
        if (!data.evScore || !data.stages || !Number.isFinite(data.timestamp)) return;

        const state = useAppStore.getState();
        const existing = state.watchlist[data.propId];
        state.setWatchlist({
          ...state.watchlist,
          [data.propId]: {
            propId: data.propId,
            dataSource: data.dataSource,
            evScore: data.evScore,
            evHistory: [
              ...(existing?.sampleWindow === sampleWindow ? existing.evHistory : []),
              { timestamp: data.timestamp, evScore: data.evScore.edge },
            ],
            stages: data.stages,
            sampleWindow,
            sampleSize: Number.isInteger(data.sampleSize) && data.sampleSize > 0 && data.sampleSize <= sampleWindow
              ? data.sampleSize : undefined,
            updatedAt: data.timestamp,
            refreshState: undefined,
            recentStatAverage: data.recentStatAverage,
            line: data.line,
            marketConsensus: data.marketConsensus,
            weather: data.weather,
          },
        });
        setConnectionStatus("live");
        resetStaleTimer();
      };

      source.onerror = () => {
        if (!isCurrent()) return;
        markRefresh("failed");
        setConnectionStatus("disconnected");
        source.close();
        eventSource = undefined;
        if (staleTimer) clearTimeout(staleTimer);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
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
