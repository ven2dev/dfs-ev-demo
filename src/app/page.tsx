"use client";

import { useEffect, useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import { HitRateSummary } from "@/components/HitRateSummary";
import { ResultFreshness } from "@/components/ResultFreshness";
import { MarketConsensusSummary } from "@/components/MarketConsensusSummary";
import { SlateBrowser } from "@/components/SlateBrowser";
import { getAuthHeaders } from "@/lib/authHeaders";
import { getOddsProvenanceCopy } from "@/lib/oddsProvenance";
import { computeEntryHitProbability } from "@/lib/pickEm";
import { buildWatchPropId } from "@/lib/watchPropId";
import { mockGoal } from "@/store/mockData";
import {
  useAuthStatus,
  useConnectionStatus,
  useDataLoadError,
  useDataVerified,
  useGoal,
  useMatchupConfig,
  usePrimaryWatch,
  useSecondaryWatch,
  useSetGoal,
  useSetMatchupConfig,
  useWatchlist,
} from "@/store/hooks";
import { useAppStore } from "@/store";
import { useLiveOddsStream } from "@/store/useLiveOddsStream";
import { toggleWatchedProp } from "@/store/watchlistToggle";

const STAGES = [
  { key: "baseRate", label: "Recent hit rate" },
  { key: "afterEnvironment", label: "Illustrative weather adjustment" },
  { key: "afterCoverage", label: "Coverage adjustment (sample data)" },
  { key: "final", label: "Illustrative edge" },
] as const;

export default function Home() {
  useLiveOddsStream();

  const authStatus = useAuthStatus();
  const dataVerified = useDataVerified();
  const dataLoadError = useDataLoadError();
  const connectionStatus = useConnectionStatus();
  const matchupConfig = useMatchupConfig();
  const setMatchupConfig = useSetMatchupConfig();
  const primaryWatch = usePrimaryWatch();
  const secondaryWatch = useSecondaryWatch();
  const watchlist = useWatchlist();
  const goal = useGoal();
  const setGoal = useSetGoal();

  const watched = primaryWatch ? watchlist[buildWatchPropId(primaryWatch)] : undefined;
  const provenance = getOddsProvenanceCopy(watched?.dataSource);

  // A second, independently-watched discovered prop (#27 step 7) -- NOT wired
  // into SSE tracking, same as before. This section exists purely
  // to demonstrate the optimistic-update + rollback pattern in
  // isolation, per the brief's call for ONE example; it uses a second
  // slate selection instead of a hardcoded one.
  const isWatchingSecond = secondaryWatch
    ? Boolean(watchlist[buildWatchPropId(secondaryWatch)])
    : false;
  const [watchPending, setWatchPending] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  const handleWatchToggle = async () => {
    if (!secondaryWatch || watchPending || authStatus !== "signed-in") return;

    setWatchError(null);
    setWatchPending(true);

    const propId = buildWatchPropId(secondaryWatch);
    const result = await toggleWatchedProp(
      propId,
      { propId, evScore: { modelProb: 0, impliedProb: 0, edge: 0 }, evHistory: [] },
      {
        getUid: () => useAppStore.getState().uid,
        getWatchlistEntry: (id) => useAppStore.getState().watchlist[id],
        // Only ever touches this one key -- the SSE hook
        // concurrently updates a *different* key (the primary prop) on
        // its own schedule, and a full-object write would clobber
        // whatever it wrote while this request was in flight.
        setWatchlistEntry: (id, entry) => {
          const current = { ...useAppStore.getState().watchlist };
          if (entry) {
            current[id] = entry;
          } else {
            delete current[id];
          }
          useAppStore.getState().setWatchlist(current);
        },
        submit: async (id, wasWatching) => {
          const res = await fetch("/api/watchlist", {
            method: wasWatching ? "DELETE" : "POST",
            headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
            body: JSON.stringify({ propId: id }),
          });
          return res.json();
        },
      }
    );

    if (result.status === "reverted") {
      setWatchError(
        `Failed to ${result.wasWatching ? "unwatch" : "watch"} ${secondaryWatch.playerName}: ${
          (result.cause as Error).message
        } — reverted`
      );
    }
    setWatchPending(false);
  };

  // A genuine user preference change, worth persisting -- unlike
  // useLiveOddsStream's own setMatchupConfig calls (tick weather/line
  // refresh on every SSE tick), which stay local-only; persisting those
  // would write to Firestore every few seconds for every connected user.
  // No snapshot-and-revert on failure here, per the brief's call for ONE
  // rollback example (the watchlist toggle above) rather than one per
  // action -- a failed persist just means the choice doesn't survive a
  // reload, not a wrong or lost app state.
  const handleSampleWindowChange = (window: 3 | 5 | 7) => {
    const nextConfig = { ...matchupConfig, sampleWindow: window };
    setMatchupConfig(nextConfig);

    if (authStatus !== "signed-in") return;
    getAuthHeaders()
      .then((headers) =>
        fetch("/api/matchup-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(nextConfig),
        })
      )
      // fetch() only rejects on a network-level failure -- a 401 or 500
      // response resolves normally and would silently look like success
      // if nothing here actually inspects it.
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) {
          console.error("[matchup-config] persist failed:", data.reason);
        }
      })
      .catch((err) => console.error("[matchup-config] persist failed:", err));
  };

  // Deliberately NOT gated behind sign-in, unlike handleWatchToggle above.
  // This is what lets a signed-out visitor see a working Goal-impact
  // section on the demo matchup at all -- without it, the preview
  // experience we designed around would just show an empty state. There's
  // no real "build your own goal" UI yet (that's Phase 10, once a real
  // slate exists to build one against), so today this is the only source
  // of a goal for anyone, signed in or not.
  //
  // For a signed-in user, useInitAuth separately persists this SAME
  // mockGoal value to Firestore the first time it resolves no real goal
  // exists yet (see syncDataFromServer) -- issue #21's AC requires a
  // user's goal to survive a device switch, which this local-only seed
  // can't provide on its own, even though the content is still just the
  // shared placeholder either way.
  useEffect(() => {
    if (!goal) setGoal(mockGoal);
  }, [goal, setGoal]);

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

  // Every hook above this line must always run, in the same order, on
  // every render -- this early return has to come after all of them.
  // Persisted goal/watchlist can't be trusted to render until useInitAuth
  // has actually verified they belong to the current uid; otherwise a
  // hydration render can briefly show a different account's data before
  // the ownership check has had a chance to clear it.
  if (!dataVerified) {
    // Layout now owns the header/shell -- this only needs to render its
    // own content, not a full-screen wrapper duplicating layout's.
    return dataLoadError ? (
      // A genuine fetch failure, not just "still loading" -- shown
      // distinctly rather than an indefinite spinner, since we
      // genuinely don't know this account's real state yet.
      <div className="text-sm text-red-700 dark:text-red-400">
        {dataLoadError}{" "}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-11 min-w-11 items-center underline"
        >
          Reload
        </button>
      </div>
    ) : (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
    );
  }

  return (
    <>
      <SlateBrowser />

      {!primaryWatch && (
        <section className="min-w-0 break-words rounded-lg border border-zinc-200 p-4 sm:p-6 text-sm text-zinc-600 dark:text-zinc-400 dark:border-zinc-800">
          Select a game and a prop above, then click <strong>Watch</strong> to start
          tracking its EV here.
        </section>
      )}

      {primaryWatch && (
        <section className="min-w-0 break-words rounded-lg border border-zinc-200 p-4 sm:p-6 dark:border-zinc-800">
          {provenance.isFixture && (
            <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              Preview fixture data — teams, players, odds, weather, and history are
              fictional. No live provider calls are made.
            </p>
          )}
          <h2 className="text-lg font-medium">
            {primaryWatch.awayTeam} @ {primaryWatch.homeTeam}
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {primaryWatch.playerName} — {primaryWatch.propType}, line{" "}
            {watched?.line ?? "—"} ({primaryWatch.direction}, {primaryWatch.bookmakerKey};{" "}
            {provenance.line})
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {([3, 5, 7] as const).map((window) => (
              <button
                key={window}
                type="button"
                aria-pressed={matchupConfig.sampleWindow === window}
                onClick={() => handleSampleWindowChange(window)}
                className={`min-h-11 min-w-11 rounded px-3 py-2 text-sm ${
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
              on each new tick; exactly one node active at a time. */}
          <ol
            aria-label="Analysis pipeline"
            className="mt-6 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"
          >
            {STAGES.map((stage, i) => (
              <li
                key={stage.key}
                aria-current={i === activeStageIndex ? "step" : undefined}
                className={`flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                  i === activeStageIndex
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                }`}
              >
                <span aria-hidden="true" className="shrink-0 font-medium">{i + 1}.</span>
                <span className="break-words">{stage.label}</span>
              </li>
            ))}
          </ol>

          {watched?.stages && watched.evScore && (
            <div className="mt-6 space-y-3">
              <ResultFreshness
                snapshot={watched}
                requestedWindow={matchupConfig.sampleWindow}
                connectionStatus={connectionStatus}
              />
              <HitRateSummary
                rate={watched.stages.baseRate}
                adjustedRate={watched.evScore.modelProb}
                sampleSize={watched.sampleSize}
              />
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Weather and coverage adjustments are illustrative, not calibrated.
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm">
                <span>{provenance.environment}</span>
                <span className="whitespace-nowrap tabular-nums">{(watched.stages.afterEnvironment * 100).toFixed(1)}%</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm">
                <span>
                  Illustrative adjusted estimate{" "}
                  <em className="text-zinc-600 dark:text-zinc-400">(includes sample coverage data)</em>
                </span>
                <span className="whitespace-nowrap tabular-nums">{(watched.stages.afterCoverage * 100).toFixed(1)}%</span>
              </div>
              {watched.marketConsensus && watched.line !== undefined && (
                <MarketConsensusSummary
                  probability={watched.evScore.impliedProb}
                  direction={primaryWatch.direction}
                  line={watched.line}
                  consensus={watched.marketConsensus}
                />
              )}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-zinc-200 pt-3 text-sm font-medium dark:border-zinc-800">
                <span>
                  Illustrative edge vs. same-line market consensus{" "}
                  <em className="font-normal">(includes sample coverage data)</em>
                </span>
                <span
                  className={
                    `whitespace-nowrap tabular-nums ${watched.evScore.edge > 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`
                  }
                >
                  {(watched.evScore.edge * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          )}

          {watched?.recentStatAverage !== undefined && (
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
              Average · {watched.sampleSize === undefined ? "sample size unavailable" : `n = ${watched.sampleSize} games`}:{" "}
              {watched.recentStatAverage.toFixed(1)} {primaryWatch.propType.toLowerCase()}{" "}
              <em className="text-zinc-600 dark:text-zinc-400">
                ({provenance.history})
              </em>
            </p>
          )}

          {goal?.kind === "pickEm" && watched?.stages && watched.evScore !== undefined && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Adding this pick to your {goal.pickCount}-pick entry:{" "}
              {(computeEntryHitProbability(goal.picks) * 100).toFixed(1)}% →{" "}
              {(
                computeEntryHitProbability([
                  ...goal.picks,
                  {
                    propId: buildWatchPropId(primaryWatch),
                    direction: primaryWatch.direction,
                    impliedProb: watched.evScore.modelProb,
                  },
                ]) * 100
              ).toFixed(1)}%{" "}
              joint hit probability{" "}
              <em className="text-zinc-600 dark:text-zinc-400">
                (illustrative, uncalibrated estimate using the adjusted recent hit rate;
                includes sample coverage data and assumes independent picks)
              </em>
            </p>
          )}
        </section>
      )}

      <section className="min-w-0 break-words rounded-lg border border-zinc-200 p-4 sm:p-6 dark:border-zinc-800">
        <h2 className="text-lg font-medium">EV Tracker</h2>
        {watched?.stages && watched.evScore && primaryWatch ? (
          <div className="mt-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm">
              <span>
                {primaryWatch.playerName} — illustrative edge (includes sample coverage data)
              </span>
              <span className="whitespace-nowrap tabular-nums">{(watched.evScore.edge * 100).toFixed(1)}%</span>
            </div>
            <ResultFreshness
              snapshot={watched}
              requestedWindow={matchupConfig.sampleWindow}
              connectionStatus={connectionStatus}
              compact
            />
            <div className="mt-2">
              <Sparkline values={watched.evHistory.map((h) => h.evScore)} />
            </div>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {watched.evHistory.length} {provenance.ticks}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {primaryWatch ? provenance.waiting : "Nothing watched yet."}
          </p>
        )}

        {secondaryWatch && (
          <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {secondaryWatch.playerName} — {secondaryWatch.propType}
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Watch changes appear immediately and revert if saving fails.
                </p>
              </div>
              <button
                onClick={handleWatchToggle}
                disabled={watchPending}
                className={`min-h-11 min-w-11 rounded px-3 py-2 text-sm disabled:opacity-50 ${
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
            {authStatus !== "signed-in" ? (
              // Derived directly from live authStatus, not stored state --
              // storing this as a one-time "you clicked while signed out"
              // message left it stuck on screen after actually signing
              // in, since nothing re-ran to clear it until the next click.
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Sign in to watch this prop.</p>
            ) : (
              watchError && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{watchError}</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
