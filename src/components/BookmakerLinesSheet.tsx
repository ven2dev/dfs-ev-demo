"use client";

import { useEffect } from "react";
import { groupLinesByBookmaker, type DiscoveredPlayer } from "@/lib/discoveredProps";
import { PLAYER_PROP_MARKETS, type PlayerPropMarketKey } from "@/lib/playerPropMarkets";

export type SeeAllTarget = {
  playerName: string;
  marketKey: string;
};

type BookmakerLinesSheetProps = {
  target: SeeAllTarget | null;
  players: DiscoveredPlayer[];
  onClose: () => void;
};

const marketLabel = (key: string) =>
  PLAYER_PROP_MARKETS.find((market) => market.key === key)?.label ?? key;

// Bottom sheet, not an inline expand -- keeps the main table compact
// regardless of how many books cover a prop (some have 6+), same
// drill-down pattern as PrizePicks/Underdog use for this exact case.
export const BookmakerLinesSheet = ({ target, players, onClose }: BookmakerLinesSheetProps) => {
  useEffect(() => {
    if (!target) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [target, onClose]);

  if (!target) return null;

  const player = players.find((p) => p.playerName === target.playerName);
  const market = player?.markets.find((m) => m.marketKey === target.marketKey);
  const rows = market ? groupLinesByBookmaker(market.lines) : [];
  const isYesMarket = market?.lines[0]?.side === "yes";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`All bookmakers for ${target.playerName} ${marketLabel(target.marketKey)}`}
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/50 sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[80dvh] w-full min-w-0 overflow-y-auto overscroll-contain rounded-t-lg border border-zinc-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-950 sm:max-w-sm sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 break-words">
            <p className="text-sm font-medium">{target.playerName}</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {marketLabel(target.marketKey as PlayerPropMarketKey)} — all bookmakers
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-11 min-w-11 shrink-0 rounded px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            ✕
          </button>
        </div>

        <table className="mt-3 w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-zinc-600 dark:text-zinc-400">
              <th scope="col" className="w-[44%] py-1 pr-2 font-normal">Bookmaker</th>
              {!isYesMarket && <th scope="col" className="w-[20%] py-1 pr-2 font-normal">Line</th>}
              <th scope="col" className="py-1 font-normal">{isYesMarket ? "Price" : "Over / Under"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bookmakerKey} className="border-t border-zinc-100 dark:border-zinc-900">
                <th scope="row" className="break-all py-2 pr-2 text-left font-normal">{row.bookmakerKey}</th>
                {!isYesMarket && <td className="break-words py-2 pr-2">{row.point ?? "—"}</td>}
                <td className="break-words py-2">
                  {isYesMarket ? (row.yesPrice ?? "—") : `${row.overPrice ?? "—"} / ${row.underPrice ?? "—"}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
