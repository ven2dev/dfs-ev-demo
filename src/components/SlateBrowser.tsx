"use client";

import { useEffect } from "react";
import { PLAYER_PROP_MARKETS, type PlayerPropMarketKey } from "@/lib/playerPropMarkets";
import { groupLinesByBookmaker } from "@/lib/discoveredProps";
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

const marketLabel = (key: PlayerPropMarketKey) =>
  PLAYER_PROP_MARKETS.find((market) => market.key === key)?.label ?? key;

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

  const sortedSlate = [...realSlate].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );

  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-medium">Browse the real slate</h2>

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

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => fetchDiscoveredProps(false)}
                  disabled={checkedMarketKeys.length === 0 || discoveryStatus === "loading"}
                  className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  {discoveryStatus === "loading" ? "Loading…" : "Show props"}
                </button>
                {discoveredProps.length > 0 && (
                  <button
                    type="button"
                    onClick={() => fetchDiscoveredProps(true)}
                    disabled={discoveryStatus === "loading"}
                    className="rounded border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
                  >
                    Refresh odds
                  </button>
                )}
              </div>

              {discoveryStatus === "error" && (
                <p className="mt-2 text-sm text-red-600">{discoveryError}</p>
              )}

              {discoveredProps.length > 0 && (
                <div className="mt-4 space-y-4">
                  {discoveredProps.map((player) => (
                    <div
                      key={player.playerName}
                      className="rounded border border-zinc-200 p-3 dark:border-zinc-800"
                    >
                      <p className="text-sm font-medium">{player.playerName}</p>
                      {player.markets.map((market) => {
                        const rows = groupLinesByBookmaker(market.lines);
                        const isYesMarket = market.lines[0]?.side === "yes";
                        return (
                          <div key={market.marketKey} className="mt-2">
                            <p className="text-xs text-zinc-500">
                              {marketLabel(market.marketKey as PlayerPropMarketKey)}
                            </p>
                            <table className="mt-1 w-full text-xs">
                              <thead>
                                <tr className="text-left text-zinc-400">
                                  <th className="font-normal">Bookmaker</th>
                                  {!isYesMarket && <th className="font-normal">Line</th>}
                                  <th className="font-normal">
                                    {isYesMarket ? "Price" : "Over / Under"}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((row) => (
                                  <tr key={row.bookmakerKey}>
                                    <td>{row.bookmakerKey}</td>
                                    {!isYesMarket && <td>{row.point ?? "—"}</td>}
                                    <td>
                                      {isYesMarket
                                        ? (row.yesPrice ?? "—")
                                        : `${row.overPrice ?? "—"} / ${row.underPrice ?? "—"}`}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
