"use client";

import { useEffect, useMemo, useState } from "react";
import { PLAYER_PROP_MARKETS } from "@/lib/playerPropMarkets";
import { getAllBookmakerKeys } from "@/lib/discoveredProps";
import { getCurrentNflWeekLabel } from "@/lib/nflWeek";
import { PlayerPropsCard } from "@/components/PlayerPropsCard";
import { BookmakerLinesSheet, type SeeAllTarget } from "@/components/BookmakerLinesSheet";
import {
  useCheckedMarketKeys,
  useDiscoveredProps,
  useDiscoveryError,
  useDiscoveryStatus,
  useRealSlate,
  useRealSlateError,
  useRealSlateStatus,
  useSelectedEventId,
  useSetDiscoveredProps,
  useSetDiscoveryError,
  useSetDiscoveryStatus,
  useSetRealSlate,
  useSetRealSlateError,
  useSetRealSlateStatus,
  useSetSelectedEventId,
  useToggleMarketKey,
} from "@/store/hooks";

const MAX_COMPARISON_BOOKMAKERS = 3;

const formatKickoff = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// Browse-only: real event list, real market checklist, real discovered
// lines. No "watch"/"track" action yet -- that's #27 step 7's job, once
// a real selection actually drives the live EV pipeline. Read-only here
// on purpose, to avoid shipping a button that looks actionable but
// doesn't do anything real yet.
export const SlateBrowser = () => {
  const realSlate = useRealSlate();
  const realSlateStatus = useRealSlateStatus();
  const realSlateError = useRealSlateError();
  const setRealSlate = useSetRealSlate();
  const setRealSlateStatus = useSetRealSlateStatus();
  const setRealSlateError = useSetRealSlateError();

  const selectedEventId = useSelectedEventId();
  const setSelectedEventId = useSetSelectedEventId();

  const checkedMarketKeys = useCheckedMarketKeys();
  const toggleMarketKey = useToggleMarketKey();

  const discoveredProps = useDiscoveredProps();
  const discoveryStatus = useDiscoveryStatus();
  const discoveryError = useDiscoveryError();
  const setDiscoveredProps = useSetDiscoveredProps();
  const setDiscoveryStatus = useSetDiscoveryStatus();
  const setDiscoveryError = useSetDiscoveryError();

  // Presentation-only, not app state -- which book is currently shown,
  // whether compare mode is active, which books it's comparing, and
  // which single prop's "see all" sheet is open. None of this needs to
  // survive a re-selection of the event/markets, so it stays local
  // rather than in the store.
  const [selectedBookmakerKey, setSelectedBookmakerKey] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonBookmakerKeys, setComparisonBookmakerKeys] = useState<string[]>([]);
  const [seeAllTarget, setSeeAllTarget] = useState<SeeAllTarget | null>(null);

  const allBookmakerKeys = useMemo(() => getAllBookmakerKeys(discoveredProps), [discoveredProps]);

  // Adjust state during render, not in an effect (React's own documented
  // pattern for "reset some state when a computed value changes") -- the
  // useMemo above keeps allBookmakerKeys referentially stable unless
  // discoveredProps itself changes, so this only fires on a REAL change,
  // not every render. A fresh discovery result can drop the book that
  // was selected (a different market set may not include it) or arrive
  // with none selected yet -- default to the first real book rather than
  // show a stale/invalid one.
  const [prevAllBookmakerKeys, setPrevAllBookmakerKeys] = useState(allBookmakerKeys);
  if (allBookmakerKeys !== prevAllBookmakerKeys) {
    setPrevAllBookmakerKeys(allBookmakerKeys);
    if (allBookmakerKeys.length === 0) {
      setSelectedBookmakerKey(null);
    } else if (!selectedBookmakerKey || !allBookmakerKeys.includes(selectedBookmakerKey)) {
      setSelectedBookmakerKey(allBookmakerKeys[0]);
    }
  }

  // Free call, safe to run on every mount -- fetches once, not on a
  // timer; the picker just needs today's real game list, not a live feed.
  useEffect(() => {
    let ignore = false;
    setRealSlateStatus("loading");
    fetch("/api/slate")
      .then((res) => res.json())
      .then((data) => {
        if (ignore) return;
        if (!data.success) {
          setRealSlateStatus("error");
          setRealSlateError(data.reason ?? "Failed to load the real slate");
          return;
        }
        setRealSlate(data.events);
        setRealSlateStatus("loaded");
      })
      .catch((err) => {
        if (ignore) return;
        setRealSlateStatus("error");
        setRealSlateError(String(err));
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount, not on every setter-identity change
  }, []);

  // Explicit trigger, not auto-fetch-on-toggle -- checking several boxes
  // batches into ONE request, matching how the discovery cache was
  // designed (missing markets batched into a single Odds API call).
  const fetchDiscoveredProps = (forceRefresh: boolean) => {
    if (!selectedEventId || checkedMarketKeys.length === 0) return;

    setDiscoveryStatus("loading");
    setDiscoveryError(null);

    const params = new URLSearchParams({ markets: checkedMarketKeys.join(",") });
    if (forceRefresh) params.set("refresh", "true");

    fetch(`/api/slate/${selectedEventId}/props?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          setDiscoveryStatus("error");
          setDiscoveryError(data.reason ?? "Failed to load props");
          return;
        }
        setDiscoveredProps(data.players);
        setDiscoveryStatus("loaded");
      })
      .catch((err) => {
        setDiscoveryStatus("error");
        setDiscoveryError(String(err));
      });
  };

  const cycleBookmaker = (direction: 1 | -1) => {
    if (allBookmakerKeys.length === 0 || !selectedBookmakerKey) return;
    const currentIndex = allBookmakerKeys.indexOf(selectedBookmakerKey);
    const nextIndex =
      (currentIndex + direction + allBookmakerKeys.length) % allBookmakerKeys.length;
    setSelectedBookmakerKey(allBookmakerKeys[nextIndex]);
  };

  const toggleComparisonBookmaker = (bookmakerKey: string) => {
    setComparisonBookmakerKeys((current) =>
      current.includes(bookmakerKey)
        ? current.filter((key) => key !== bookmakerKey)
        : current.length < MAX_COMPARISON_BOOKMAKERS
          ? [...current, bookmakerKey]
          : current
    );
  };

  const sortedSlate = [...realSlate].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );

  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-medium">Browse the {getCurrentNflWeekLabel()} slate</h2>

      {realSlateStatus === "loading" && (
        <p className="mt-2 text-sm text-zinc-500">Loading this week&rsquo;s games…</p>
      )}
      {realSlateStatus === "error" && (
        <p className="mt-2 text-sm text-red-600">{realSlateError}</p>
      )}

      {realSlateStatus === "loaded" && (
        <>
          <select
            aria-label="Select a game"
            className="mt-3 w-full rounded border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            value={selectedEventId ?? ""}
            onChange={(event) => setSelectedEventId(event.target.value || null)}
          >
            <option value="">Select a game…</option>
            {sortedSlate.map((slateEvent) => (
              <option key={slateEvent.id} value={slateEvent.id}>
                {slateEvent.awayTeam} @ {slateEvent.homeTeam} —{" "}
                {formatKickoff(slateEvent.commenceTime)}
              </option>
            ))}
          </select>

          {selectedEventId && (
            <div className="mt-4">
              <p className="text-sm font-medium">Which prop markets?</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PLAYER_PROP_MARKETS.map((market) => (
                  <label key={market.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checkedMarketKeys.includes(market.key)}
                      onChange={() => toggleMarketKey(market.key)}
                    />
                    {market.label}
                  </label>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fetchDiscoveredProps(false)}
                  disabled={checkedMarketKeys.length === 0 || discoveryStatus === "loading"}
                  className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  {discoveryStatus === "loading" ? "Loading…" : "Show props"}
                </button>
                {discoveredProps.length > 0 && (
                  <button
                    type="button"
                    onClick={() => fetchDiscoveredProps(true)}
                    disabled={discoveryStatus === "loading"}
                    className="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
                  >
                    Refresh odds
                  </button>
                )}
              </div>

              {discoveryStatus === "error" && (
                <p className="mt-2 text-sm text-red-600">{discoveryError}</p>
              )}

              {discoveredProps.length > 0 && (
                <div className="mt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    {!comparisonMode && selectedBookmakerKey && (
                      <div className="flex items-center gap-2 text-sm">
                        <button
                          type="button"
                          aria-label="Previous bookmaker"
                          onClick={() => cycleBookmaker(-1)}
                          className="rounded px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        >
                          ‹
                        </button>
                        <span className="min-w-24 text-center font-medium">
                          {selectedBookmakerKey}
                        </span>
                        <button
                          type="button"
                          aria-label="Next bookmaker"
                          onClick={() => cycleBookmaker(1)}
                          className="rounded px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        >
                          ›
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setComparisonMode((current) => !current)}
                      className={`rounded px-3 py-2 text-sm ${
                        comparisonMode
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "border border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      Compare books
                    </button>
                  </div>

                  {comparisonMode && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {allBookmakerKeys.map((bookmakerKey) => {
                        const checked = comparisonBookmakerKeys.includes(bookmakerKey);
                        const atLimit =
                          !checked && comparisonBookmakerKeys.length >= MAX_COMPARISON_BOOKMAKERS;
                        return (
                          <label
                            key={bookmakerKey}
                            className={`flex items-center gap-1.5 rounded border px-2 py-1.5 text-sm ${
                              atLimit
                                ? "border-zinc-100 text-zinc-400 dark:border-zinc-900"
                                : "border-zinc-300 dark:border-zinc-700"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={atLimit}
                              onChange={() => toggleComparisonBookmaker(bookmakerKey)}
                            />
                            {bookmakerKey}
                          </label>
                        );
                      })}
                      <p className="w-full text-xs text-zinc-400">
                        Up to {MAX_COMPARISON_BOOKMAKERS} bookmakers, space permitting.
                      </p>
                    </div>
                  )}

                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {discoveredProps.map((player) => (
                      <PlayerPropsCard
                        key={player.playerName}
                        player={player}
                        mode={comparisonMode ? "compare" : "single"}
                        selectedBookmakerKey={selectedBookmakerKey}
                        comparisonBookmakerKeys={comparisonBookmakerKeys}
                        onSeeAll={(marketKey) =>
                          setSeeAllTarget({ playerName: player.playerName, marketKey })
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <BookmakerLinesSheet
        target={seeAllTarget}
        players={discoveredProps}
        onClose={() => setSeeAllTarget(null)}
      />
    </section>
  );
};
