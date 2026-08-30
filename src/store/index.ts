import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { createConnectionSlice } from "./slices/connectionSlice";
import { createGoalSlice } from "./slices/goalSlice";
import { createMatchupSlice } from "./slices/matchupSlice";
import { createWatchlistSlice } from "./slices/watchlistSlice";
import type { AppState } from "./types";

export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (...args) => ({
        ...createConnectionSlice(...args),
        ...createMatchupSlice(...args),
        ...createGoalSlice(...args),
        ...createWatchlistSlice(...args),
      }),
      {
        name: "dfs-ev-demo-storage",
        partialize: (state) => ({
          goal: state.goal,
          watchlist: state.watchlist,
        }),
      }
    ),
    {
      name: "dfs-ev-demo-store",
      enabled: process.env.NODE_ENV !== "production",
    }
  )
);
