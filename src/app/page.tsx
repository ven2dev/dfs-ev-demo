"use client";

import { useEffect, useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import { MarketConsensusSummary } from "@/components/MarketConsensusSummary";
import { SlateBrowser } from "@/components/SlateBrowser";
import { getAuthHeaders } from "@/lib/authHeaders";
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
  { key: "baseRate", label: "Base rate" },
  { key: "afterEnvironment", label: "Environment adjustment" },
  { key: "afterCoverage", label: "Coverage adjustment (mocked)" },
  { key: "final", label: "Final EV" },
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

  // A second, independently-watched real prop (#27 step 7) -- NOT wired
  // into live SSE tracking, same as before. This section exists purely
  // to demonstrate the optimistic-update + rollback pattern in
  // isolation, per the brief's call for ONE example; it just uses a
  // second real selection now instead of a hardcoded mock one.
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
        // Only ever touches this one key -- the live SSE hook
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
  // useLiveOddsStream's own setMatchupConfig calls (live weather/line
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
      <div className="text-sm text-red-600">
        {dataLoadError}{" "}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="underline"
        >
          Reload
        </button>
      </div>
    ) : (
      <p className="text-sm text-zinc-500">Loading…</p>
    );
  }

  const statusColor =
    connectionStatus === "live"
      ? "bg-green-500"
      : connectionStatus === "stale"
        ? "bg-yellow-500"
        : connectionStatus === "connecting"
          ? "bg-blue-500"
          : "bg-red-500";

  return (
    <>
      <SlateBrowser />

      {!primaryWatch && (
        <section className="rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          Select a game and a prop above, then click <strong>Watch</strong> to start
          tracking its live EV here.
        </section>
      )}

      {primaryWatch && (
        <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
          <h2 className="text-lg font-medium">
            {primaryWatch.awayTeam} @ {primaryWatch.homeTeam}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {primaryWatch.playerName} — {primaryWatch.propType}, line{" "}
            {watched?.line ?? "—"} ({primaryWatch.direction}, {primaryWatch.bookmakerKey}; real
            player-prop line, live Odds API)
          </p>

          <div className="mt-4 flex gap-2">
            {([3, 5, 7] as const).map((window) => (
              <button
                key={window}
                onClick={() => handleSampleWindowChange(window)}
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

          {watched?.stages && watched.evScore && (
            <div className="mt-6 space-y-3">
              <div className="flex justify-between text-sm">
                <span>Base rate ({matchupConfig.sampleWindow}-game hit rate)</span>
                <span>{(watched.stages.baseRate * 100).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>After environment adjustment (real weather)</span>
                <span>{(watched.stages.afterEnvironment * 100).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>
                  After coverage adjustment{" "}
                  <em className="text-zinc-400">(sample data — mocked)</em>
                </span>
                <span>{(watched.stages.afterCoverage * 100).toFixed(1)}%</span>
              </div>
              {watched.marketConsensus && watched.line !== undefined && (
                <MarketConsensusSummary
                  probability={watched.evScore.impliedProb}
                  direction={primaryWatch.direction}
                  line={watched.line}
                  consensus={watched.marketConsensus}
                />
              )}
              <div className="flex justify-between border-t border-zinc-200 pt-3 text-sm font-medium dark:border-zinc-800">
                <span>Final EV (edge, vs. same-line market consensus)</span>
                <span
                  className={
                    watched.evScore.edge > 0 ? "text-green-600" : "text-red-600"
                  }
                >
                  {(watched.evScore.edge * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          )}

          {watched?.recentStatAverage !== undefined && (
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
              Avg last {matchupConfig.sampleWindow} games:{" "}
              {watched.recentStatAverage.toFixed(1)} {primaryWatch.propType.toLowerCase()}{" "}
              <em className="text-zinc-400">
                (historical average, not a projection — no predictive model yet)
              </em>
            </p>
          )}

          {goal?.kind === "pickEm" && watched?.evScore !== undefined && (
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
              <em className="text-zinc-400">
                (independence-assumption estimate, using our model&rsquo;s probability
                for this pick, not the market&rsquo;s — legs from the same game can be
                correlated, which this doesn&rsquo;t account for)
              </em>
            </p>
          )}
        </section>
      )}

      <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Live Tracker</h2>
          <div className="flex items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
            <span className="capitalize">{connectionStatus}</span>
          </div>
        </div>
        {watched?.evScore && primaryWatch ? (
          <div className="mt-4">
            <div className="flex justify-between text-sm">
              <span>{primaryWatch.playerName} — live edge</span>
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
          <p className="mt-2 text-sm text-zinc-500">
            {primaryWatch ? "Waiting for first live tick…" : "Nothing watched yet."}
          </p>
        )}

        {secondaryWatch && (
          <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">
                  {secondaryWatch.playerName} — {secondaryWatch.propType}
                </p>
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
            {authStatus !== "signed-in" ? (
              // Derived directly from live authStatus, not stored state --
              // storing this as a one-time "you clicked while signed out"
              // message left it stuck on screen after actually signing
              // in, since nothing re-ran to clear it until the next click.
              <p className="mt-2 text-xs text-zinc-400">Sign in to watch this prop.</p>
            ) : (
              watchError && <p className="mt-2 text-xs text-red-600">{watchError}</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
