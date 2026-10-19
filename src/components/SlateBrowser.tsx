"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAYER_PROP_MARKETS,
  type PlayerPropDirection,
} from "@/lib/playerPropMarkets";
import { getAllBookmakerKeys } from "@/lib/discoveredProps";
import { isOddsDataSource, type OddsDataSource } from "@/lib/oddsDataSource";
import { PlayerPropsCard } from "@/components/PlayerPropsCard";
import { BookmakerLinesSheet, type SeeAllTarget } from "@/components/BookmakerLinesSheet";
import {
  useCheckedMarketKeys,
  useDiscoveredProps,
  useDiscoveredPropsEventId,
  useDiscoveredPropsMarketKeys,
  useDiscoveryError,
  useDiscoveryStatus,
  usePrimaryWatch,
  useRealSlate,
  useRealSlateError,
  useRealSlateStatus,
  useRealSlateWindow,
  useSecondaryWatch,
  useSelectedEventId,
  useSetDiscoveredProps,
  useSetDiscoveryError,
  useSetDiscoveryStatus,
  useSetPrimaryWatch,
  useSetRealSlate,
  useSetRealSlateError,
  useSetRealSlateStatus,
  useSetSecondaryWatch,
  useSetSelectedEventId,
  useToggleMarketKey,
} from "@/store/hooks";
import type { WatchSelection } from "@/types";
import { useAppStore } from "@/store";

