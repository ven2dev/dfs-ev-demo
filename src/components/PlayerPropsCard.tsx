"use client";

import { groupLinesByBookmaker, type DiscoveredPlayer } from "@/lib/discoveredProps";
import { PLAYER_PROP_MARKETS, type PlayerPropMarketKey } from "@/lib/playerPropMarkets";

export type PlayerPropsCardMode = "single" | "compare";

type PlayerPropsCardProps = {
  player: DiscoveredPlayer;
  mode: PlayerPropsCardMode;
  selectedBookmakerKey: string | null;
  comparisonBookmakerKeys: string[];
  onSeeAll: (marketKey: string) => void;
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
  selectedBookmakerKey,
  comparisonBookmakerKeys,
  onSeeAll,
}: PlayerPropsCardProps) => {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-3 border-b border-zinc-100 pb-3 dark:border-zinc-900">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-zinc-100 dark:bg-zinc-900">
          <JerseyPlacardIcon />
        </div>
        <p className="text-sm font-medium">{player.playerName}</p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-max text-xs">
          <thead>
            <tr className="text-left text-zinc-400">
              <th className="py-1 pr-4 font-normal">Prop</th>
              {mode === "single" ? (
                <>
                  <th className="py-1 pr-4 font-normal">Line</th>
                  <th className="py-1 pr-4 font-normal">Over / Under</th>
                </>
              ) : (
                comparisonBookmakerKeys.map((bookmakerKey) => (
                  <th key={bookmakerKey} className="py-1 pr-4 font-normal" colSpan={2}>
                    {bookmakerKey}
                  </th>
                ))
              )}
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {player.markets.map((market) => {
              const rows = groupLinesByBookmaker(market.lines);
              const isYesMarket = market.lines[0]?.side === "yes";
              const selectedRow = rows.find((row) => row.bookmakerKey === selectedBookmakerKey);

              return (
                <tr key={market.marketKey} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {marketLabel(market.marketKey as PlayerPropMarketKey)}
                  </td>

                  {mode === "single" ? (
                    <>
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

                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onSeeAll(market.marketKey)}
                      className="rounded px-2 py-1.5 text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100"
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
