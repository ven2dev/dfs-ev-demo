import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { createAuthSlice } from "./slices/authSlice";
import { createConnectionSlice } from "./slices/connectionSlice";
import { createGoalSlice } from "./slices/goalSlice";
import { createMatchupSlice } from "./slices/matchupSlice";
import { createWatchlistSlice } from "./slices/watchlistSlice";
import type { AppState } from "./types";

// No persist middleware: goal/watchlist/matchupConfig now live in
// Firestore, keyed by uid (see useInitAuth.ts, /api/user-data), and
// nothing else in the store was ever persisted. A localStorage copy of
// this data would just reintroduce the cross-account leak risk #20 spent
// real effort eliminating -- Firestore's per-uid document path is the
// only place this data should live.
//
// Any pre-existing "dfs-ev-demo-storage" key from before this ticket is
// dead weight now, not migrated -- see useInitAuth.ts's one-line cleanup
// of it, and issue #21's amended AC for why (disposable dev/demo data
// only, no real user data existed to lose).
export const useAppStore = create<AppState>()(
  devtools(
    (...args) => ({
      ...createAuthSlice(...args),
      ...createConnectionSlice(...args),
      ...createMatchupSlice(...args),
      ...createGoalSlice(...args),
      ...createWatchlistSlice(...args),
    }),
    {
      name: "dfs-ev-demo-store",
      enabled: process.env.NODE_ENV !== "production",
    }
  )
);
