"use client";

import { useEffect, useState, useRef } from "react";
import { openLiveStream, type LiveStreamFailure, type LiveStreamAttempt } from "@/lib/liveStream";
import { getAuthHeaders } from "@/lib/authHeaders";
import { isOddsDataSource } from "@/lib/oddsDataSource";
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
  const identityGeneration = useAppStore(state => state.identityGeneration);
  const primaryWatch = usePrimaryWatch();
  const retryNotBefore = useRef(0);
  const activeAttempt = useRef<LiveStreamAttempt | undefined>(undefined);
  const teardown = useRef<Promise<void>>(Promise.resolve());
  const [historySessionId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!primaryWatch) {
      setConnectionStatus("disconnected");
      return;
    }

    const selection = primaryWatch;
    let generation = 0;
    const retire = () => {
      const previous = activeAttempt.current;
      activeAttempt.current = undefined;
      previous?.close();
      // Persist across effect replacements: cancellation can finish asynchronously.
      if (previous) teardown.current = teardown.current.then(() => previous.done);
    };
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
          evHistory: existing?.historySessionId === historySessionId ? existing.evHistory : [],
          historySessionId,
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

    const connect = async () => {
      if (cancelled) return;
      const epoch = ++generation;
      retire();
      await teardown.current;
      if (cancelled || epoch !== generation) return;
      if (Date.now() < retryNotBefore.current) {
        reconnectTimer = setTimeout(connect, retryNotBefore.current - Date.now());
        return;
      }
      setConnectionStatus("connecting");
      markRefresh("updating");
      const params = new URLSearchParams({
        eventId: selection.eventId,
        sportKey: selection.sportKey,
        marketKey: selection.marketKey,
        playerName: selection.playerName,
        bookmakerKey: selection.bookmakerKey,
        direction: selection.direction,
        sampleWindow: String(sampleWindow),
      });
      const isCurrent = () => !cancelled && epoch === generation;
      const source = openLiveStream({
        url: `/api/stream?${params.toString()}`,
        getHeaders: getAuthHeaders,
        fetch: globalThis.fetch,
        isCurrent,
        onOpen: () => onOpen(),
        onData: onMessage,
        onFailure: failure => onFailure(failure),
      });
      activeAttempt.current = source;

      const onOpen = () => {
        if (!isCurrent()) return;
        setConnectionStatus("live");
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        // Opening a connection does not replace the retained result.
        resetStaleTimer();
      };

      function onMessage(value: Record<string, unknown>) {
        if (!isCurrent()) return;
        // This is our same-origin wire shape. Retain the existing field checks below.
        const data = value as Partial<WatchedProp> & {
          type?: string;
          timestamp: number;
          oddsStatus?: string;
          oddsCapturedAt: string;
          evScore?: NonNullable<WatchedProp["evScore"]>;
        };

        if (data.type === "error") {
          console.error("[live-stream] payload-error");
          markRefresh("failed");
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        if (data.type === "idle") {
          source.close();
          console.warn("[live-stream] idle");
          markRefresh("paused");
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        if (!["tick", "stale"].includes(data.type ?? "") || data.propId !== expectedPropId) return;
        if (data.sampleWindow !== undefined && data.sampleWindow !== sampleWindow) return;
        if (!data.evScore || !data.stages || !Number.isFinite(data.timestamp)
          || !Number.isFinite(data.evScore.edge)) return;

        const staleOdds = data.type === "stale" || data.oddsStatus === "stale";
        const observedAt = staleOdds ? Date.parse(data.oddsCapturedAt) : data.timestamp;
        if (!Number.isFinite(observedAt) || (data.oddsStatus !== undefined
          && !["fresh", "upstream", "stale"].includes(data.oddsStatus))) {
          markRefresh("failed");
          setConnectionStatus("stale");
          if (staleTimer) clearTimeout(staleTimer);
          return;
        }

        const line = Number.isFinite(data.line) ? data.line as number : undefined;
        const quote = line !== undefined && data.quote?.bookmakerKey === selection.bookmakerKey
          && Number.isFinite(data.quote.price) && data.quote.price > 1
          ? { bookmakerKey: data.quote.bookmakerKey as string, price: data.quote.price as number,
            line, timestamp: observedAt as number,
            dataSource: isOddsDataSource(data.dataSource) ? data.dataSource : undefined }
          : undefined;

        const state = useAppStore.getState();
        const existing = state.watchlist[data.propId];
        const retainedHistory = existing?.sampleWindow === sampleWindow && existing.historySessionId === historySessionId
          ? existing.evHistory : [];
        state.setWatchlist({
          ...state.watchlist,
          [data.propId]: {
            propId: data.propId,
            dataSource: data.dataSource,
            evScore: data.evScore,
            evHistory: staleOdds ? retainedHistory : [
              ...retainedHistory,
              { timestamp: data.timestamp, evScore: data.evScore.edge, context: {
                propId: expectedPropId, bookmakerKey: quote?.bookmakerKey,
                direction: selection.direction, sampleWindow,
                dataSource: isOddsDataSource(data.dataSource) ? data.dataSource : undefined,
                line, price: quote?.price,
                marketProbability: Number.isFinite(data.evScore.impliedProb)
                  && data.evScore.impliedProb >= 0 && data.evScore.impliedProb <= 1 ? data.evScore.impliedProb : undefined,
              } },
            ],
            historySessionId,
            quote: quote ?? existing?.quote,
            stages: data.stages,
            sampleWindow,
            sampleSize: typeof data.sampleSize === "number" && Number.isInteger(data.sampleSize)
              && data.sampleSize > 0 && data.sampleSize <= sampleWindow
              ? data.sampleSize : undefined,
            updatedAt: observedAt,
            refreshState: staleOdds ? "paused" : undefined,
            recentStatAverage: data.recentStatAverage,
            line: data.line,
            marketConsensus: data.marketConsensus,
            weather: data.weather,
          },
        });
        setConnectionStatus(staleOdds ? "stale" : "live");
        if (staleOdds) {
          if (staleTimer) clearTimeout(staleTimer);
        } else resetStaleTimer();
      }

      const onFailure = (failure: LiveStreamFailure) => {
        if (!isCurrent()) return;
        markRefresh(failure.reason === "idle" ? "paused" : "failed");
        setConnectionStatus(failure.retry ? "disconnected" : "stale");
        retire();
        if (staleTimer) clearTimeout(staleTimer);
        if (!failure.retry) return;
        // Only server deadlines survive prop/identity effect replacement.
        if (failure.after !== undefined) retryNotBefore.current = Date.now() + failure.after;
        reconnectTimer = setTimeout(connect, Math.max(reconnectDelay, retryNotBefore.current - Date.now()));
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      generation++;
      retire();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [setConnectionStatus, sampleWindow, primaryWatch, historySessionId, identityGeneration]);
  return historySessionId;
}
