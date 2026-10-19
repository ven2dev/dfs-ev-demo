import type { WatchedProp } from "@/types";

// Pure, DI'd orchestration for the ONE optimistic-update + rollback
// example the brief calls for -- mirrors accountDeletion.ts's pattern
// (dependencies passed in, a semantic result returned) so this is
// testable with fakes instead of a live store/network.
export type WatchlistToggleDeps = {
  getUid: () => string | null;
  getWatchlistEntry: (propId: string) => WatchedProp | undefined;
  setWatchlistEntry: (propId: string, entry: WatchedProp | undefined) => void;
  submit: (
    propId: string,
    wasWatching: boolean
  ) => Promise<{ success: boolean; reason?: string }>;
};

export type WatchlistToggleResult =
  | { status: "success" }
  | { status: "reverted"; wasWatching: boolean; cause: unknown }
  // The signed-in uid changed while the request was in flight -- the
  // newer uid's own action already owns the watchlist by the time this
  // one's response lands, so there's nothing left to revert or report.
  | { status: "stale" };

export const toggleWatchedProp = async (
  propId: string,
  newEntry: WatchedProp,
  deps: WatchlistToggleDeps
): Promise<WatchlistToggleResult> => {
  const uidForThisAction = deps.getUid();
  const previousEntry = deps.getWatchlistEntry(propId);
  const wasWatching = Boolean(previousEntry);

  // Both the optimistic apply and the failure rollback go through this
  // one choke point, so a single uid check covers both.
  const applyEntry = (entry: WatchedProp | undefined) => {
    if (deps.getUid() !== uidForThisAction) return;
    deps.setWatchlistEntry(propId, entry);
  };

  applyEntry(wasWatching ? undefined : newEntry);

  try {
    const data = await deps.submit(propId, wasWatching);
    if (!data.success) {
      throw new Error(data.reason ?? "Unknown failure");
    }
    return { status: "success" };
  } catch (err) {
    applyEntry(wasWatching ? previousEntry : undefined);
    if (deps.getUid() !== uidForThisAction) return { status: "stale" };
    return { status: "reverted", wasWatching, cause: err };
  }
};
