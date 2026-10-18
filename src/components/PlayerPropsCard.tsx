"use client";

import { useId } from "react";

import {
  getBestBookmakerKey,
  groupLinesByBookmaker,
  type DiscoveredPlayer,
} from "@/lib/discoveredProps";
import {
  getPlayerPropMarket,
  PLAYER_PROP_MARKETS,
  type PlayerPropDirection,
  type PlayerPropMarketKey,
} from "@/lib/playerPropMarkets";

export type PlayerPropsCardMode = "single" | "compare";

type PlayerPropsCardProps = {
  player: DiscoveredPlayer;
  mode: PlayerPropsCardMode;
  // Single mode only. true: each row independently shows its own
  // best-priced book (see getBestBookmakerKey) -- rows can legitimately
  // show DIFFERENT books. false: every row is forced to
  // selectedBookmakerKey (the manual global stepper override).
  smartDefault: boolean;
  selectedBookmakerKey: string | null;
  comparisonBookmakerKeys: string[];
  watchDirection: PlayerPropDirection;
  onSeeAll: (marketKey: string) => void;
  // Single mode only -- compare mode has no ONE effective book per row
  // to watch. Reports the market's currently-effective book (whichever
  // is actually on screen, smart-picked or manually forced), not a
  // caller-supplied one, so what gets watched always matches what the
  // user is looking at.
  onWatch: (params: {
    marketKey: string;
    bookmakerKey: string;
    direction: PlayerPropDirection;
  }) => void;
};

const marketLabel = (key: string) =>
  PLAYER_PROP_MARKETS.find((market) => market.key === key)?.label ?? key;

// Generic jersey silhouette -- explicitly NOT a real player photo/likeness
// (see #27 discussion: that needs an NFLPA group license neither this
// app nor its data pipeline has). Team-color theming is deferred until
// there's a real player-to-team source; this placard is neutral for now.
const JerseyPlacardIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className="h-8 w-8 text-zinc-400 dark:text-zinc-600"
    aria-hidden="true"
  >
    <path d="M8 3 3 6v4h3v11h12V10h3V6l-5-3-2 2h-4L8 3Z" />
  </svg>
);

export const PlayerPropsCard = ({
  player,
  mode,
  smartDefault,
  selectedBookmakerKey,
  comparisonBookmakerKeys,
  watchDirection,
  onSeeAll,
  onWatch,
}: PlayerPropsCardProps) => {
  const scrollHintId = useId();

  return (
    <div className="min-w-0 rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-3 border-b border-zinc-100 pb-3 dark:border-zinc-900">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-zinc-100 dark:bg-zinc-900">
          <JerseyPlacardIcon />
        </div>
        <p className="min-w-0 break-words text-sm font-medium">{player.playerName}</p>
      </div>

      <p id={scrollHintId} className="mt-3 text-xs sm:sr-only text-zinc-600 dark:text-zinc-400">
        Scroll the table sideways for all prices and actions. Keyboard: focus the table, then use arrow keys.
      </p>
      <div
        role="region"
        aria-label={`${player.playerName} prop prices`}
        aria-describedby={scrollHintId}
        tabIndex={0}
        className="relative mt-2 max-w-full overflow-x-auto rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400"
      >
        <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="text-left text-zinc-600 dark:text-zinc-400">
              <th scope="col" className="sticky left-0 z-10 bg-zinc-50 py-1 pr-4 text-zinc-600 dark:bg-black dark:text-zinc-400 font-normal">Prop</th>
              {mode === "single" ? (
                <>
                  <th scope="col" className="py-1 pr-4 font-normal">Book</th>
                  <th scope="col" className="py-1 pr-4 font-normal">Line</th>
                  <th scope="col" className="py-1 pr-4 font-normal">Over / Under</th>
                </>
              ) : (
                comparisonBookmakerKeys.map((bookmakerKey) => (
                  <th scope="colgroup" key={bookmakerKey} className="py-1 pr-4 font-normal" colSpan={2}>
                    {bookmakerKey}
                  </th>
                ))
              )}
              <th scope="col" className="py-1 font-normal"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {player.markets.map((market) => {
              const rows = groupLinesByBookmaker(market.lines);
              const isYesMarket = market.lines[0]?.side === "yes";
              const capability = getPlayerPropMarket(market.marketKey);
              const effectiveBookmakerKey = smartDefault
                ? getBestBookmakerKey(market.lines, watchDirection)
                : selectedBookmakerKey;
              const selectedRow = rows.find((row) => row.bookmakerKey === effectiveBookmakerKey);
              const canWatchSelectedRow = Boolean(
                capability?.trackable &&
                  selectedRow?.point !== undefined &&
                  selectedRow.overPrice !== undefined &&
                  selectedRow.underPrice !== undefined
              );

              return (
                <tr key={market.marketKey} className="border-t border-zinc-100 dark:border-zinc-900">
                  <th scope="row" className="sticky left-0 z-10 w-28 max-w-32 border-r border-zinc-200 bg-zinc-50 py-2 pr-4 text-left font-normal whitespace-normal dark:border-zinc-800 dark:bg-black">
                    {marketLabel(market.marketKey as PlayerPropMarketKey)}
                  </th>

                  {mode === "single" ? (
                    <>
                      <td className="py-2 pr-4 whitespace-nowrap">{effectiveBookmakerKey ?? "—"}</td>
                      <td className="py-2 pr-4">{isYesMarket ? "—" : (selectedRow?.point ?? "—")}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {selectedRow
                          ? isYesMarket
                            ? (selectedRow.yesPrice ?? "—")
                            : `${selectedRow.overPrice ?? "—"} / ${selectedRow.underPrice ?? "—"}`
                          : "—"}
                      </td>
                    </>
                  ) : (
                    comparisonBookmakerKeys.map((bookmakerKey) => {
                      const row = rows.find((r) => r.bookmakerKey === bookmakerKey);
                      return (
                        <td
                          key={bookmakerKey}
                          colSpan={2}
                          className="py-2 pr-4 whitespace-nowrap"
                        >
                          {row
                            ? isYesMarket
                              ? (row.yesPrice ?? "—")
                              : `${row.point ?? "—"} · ${row.overPrice ?? "—"} / ${row.underPrice ?? "—"}`
                            : "—"}
                        </td>
                      );
                    })
                  )}

                  <td className="py-2 text-right whitespace-nowrap">
                    {mode === "single" && capability?.trackable && (
                      <button
                        type="button"
                        // Checked against selectedRow, not just whether
                        // effectiveBookmakerKey is a non-null string --
                        // a manually-forced book can still be a real
                        // key with no matching row for THIS market
                        // (that book just doesn't cover this prop).
                        disabled={!canWatchSelectedRow}
                        onClick={() =>
                          effectiveBookmakerKey &&
                          canWatchSelectedRow &&
                          onWatch({
                            marketKey: market.marketKey,
                            bookmakerKey: effectiveBookmakerKey,
                            direction: watchDirection,
                          })
                        }
                        className="min-h-11 min-w-11 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 underline hover:text-zinc-900 disabled:cursor-not-allowed disabled:no-underline dark:hover:text-zinc-100"
                      >
                        Watch {watchDirection === "over" ? "Over" : "Under"}
                      </button>
                    )}
                    {mode === "single" && capability && !capability.trackable && (
                      <span className="px-2 py-1.5 text-zinc-600 dark:text-zinc-400">Browse only</span>
                    )}
                    <button
                      type="button"
                      onClick={() => onSeeAll(market.marketKey)}
                      className="min-h-11 min-w-11 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 underline hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      See all
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
