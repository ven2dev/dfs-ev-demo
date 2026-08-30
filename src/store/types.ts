import type { ConnectionSlice } from "./slices/connectionSlice";
import type { GoalSlice } from "./slices/goalSlice";
import type { MatchupSlice } from "./slices/matchupSlice";
import type { WatchlistSlice } from "./slices/watchlistSlice";

export type AppState = ConnectionSlice & GoalSlice & MatchupSlice & WatchlistSlice;
