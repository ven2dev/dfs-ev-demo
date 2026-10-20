"use client";

import type { PlayerPropDirection } from "@dfs-ev/domain";
import { useId } from "react";

import {
  getBestBookmakerKey,
  groupLinesByBookmaker,
  type DiscoveredPlayer,
} from "@/lib/discoveredProps";
import {
  getPlayerPropMarket,
  PLAYER_PROP_MARKETS,
} from "@/lib/playerPropMarkets";

export type PlayerPropsCardMode = "single" | "compare";

type PlayerPropsCardProps = {
  player: DiscoveredPlayer;
  mode: PlayerPropsCardMode;
  // Single mode only. true: each row independently shows its own
  // best-priced book (see getBestBookmakerKey) -- rows can legitimately
  // show DIFFERENT books. false: every row is forced to
  // selectedBookmakerKey (the manual Odds shown override).
  smartDefault: boolean;
  selectedBookmakerKey: string | null;
  comparisonBookmakerKeys: string[];
  onSeeAll: (marketKey: string) => void;
  // Every action captures the side and sportsbook displayed in its row.
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

      {mode === "single" ? (
        <div className="mt-3 space-y-4">
          {player.markets.map((market, marketIndex) => {
            const rows = groupLinesByBookmaker(market.lines);
            const label = marketLabel(market.marketKey);
            const capability = getPlayerPropMarket(market.marketKey);
            const isYesMarket = capability?.outcomeShape === "yes-only" || market.lines[0]?.side === "yes";
            const yesBook = isYesMarket
              ? smartDefault ? getBestBookmakerKey(market.lines, "over") : selectedBookmakerKey
              : null;
            const yesRow = rows.find((entry) => entry.bookmakerKey === yesBook);
            const seeAllName = `See all books for ${player.playerName} ${label}`;

            return (
              <section key={market.marketKey} aria-label={`${label} for ${player.playerName}`} className="min-w-0">
                <h3 className="text-sm font-medium">{label}</h3>
                {isYesMarket ? (
                  <div className="mt-2 text-sm">
                    <p className="break-words">Yes · Price {yesRow?.yesPrice ?? "—"} · {yesBook ?? "No quote available"}</p>
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Browse only — one-sided markets are not supported for live analysis.</p>
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {(["over", "under"] as const).map((direction) => {
                      const side = direction === "over" ? "Over" : "Under";
                      const key = smartDefault ? getBestBookmakerKey(market.lines, direction) : selectedBookmakerKey;
                      const row = rows.find((entry) => entry.bookmakerKey === key);
                      // A manual book can expose mismatched or incomplete sides.
                      // Only display prices actually quoted at the displayed line.
                      const over = market.lines.find((line) => line.bookmakerKey === key && line.side === "over" && line.point === row?.point);
                      const under = market.lines.find((line) => line.bookmakerKey === key && line.side === "under" && line.point === row?.point);
                      const price = direction === "over" ? over?.price : under?.price;
                      const canWatch = Boolean(capability?.trackable && row?.point !== undefined && over && under);
                      const reason = !key
                        ? "No complete two-way quote is available at the shared market line."
                        : !row
                          ? "This sportsbook does not cover this market."
                          : row.point === undefined
                            ? "A market line is required for analysis."
                            : "Both Over and Under prices are required for analysis.";
                      const reasonId = `${scrollHintId}-${marketIndex}-${direction}`;

                      return (
                        <div key={direction} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded bg-zinc-100 p-3 dark:bg-zinc-900">
                          <div className="min-w-0 text-sm">
                            <p className="font-medium">{side} {row?.point ?? "—"}</p>
                            <p>Price {price ?? "—"}</p>
                            <p className="break-words text-xs text-zinc-600 dark:text-zinc-400">{key ?? "No sportsbook available"}</p>
                          </div>
                          {capability?.trackable && (
                            <button
                              type="button"
                              disabled={!canWatch}
                              aria-label={`Watch ${side} ${row?.point ?? "unavailable line"} ${label} at ${key ?? "unavailable sportsbook"} for ${player.playerName}`}
                              aria-describedby={!canWatch ? reasonId : undefined}
                              onClick={() => key && canWatch && onWatch({ marketKey: market.marketKey, bookmakerKey: key, direction })}
                              className="min-h-11 min-w-11 rounded border border-zinc-400 px-3 py-2 text-sm font-medium hover:bg-zinc-200 disabled:cursor-not-allowed disabled:border-dashed disabled:text-zinc-600 dark:border-zinc-600 dark:hover:bg-zinc-800 dark:disabled:text-zinc-400"
                            >
                              Watch {side}
                            </button>
                          )}
                          {!capability?.trackable ? (
                            <p className="col-span-2 mt-2 text-xs text-zinc-600 dark:text-zinc-400">Browse only — live analysis is unavailable for this market.</p>
                          ) : !canWatch && (
                            <p id={reasonId} className="col-span-2 mt-2 text-xs text-zinc-600 dark:text-zinc-400">{reason}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <button type="button" onClick={() => onSeeAll(market.marketKey)} aria-label={seeAllName}
                  className="mt-1 min-h-11 min-w-11 rounded px-2 py-2 text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                  See all books
                </button>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <p id={scrollHintId} className="mt-3 text-xs text-zinc-600 sm:sr-only dark:text-zinc-400">
            Scroll the table sideways for all prices and actions. Keyboard: focus the table, then use arrow keys.
          </p>
          <div role="region" aria-label={`${player.playerName} prop prices`} aria-describedby={scrollHintId} tabIndex={0}
            className="relative mt-2 max-w-full overflow-x-auto rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400">
            <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
              <thead>
                <tr className="text-left text-zinc-600 dark:text-zinc-400">
                  <th scope="col" className="sticky left-0 z-10 bg-zinc-50 py-1 pr-4 font-normal dark:bg-black">Prop</th>
                  {comparisonBookmakerKeys.map((key) => <th scope="col" key={key} className="py-1 pr-4 font-normal">{key}</th>)}
                  <th scope="col" className="py-1 font-normal"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {player.markets.map((market) => {
                  const rows = groupLinesByBookmaker(market.lines);
                  const isYesMarket = market.lines[0]?.side === "yes";
                  return (
                    <tr key={market.marketKey}>
                      <th scope="row" className="sticky left-0 z-10 w-28 max-w-32 border-r border-zinc-200 bg-zinc-50 py-2 pr-4 text-left font-normal whitespace-normal dark:border-zinc-800 dark:bg-black">{marketLabel(market.marketKey)}</th>
                      {comparisonBookmakerKeys.map((key) => {
                        const row = rows.find((entry) => entry.bookmakerKey === key);
                        return <td key={key} className="py-2 pr-4 whitespace-nowrap">{row ? isYesMarket ? row.yesPrice ?? "—" : `${row.point ?? "—"} · ${row.overPrice ?? "—"} / ${row.underPrice ?? "—"}` : "—"}</td>;
                      })}
                      <td className="py-2 text-right whitespace-nowrap">
                        <button type="button" onClick={() => onSeeAll(market.marketKey)}
                          aria-label={`See all books for ${player.playerName} ${marketLabel(market.marketKey)}`}
                          className="min-h-11 min-w-11 rounded px-2 py-1.5 text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                          See all books
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
