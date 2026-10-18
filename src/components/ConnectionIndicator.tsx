"use client";

import { useAppStore } from "@/store";
import { useConnectionStatus, usePrimaryWatch } from "@/store/hooks";
import { buildWatchPropId } from "@/lib/watchPropId";

const COLORS = {
  live: "bg-green-600",
  stale: "bg-amber-500",
  connecting: "bg-blue-600",
  disconnected: "bg-red-600",
} as const;

export const ConnectionIndicator = () => {
  const status = useConnectionStatus();
  const primaryWatch = usePrimaryWatch();
  const source = useAppStore((state) =>
    state.primaryWatch
      ? state.watchlist[buildWatchPropId(state.primaryWatch)]?.dataSource
      : undefined
  );
  const tracking = primaryWatch !== null;
  const label = !tracking ? "Not tracking"
    : status === "live" && source === "fixture" ? "Fixture stream" : status;
  const description = !tracking
    ? "Watch a prop to start tracking odds updates."
    : "Connection to odds updates for the watched prop.";

  return (
    <div
      role="status"
      aria-label="Odds connection"
      title={description}
      className="flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs capitalize text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-black dark:text-zinc-200"
    >
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${tracking ? COLORS[status] : "bg-zinc-400"}`} />
      <span>{label}</span>
    </div>
  );
};