const MAX_COMPARISON_BOOKMAKERS = 3;
const SLATE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const formatKickoff = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// Event list, market discovery, book comparison, and selection of
// a supported prop for the EV pipeline.
export const SlateBrowser = () => {
  const realSlate = useRealSlate();
  const realSlateStatus = useRealSlateStatus();
  const realSlateError = useRealSlateError();
  const realSlateWindow = useRealSlateWindow();
  const setRealSlate = useSetRealSlate();
  const setRealSlateStatus = useSetRealSlateStatus();
  const setRealSlateError = useSetRealSlateError();
  const [slateDataSource, setSlateDataSource] = useState<OddsDataSource | null>(null);

  const selectedEventId = useSelectedEventId();
  const setSelectedEventId = useSetSelectedEventId();

  const checkedMarketKeys = useCheckedMarketKeys();
  const toggleMarketKey = useToggleMarketKey();

  const discoveredProps = useDiscoveredProps();
  const discoveredPropsEventId = useDiscoveredPropsEventId();
  const discoveredPropsMarketKeys = useDiscoveredPropsMarketKeys();
  const discoveryStatus = useDiscoveryStatus();
  const discoveryError = useDiscoveryError();
  const setDiscoveredProps = useSetDiscoveredProps();
  const setDiscoveryStatus = useSetDiscoveryStatus();
  const setDiscoveryError = useSetDiscoveryError();

  const primaryWatch = usePrimaryWatch();
  const setPrimaryWatch = useSetPrimaryWatch();
  const secondaryWatch = useSecondaryWatch();
  const setSecondaryWatch = useSetSecondaryWatch();

  // Presentation-only, not app state -- which book is currently shown,
  // whether compare mode is active, which books it's comparing, and
  // which single prop's "see all" sheet is open. None of this needs to
  // survive a re-selection of the event/markets, so it stays local
  // rather than in the store.
  const [selectedBookmakerKey, setSelectedBookmakerKey] = useState<string | null>(null);
  // true: every row shows its own best-priced book independently (see
  // getBestBookmakerKey). false: the stepper has forced one specific
  // book across every row -- a manual override, not the default.
  const [smartDefault, setSmartDefault] = useState(true);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonBookmakerKeys, setComparisonBookmakerKeys] = useState<string[]>([]);
  const [seeAllTarget, setSeeAllTarget] = useState<SeeAllTarget | null>(null);
  // Which slot the next "Watch" click assigns to -- primary drives the
  // EV stream, secondary exists only to demo optimistic
  // watch/unwatch + rollback with a second discovered (but not stream-tracked)
  // prop.
  const [watchAssignTarget, setWatchAssignTarget] = useState<"primary" | "secondary">("primary");
  const [selectionOpen, setSelectionOpen] = useState(true);

  const sortedCheckedMarketKeys = useMemo(
    () => [...checkedMarketKeys].sort(),
    [checkedMarketKeys]
  );
  const hasCurrentDiscovery =
    discoveredPropsEventId === selectedEventId &&
    discoveredPropsMarketKeys.join(",") === sortedCheckedMarketKeys.join(",");
  const visibleDiscoveredProps = useMemo(
    () => (hasCurrentDiscovery ? discoveredProps : []),
    [discoveredProps, hasCurrentDiscovery]
  );

  const allBookmakerKeys = useMemo(
    () => getAllBookmakerKeys(visibleDiscoveredProps),
    [visibleDiscoveredProps]
  );

  // Adjust state during render, not in an effect (React's own documented
  // pattern for "reset some state when a computed value changes") -- the
  // useMemo above keeps allBookmakerKeys referentially stable unless
  // discoveredProps itself changes, so this only fires on a REAL change,
  // not every render. A fresh discovery result can drop the book that
  // was selected (a different market set may not include it) or arrive
  // with none selected yet -- default to the first available book rather than
  // show a stale/invalid one.
  const [prevAllBookmakerKeys, setPrevAllBookmakerKeys] = useState(allBookmakerKeys);
  if (allBookmakerKeys !== prevAllBookmakerKeys) {
    setPrevAllBookmakerKeys(allBookmakerKeys);
    setSmartDefault(true); // a fresh discovery result starts back at smart defaults, not a stale manual override
    if (allBookmakerKeys.length === 0) {
      setSelectedBookmakerKey(null);
    } else if (!selectedBookmakerKey || !allBookmakerKeys.includes(selectedBookmakerKey)) {
      setSelectedBookmakerKey(allBookmakerKeys[0]);
    }
  }

  // The server owns both the slate window and its label. Revalidate on
  // a short TTL and when a dormant tab becomes active so a tab crossing
  // the Tuesday boundary cannot retain the prior week's event list.
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let controller: AbortController | undefined;

    const loadSlate = async () => {
      const requestGeneration = ++generation;
      controller?.abort();
      controller = new AbortController();

      try {
        const res = await fetch("/api/slate", { signal: controller.signal });
        const data = await res.json();
        if (disposed || controller.signal.aborted || requestGeneration !== generation) return;
        if (!data.success) {
          setRealSlateStatus("error");
          setRealSlateError(data.reason ?? "Failed to load the slate");
          return;
        }
        if (!isOddsDataSource(data.dataSource)) {
          setRealSlateStatus("error");
          setRealSlateError("Slate response did not identify its data source");
          return;
        }
        setSlateDataSource(data.dataSource);
        setRealSlate(data.events, data.window);
        setRealSlateError(null);
        setRealSlateStatus("loaded");
      } catch (err) {
        if (disposed || controller.signal.aborted || requestGeneration !== generation) return;
        setRealSlateStatus("error");
        setRealSlateError(String(err));
      }
    };

    setRealSlateStatus("loading");
    void loadSlate();

    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") void loadSlate();
    };
    const refreshOnFocus = () => void loadSlate();
    const interval = window.setInterval(loadSlate, SLATE_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [setRealSlate, setRealSlateError, setRealSlateStatus]);

  const discoveryRequestRef = useRef<{
    generation: number;
    identity: string;
    controller?: AbortController;
  }>({ generation: 0, identity: "" });

  const discoveryIdentity = `${selectedEventId ?? ""}::${sortedCheckedMarketKeys.join(",")}`;

  useEffect(() => {
    discoveryRequestRef.current.generation += 1;
    discoveryRequestRef.current.identity = discoveryIdentity;
    discoveryRequestRef.current.controller?.abort();
  }, [discoveryIdentity]);

  // Explicit trigger, not auto-fetch-on-toggle -- checking several boxes
  // batches into ONE request, matching how the discovery cache was
  // designed (missing markets batched into a single Odds API call).
  const fetchDiscoveredProps = async (forceRefresh: boolean) => {
    if (!selectedEventId || checkedMarketKeys.length === 0) return;

    const eventId = selectedEventId;
    const marketKeys = [...sortedCheckedMarketKeys];
    const identity = `${eventId}::${marketKeys.join(",")}`;
    const requestGeneration = discoveryRequestRef.current.generation + 1;
    discoveryRequestRef.current.controller?.abort();
    const controller = new AbortController();
    discoveryRequestRef.current = {
      generation: requestGeneration,
      identity,
      controller,
    };

    setDiscoveryStatus("loading");
    setDiscoveryError(null);

    const params = new URLSearchParams({ markets: marketKeys.join(",") });
    if (forceRefresh) params.set("refresh", "true");

    try {
      const res = await fetch(`/api/slate/${eventId}/props?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      const currentState = useAppStore.getState();
      const currentIdentity = `${currentState.selectedEventId ?? ""}::${[
        ...currentState.checkedMarketKeys,
      ]
        .sort()
        .join(",")}`;
      const isCurrent =
        !controller.signal.aborted &&
        discoveryRequestRef.current.generation === requestGeneration &&
        discoveryRequestRef.current.identity === identity &&
        currentIdentity === identity;
      if (!isCurrent) return;
      if (!data.success) {
        setDiscoveryStatus("error");
        setDiscoveryError(data.reason ?? "Failed to load props");
        return;
      }
      if (data.eventId !== eventId) {
        setDiscoveryStatus("error");
        setDiscoveryError("Props response did not match the selected event");
        return;
      }
      if (!isOddsDataSource(data.dataSource) || data.dataSource !== slateDataSource) {
        setDiscoveryStatus("error");
        setDiscoveryError("Props response did not match the slate data source");
        return;
      }
      setDiscoveredProps(data.players, eventId, marketKeys);
      setDiscoveryStatus("loaded");
      if (!forceRefresh) setSelectionOpen(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      const currentState = useAppStore.getState();
      const currentIdentity = `${currentState.selectedEventId ?? ""}::${[
        ...currentState.checkedMarketKeys,
      ]
        .sort()
        .join(",")}`;
      if (
        discoveryRequestRef.current.generation !== requestGeneration ||
        discoveryRequestRef.current.identity !== identity ||
        currentIdentity !== identity
      ) {
        return;
      }
      setDiscoveryStatus("error");
      setDiscoveryError(String(err));
    }
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

  const handleWatch = (
    playerName: string,
    params: { marketKey: string; bookmakerKey: string; direction: PlayerPropDirection }
  ) => {
    const event = realSlate.find((e) => e.id === selectedEventId);
    if (!event) return; // selectedEventId always comes from realSlate itself -- defensive, not expected

    const selection: WatchSelection = {
      eventId: event.id,
      sportKey: event.sportKey,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      startTime: event.commenceTime,
      marketKey: params.marketKey,
      propType:
        PLAYER_PROP_MARKETS.find((market) => market.key === params.marketKey)?.label ??
        params.marketKey,
      playerName,
      bookmakerKey: params.bookmakerKey,
      direction: params.direction,
    };

    if (watchAssignTarget === "primary") {
      setPrimaryWatch(selection);
    } else {
      setSecondaryWatch(selection);
    }
  };

  const selectedEvent = realSlate.find((event) => event.id === selectedEventId);
  const showSelection = selectionOpen || !hasCurrentDiscovery;

  const sortedSlate = [...realSlate].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );

  return (
    <section className="min-w-0 rounded-lg border border-zinc-200 p-4 sm:p-6 dark:border-zinc-800">
      <h2 className="text-lg font-medium">
        Browse the {realSlateWindow?.label ?? "current NFL"} slate
      </h2>

      {slateDataSource === "fixture" && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Preview fixture data — the teams, players, books, and prices in this browser are
          fictional. No live provider calls are made.
        </p>
      )}

      {realSlateStatus === "loading" && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Loading this week&rsquo;s games…</p>
      )}
      {realSlateStatus === "error" && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-400">{realSlateError}</p>
      )}

      {realSlateStatus === "loaded" && (
        <>
          {!showSelection && selectedEvent && (
            <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 break-words text-sm" aria-live="polite">
                <p className="font-medium">{selectedEvent.awayTeam} @ {selectedEvent.homeTeam}</p>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  {PLAYER_PROP_MARKETS.filter((market) => checkedMarketKeys.includes(market.key))
                    .map((market) => market.label).join(", ")}
                  {" · "}{visibleDiscoveredProps.length} {visibleDiscoveredProps.length === 1 ? "player" : "players"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectionOpen(true)}
                className="min-h-11 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
              >
                Change selection
              </button>
            </div>
          )}
          {showSelection && (
            <div className="relative mt-3">
              <select
                aria-label="Select a game"
                className="min-h-11 w-full min-w-0 appearance-none rounded border border-zinc-300 bg-white py-2 pr-10 pl-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-400"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>

          )}

          {selectedEventId && (
            <div className="mt-4">
              {showSelection && (
                <>
                  <p className="text-sm font-medium">Which prop markets?</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {PLAYER_PROP_MARKETS.map((market) => (
                      <label key={market.key} className="flex min-h-11 min-w-0 items-center gap-2 text-sm">
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
                      className="min-h-11 rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
                    >
                      {discoveryStatus === "loading" ? "Loading…" : "Show props"}
                    </button>
                  </div>
                </>
              )}

              {discoveryStatus === "error" && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{discoveryError}</p>
              )}

              {visibleDiscoveredProps.length > 0 && (
                <div className="mt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span>Odds shown</span>
                      <span className="relative min-w-0">
                        <select
                          value={smartDefault ? "" : selectedBookmakerKey ?? ""}
                          disabled={comparisonMode}
                          onChange={(event) => {
                            setSmartDefault(event.target.value === "");
                            setSelectedBookmakerKey(event.target.value || null);
                          }}
                          className="min-h-11 max-w-full appearance-none rounded border border-zinc-300 bg-white py-2 pr-10 pl-3 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-900"
                        >
                          <option value="">Best available</option>
                          {allBookmakerKeys.map((key) => <option key={key} value={key}>{key}</option>)}
                        </select>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-zinc-600 dark:text-zinc-400">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </label>
                    <button
                      type="button"
                      aria-pressed={comparisonMode}
                      onClick={() => setComparisonMode((current) => !current)}
                      className={`min-h-11 rounded px-3 py-2 text-sm ${
                        comparisonMode
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "border border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      Compare books
                    </button>
                    <button
                      type="button"
                      onClick={() => fetchDiscoveredProps(true)}
                      disabled={discoveryStatus === "loading"}
                      className="min-h-11 rounded border border-zinc-300 px-3 py-2 text-sm disabled:cursor-wait dark:border-zinc-700"
                    >
                      {discoveryStatus === "loading" ? "Refreshing…" : "Refresh odds"}
                    </button>
                  </div>

                  {!comparisonMode && (
                    <details className="mt-3 text-sm">
                      <summary className="min-h-11 cursor-pointer rounded px-2 py-3 text-zinc-600 dark:text-zinc-400">
                        Demo watch assignment
                      </summary>
                      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        Primary drives live analysis. Secondary demonstrates watch/unwatch and rollback only.
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">Watch button assigns:</span>
                        {(["primary", "secondary"] as const).map((target) => (
                          <button
                            key={target}
                            type="button"
                            aria-pressed={watchAssignTarget === target}
                            onClick={() => setWatchAssignTarget(target)}
                            className={`min-h-11 rounded px-3 py-1.5 ${
                              watchAssignTarget === target
                                ? "bg-black text-white dark:bg-white dark:text-black"
                                : "border border-zinc-300 dark:border-zinc-700"
                            }`}
                          >
                            {target === "primary" ? "Primary" : "Secondary (demo)"}
                          </button>
                        ))}
                      </div>
                    </details>
                  )}

                  {(primaryWatch || secondaryWatch) && (
                    <div role="status" className="mt-3 space-y-1 text-sm">
                      {primaryWatch && (
                        <div
                          data-testid="primary-watch-status"
                          className="flex flex-wrap items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                        >
                          <span>
                            <span className="text-zinc-600 dark:text-zinc-400">Primary: </span>
                            {primaryWatch.playerName} — {primaryWatch.propType} (
                            {primaryWatch.direction}, {primaryWatch.bookmakerKey})
                          </span>
                          <button
                            type="button"
                            onClick={() => setPrimaryWatch(null)}
                            className="min-h-11 min-w-11 text-zinc-600 dark:text-zinc-400 underline hover:text-zinc-900 dark:hover:text-zinc-100"
                          >
                            Clear
                          </button>
                        </div>
                      )}
                      {secondaryWatch && (
                        <div
                          data-testid="secondary-watch-status"
                          className="flex flex-wrap items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                        >
                          <span>
                            <span className="text-zinc-600 dark:text-zinc-400">Secondary: </span>
                            {secondaryWatch.playerName} — {secondaryWatch.propType} (
                            {secondaryWatch.direction}, {secondaryWatch.bookmakerKey})
                          </span>
                          <button
                            type="button"
                            onClick={() => setSecondaryWatch(null)}
                            className="min-h-11 min-w-11 text-zinc-600 dark:text-zinc-400 underline hover:text-zinc-900 dark:hover:text-zinc-100"
                          >
                            Clear
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {comparisonMode && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {allBookmakerKeys.map((bookmakerKey) => {
                        const checked = comparisonBookmakerKeys.includes(bookmakerKey);
                        const atLimit =
                          !checked && comparisonBookmakerKeys.length >= MAX_COMPARISON_BOOKMAKERS;
                        return (
                          <label
                            key={bookmakerKey}
                            className={`flex min-h-11 max-w-full items-center gap-1.5 break-words rounded border px-2 py-1.5 text-sm ${
                              atLimit
                                ? "border-zinc-100 text-zinc-600 dark:text-zinc-400 dark:border-zinc-900"
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
                      <p className="w-full text-xs text-zinc-600 dark:text-zinc-400">
                        Up to {MAX_COMPARISON_BOOKMAKERS} bookmakers, space permitting.
                      </p>
                    </div>
                  )}

                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {visibleDiscoveredProps.map((player) => (
                      <PlayerPropsCard
                        key={player.playerName}
                        player={player}
                        mode={comparisonMode ? "compare" : "single"}
                        smartDefault={smartDefault}
                        selectedBookmakerKey={selectedBookmakerKey}
                        comparisonBookmakerKeys={comparisonBookmakerKeys}
                        onSeeAll={(marketKey) =>
                          setSeeAllTarget({ playerName: player.playerName, marketKey })
                        }
                        onWatch={(params) => handleWatch(player.playerName, params)}
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
        players={visibleDiscoveredProps}
        onClose={() => setSeeAllTarget(null)}
      />
    </section>
  );
};
