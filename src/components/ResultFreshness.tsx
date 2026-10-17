import type { ConnectionStatus, WatchedProp } from "@/types";

type ResultFreshnessProps = {
  snapshot: WatchedProp;
  requestedWindow: 3 | 5 | 7;
  connectionStatus: ConnectionStatus;
  compact?: boolean;
};

export function ResultFreshness({ snapshot, requestedWindow, connectionStatus, compact = false }: ResultFreshnessProps) {
  if (!snapshot.stages || !snapshot.evScore) return null;
  const windowChanged = snapshot.sampleWindow !== undefined && snapshot.sampleWindow !== requestedWindow;
  const failed = snapshot.refreshState === "failed";
  const stale = windowChanged || snapshot.refreshState !== undefined || connectionStatus !== "live";
  const label = failed ? "Stale · update failed"
    : windowChanged ? `Stale · updating to last ${requestedWindow} games`
    : connectionStatus === "disconnected" ? "Stale · disconnected"
    : snapshot.refreshState === "paused" || connectionStatus === "stale" ? "Stale · updates paused"
    : "Stale · updating";
  if (compact && !stale) return null;
  const updatedAt = snapshot.updatedAt === undefined ? undefined : new Date(snapshot.updatedAt);
  const validTime = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt : undefined;

  return (
    <div className="mt-3 text-xs" role="status">
      {stale && (
        <span className={`inline-block rounded border px-2 py-1 font-medium ${failed
          ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
          : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"}`}>
          {label}
        </span>
      )}
      {!compact && (
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          {stale ? "Showing the last valid result" : "Showing the latest result"}{" · "}
          {snapshot.sampleWindow === undefined ? "Original window unavailable" : `Last ${snapshot.sampleWindow} window`}
          {windowChanged && `; requested last ${requestedWindow} games`}
          {" · "}
          {validTime ? <>Updated <time dateTime={validTime.toISOString()}>{validTime.toLocaleString()}</time></> : "Update time unavailable"}
        </p>
      )}
    </div>
  );
}
