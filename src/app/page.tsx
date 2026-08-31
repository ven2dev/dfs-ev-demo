"use client";

import { useEffect, useMemo, useState } from "react";
import { computeEV } from "@/lib/computeEV";
import type { WatchedProp } from "@/types";
import {
  useConnectionStatus,
  useCurrentMatchup,
  useGoal,
  useMatchupConfig,
  useSetGoal,
  useSetMatchupConfig,
  useWatchlist,
} from "@/store/hooks";
import { useAppStore } from "@/store";
import { useLiveOddsStream } from "@/store/useLiveOddsStream";

const STAGES = [
  { key: "baseRate", label: "Base rate" },
  { key: "afterEnvironment", label: "Environment adjustment" },
  { key: "afterCoverage", label: "Coverage adjustment (mocked)" },
  { key: "final", label: "Final EV" },
] as const;

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-10 text-xs text-zinc-500">Collecting live data…</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-10 w-full text-blue-500">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function Home() {
  useLiveOddsStream();

  const connectionStatus = useConnectionStatus();
  const matchupConfig = useMatchupConfig();
  const setMatchupConfig = useSetMatchupConfig();
  const currentMatchup = useCurrentMatchup();
  const watchlist = useWatchlist();
  const goal = useGoal();
  const setGoal = useSetGoal();

  const prop = currentMatchup?.props[0];
  const watched = prop ? watchlist[prop.propId] : undefined;

  // Second seeded prop, deliberately not wired into live SSE tracking —
  // this section exists purely to demonstrate the optimistic-update +
  // rollback pattern in isolation, per the brief's call for ONE example.
  const secondProp = currentMatchup?.props[1];
  const isWatchingSecond = secondProp ? Boolean(watchlist[secondProp.propId]) : false;
  const [watchPending, setWatchPending] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  const handleWatchToggle = async () => {
    if (!secondProp || watchPending) return;
    setWatchError(null);
    setWatchPending(true);

    const propId = secondProp.propId;
    // Snapshot only this ONE entry's prior value, not the whole watchlist —
    // the live SSE hook concurrently updates a *different* key (the
    // primary prop) on its own schedule, and a full-object revert would
    // clobber whatever it wrote while this request was in flight.
    const previousEntry: WatchedProp | undefined =
      useAppStore.getState().watchlist[propId];
    const wasWatching = Boolean(previousEntry);

    // Always read the watchlist fresh at the moment of writing, and only
    // ever touch this one key — safe regardless of what else has changed
    // concurrently.
    const applyEntry = (entry: WatchedProp | undefined) => {
      const current = { ...useAppStore.getState().watchlist };
      if (entry) {
        current[propId] = entry;
      } else {
        delete current[propId];
      }
      useAppStore.getState().setWatchlist(current);
    };

    // Optimistic update, applied immediately, before the network call.
    applyEntry(
      wasWatching
        ? undefined
        : { propId, evScore: { modelProb: 0, impliedProb: 0, edge: 0 }, evHistory: [] }
    );

    try {
      const res = await fetch("/api/watchlist", {
        method: wasWatching ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propId }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.reason ?? "Unknown failure");
      }
    } catch (err) {
      // Revert only this entry to its pre-optimistic-update value.
      applyEntry(wasWatching ? previousEntry : undefined);
      setWatchError(
        `Failed to ${wasWatching ? "unwatch" : "watch"} ${secondProp.playerName}: ${
          (err as Error).message
        } — reverted`
      );
    } finally {
      setWatchPending(false);
    }
  };

  useEffect(() => {
    if (!goal) {
      setGoal({
        kind: "salaryCap",
        salaryCap: 50000,
        rosterSlots: 9,
        progress: { slotsFilled: 3, capUsed: 18500 },
      });
    }
  }, [goal, setGoal]);

  const pipeline = useMemo(() => {
    if (!prop || !watched) return null;
    return computeEV({
      recentGameStats: prop.recentGameStats,
      // Live line when available, falling back to the seeded reference
      // before the first tick — same source as windSpeedMph/precipitationMm
      // below, so every input here is consistently from the latest tick.
      line: (matchupConfig.environment.currentLine as number) ?? prop.line,
      sampleWindow: matchupConfig.sampleWindow,
      windSpeedMph: (matchupConfig.environment.windSpeedMph as number) ?? 0,
      precipitationMm: (matchupConfig.environment.precipitationMm as number) ?? 0,
      shadowCoverageRate:
        (matchupConfig.coverageFilters.shadowCoverageRate as number) ?? 0,
      impliedProb: watched.evScore.impliedProb,
    });
  }, [prop, watched, matchupConfig]);

  // Projected fantasy points: independent of the EV/edge calculation
  // (that's about betting value, not fantasy scoring) — a standard
  // passing-yards-to-points baseline (1 pt / 25 yards) off the same
  // (mocked) recent-game stat history used for the base rate.
  const projectedPts = useMemo(() => {
    if (!prop) return null;
    const avg =
      prop.recentGameStats.reduce((sum, v) => sum + v, 0) /
      prop.recentGameStats.length;
    return Math.round(avg / 25);
  }, [prop]);

  const [activeStageIndex, setActiveStageIndex] = useState(3);

  useEffect(() => {
    if (!watched) return;
    // New tick arrived — visually step through the pipeline stages in
    // sequence, mirroring the actual base -> environment -> coverage ->
    // final order computeEV() applies them in, rather than a static
    // highlight that never reflects an actual event.
    const timers = [0, 1, 2, 3].map((stageIndex) =>
      setTimeout(() => setActiveStageIndex(stageIndex), stageIndex * 350)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only step on a genuinely new tick, not every watched object identity change
  }, [watched?.evHistory.length]);

  const statusColor =
    connectionStatus === "live"
      ? "bg-green-500"
      : connectionStatus === "stale"
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">DFS Matchup EV Demo</h1>
          <div className="flex items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
            <span className="capitalize">{connectionStatus}</span>
          </div>
        </header>

        {currentMatchup && prop && (
          <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
            <h2 className="text-lg font-medium">
              {currentMatchup.awayTeam} @ {currentMatchup.homeTeam}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {prop.playerName} — {prop.propType}, line{" "}
              {(matchupConfig.environment.currentLine as number) ?? prop.line}{" "}
              (real player-prop line, live Odds API)
            </p>

            <div className="mt-4 flex gap-2">
              {([3, 5, 7] as const).map((window) => (
                <button
                  key={window}
                  onClick={() =>
                    setMatchupConfig({ ...matchupConfig, sampleWindow: window })
                  }
                  className={`rounded px-3 py-1 text-sm ${
                    matchupConfig.sampleWindow === window
                      ? "bg-black text-white dark:bg-white dark:text-black"
                      : "bg-zinc-100 dark:bg-zinc-900"
                  }`}
                >
                  Last {window}
                </button>
              ))}
            </div>

            {/* Active-node stepper — steps through base->env->coverage->final
                on each new live tick; exactly one node active at a time. */}
            <div className="mt-6 flex items-center gap-2 text-xs">
              {STAGES.map((stage, i) => (
                <div key={stage.key} className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-1 transition-colors ${
                      i === activeStageIndex
                        ? "bg-black text-white dark:bg-white dark:text-black"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900"
                    }`}
                  >
                    {stage.label}
                  </span>
                  {i < STAGES.length - 1 && <span className="text-zinc-300">→</span>}
                </div>
              ))}
            </div>

            {pipeline && (
              <div className="mt-6 space-y-3">
                <div className="flex justify-between text-sm">
                  <span>Base rate ({matchupConfig.sampleWindow}-game hit rate)</span>
                  <span>{(pipeline.baseRate * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>After environment adjustment (real weather)</span>
                  <span>{(pipeline.afterEnvironment * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>
                    After coverage adjustment{" "}
                    <em className="text-zinc-400">(sample data — mocked)</em>
                  </span>
                  <span>{(pipeline.afterCoverage * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between border-t border-zinc-200 pt-3 text-sm font-medium dark:border-zinc-800">
                  <span>Final EV (edge, vs. real devigged Odds API line)</span>
                  <span
                    className={
                      pipeline.evScore.edge > 0 ? "text-green-600" : "text-red-600"
                    }
                  >
                    {(pipeline.evScore.edge * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            )}

            {goal?.kind === "salaryCap" && projectedPts !== null && (
              <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
                +{projectedPts} projected pts · uses ${prop.salary.toLocaleString()}{" "}
                of remaining cap{" "}
                <em className="text-zinc-400">
                  (sample data — mocked stat history & salary)
                </em>
              </p>
            )}
          </section>
        )}

        <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
          <h2 className="text-lg font-medium">Live Tracker</h2>
          {watched && prop ? (
            <div className="mt-4">
              <div className="flex justify-between text-sm">
                <span>{prop.playerName} — live edge</span>
                <span>{(watched.evScore.edge * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-2">
                <Sparkline values={watched.evHistory.map((h) => h.evScore)} />
              </div>
              <p className="mt-1 text-xs text-zinc-400">
                {watched.evHistory.length} live ticks recorded
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">Waiting for first live tick…</p>
          )}

          {secondProp && (
            <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">{secondProp.playerName} — {secondProp.propType}</p>
                  <p className="text-xs text-zinc-400">
                    Optimistic watch/unwatch demo — REST call has a simulated
                    ~30% failure rate to demonstrate rollback
                  </p>
                </div>
                <button
                  onClick={handleWatchToggle}
                  disabled={watchPending}
                  className={`rounded px-3 py-1 text-sm disabled:opacity-50 ${
                    isWatchingSecond
                      ? "bg-zinc-100 dark:bg-zinc-900"
                      : "bg-black text-white dark:bg-white dark:text-black"
                  }`}
                >
                  {watchPending
                    ? "…"
                    : isWatchingSecond
                      ? "Unwatch"
                      : "Watch"}
                </button>
              </div>
              {watchError && (
                <p className="mt-2 text-xs text-red-600">{watchError}</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
