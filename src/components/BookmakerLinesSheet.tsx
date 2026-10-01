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
        className="max-h-[80vh] w-full overflow-y-auto rounded-t-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:max-w-sm sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{target.playerName}</p>
            <p className="text-xs text-zinc-500">
              {marketLabel(target.marketKey as PlayerPropMarketKey)} — all bookmakers
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            ✕
          </button>
        </div>

        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-400">
              <th className="py-1 font-normal">Bookmaker</th>
              {!isYesMarket && <th className="py-1 font-normal">Line</th>}
              <th className="py-1 font-normal">{isYesMarket ? "Price" : "Over / Under"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bookmakerKey} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-2">{row.bookmakerKey}</td>
                {!isYesMarket && <td className="py-2">{row.point ?? "—"}</td>}
                <td className="py-2">
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
