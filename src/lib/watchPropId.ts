import type { WatchSelection } from "@/store/slices/matchupSlice";

// One canonical propId format, shared by the client (watchlist keys,
// SSE query params) and /api/stream (echoes it back on every tick) --
// keeping this in one neutral lib file (not matchupSlice.ts, which is
// client-oriented Zustand code) avoids the server route depending on
// store code just for a string format both sides need to agree on.
export const buildWatchPropId = (
  selection: Pick<
    WatchSelection,
    "eventId" | "marketKey" | "playerName" | "direction" | "bookmakerKey"
  >
): string =>
  `${selection.eventId}:${selection.marketKey}:${selection.playerName}:${selection.direction}:${selection.bookmakerKey}`;
