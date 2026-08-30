import type { WatchedProp } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface WatchlistSlice {
  watchlist: Record<string, WatchedProp>;
  setWatchlist: (watchlist: Record<string, WatchedProp>) => void;
}

export const createWatchlistSlice: StateCreator<
  AppState,
  [],
  [],
  WatchlistSlice
> = (set) => ({
  watchlist: {},
  setWatchlist: (watchlist) => set({ watchlist }),
});
