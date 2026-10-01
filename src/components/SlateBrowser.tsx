"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAYER_PROP_MARKETS,
  type PlayerPropDirection,
} from "@/lib/playerPropMarkets";
import { getAllBookmakerKeys } from "@/lib/discoveredProps";
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
import type { WatchSelection } from "@/store/slices/matchupSlice";
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

// Real event list, market discovery, book comparison, and selection of
// a supported prop for the live EV pipeline.
export const SlateBrowser = () => {
  const realSlate = useRealSlate();
  const realSlateStatus = useRealSlateStatus();
  const realSlateError = useRealSlateError();
  const realSlateWindow = useRealSlateWindow();
  const setRealSlate = useSetRealSlate();
  const setRealSlateStatus = useSetRealSlateStatus();
  const setRealSlateError = useSetRealSlateError();

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
  // live EV pipeline, secondary exists only to demo optimistic
  // watch/unwatch + rollback with a second real (but not live-tracked)
  // prop.
  const [watchAssignTarget, setWatchAssignTarget] = useState<"primary" | "secondary">("primary");
  const [watchDirection, setWatchDirection] = useState<PlayerPropDirection>("over");

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
  // with none selected yet -- default to the first real book rather than
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
          setRealSlateError(data.reason ?? "Failed to load the real slate");
          return;
        }
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
      setDiscoveredProps(data.players, eventId, marketKeys);
      setDiscoveryStatus("loaded");
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

  const cycleBookmaker = (direction: 1 | -1) => {
    if (allBookmakerKeys.length === 0 || !selectedBookmakerKey) return;
    setSmartDefault(false); // cycling is a manual override -- it always wins over per-row smart defaults
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

  const sortedSlate = [...realSlate].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );

  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-medium">
        Browse the {realSlateWindow?.label ?? "current NFL"} slate
      </h2>

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
                {visibleDiscoveredProps.length > 0 && (
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

              {visibleDiscoveredProps.length > 0 && (
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
                        <span
                          data-testid="bookmaker-stepper-label"
                          className="min-w-24 text-center font-medium"
                        >
                          {smartDefault
                            ? `Best ${watchDirection === "over" ? "Over" : "Under"} price`
                            : selectedBookmakerKey}
                        </span>
                        <button
                          type="button"
                          aria-label="Next bookmaker"
                          onClick={() => cycleBookmaker(1)}
                          className="rounded px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        >
                          ›
                        </button>
                        {!smartDefault && (
                          <button
                            type="button"
                            onClick={() => setSmartDefault(true)}
                            className="rounded px-2 py-1.5 text-xs text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100"
                          >
                            Reset to best
                          </button>
                        )}
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

                  {!comparisonMode && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-zinc-500">Track side:</span>
                      {(["over", "under"] as const).map((direction) => (
                        <button
                          key={direction}
                          type="button"
                          onClick={() => setWatchDirection(direction)}
                          className={`rounded px-3 py-1.5 capitalize ${
                            watchDirection === direction
                              ? "bg-black text-white dark:bg-white dark:text-black"
                              : "border border-zinc-300 dark:border-zinc-700"
                          }`}
                        >
                          {direction}
                        </button>
                      ))}
                      <span className="ml-2 text-zinc-500">Watch button assigns:</span>
                      {(["primary", "secondary"] as const).map((target) => (
                        <button
                          key={target}
                          type="button"
                          onClick={() => setWatchAssignTarget(target)}
                          className={`rounded px-3 py-1.5 ${
                            watchAssignTarget === target
                              ? "bg-black text-white dark:bg-white dark:text-black"
                              : "border border-zinc-300 dark:border-zinc-700"
                          }`}
                        >
                          {target === "primary" ? "Primary" : "Secondary (demo)"}
                        </button>
                      ))}
                    </div>
                  )}

                  {(primaryWatch || secondaryWatch) && (
                    <div className="mt-3 space-y-1 text-sm">
                      {primaryWatch && (
                        <div
                          data-testid="primary-watch-status"
                          className="flex items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                        >
                          <span>
                            <span className="text-zinc-400">Primary: </span>
                            {primaryWatch.playerName} — {primaryWatch.propType} (
                            {primaryWatch.direction}, {primaryWatch.bookmakerKey})
                          </span>
                          <button
                            type="button"
                            onClick={() => setPrimaryWatch(null)}
                            className="text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100"
                          >
                            Clear
                          </button>
                        </div>
                      )}
                      {secondaryWatch && (
                        <div
                          data-testid="secondary-watch-status"
                          className="flex items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                        >
                          <span>
                            <span className="text-zinc-400">Secondary: </span>
                            {secondaryWatch.playerName} — {secondaryWatch.propType} (
                            {secondaryWatch.direction}, {secondaryWatch.bookmakerKey})
                          </span>
                          <button
                            type="button"
                            onClick={() => setSecondaryWatch(null)}
                            className="text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100"
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
                    {visibleDiscoveredProps.map((player) => (
                      <PlayerPropsCard
                        key={player.playerName}
                        player={player}
                        mode={comparisonMode ? "compare" : "single"}
                        smartDefault={smartDefault}
                        selectedBookmakerKey={selectedBookmakerKey}
                        comparisonBookmakerKeys={comparisonBookmakerKeys}
                        watchDirection={watchDirection}
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
