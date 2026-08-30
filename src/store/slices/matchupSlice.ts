import type { MatchupConfig } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface MatchupSlice {
  matchupConfig: MatchupConfig;
  setMatchupConfig: (config: MatchupConfig) => void;
}

export const createMatchupSlice: StateCreator<
  AppState,
  [],
  [],
  MatchupSlice
> = (set) => ({
  matchupConfig: {
    sampleWindow: 5,
    environment: {},
    coverageFilters: {},
  },
  setMatchupConfig: (config) => set({ matchupConfig: config }),
});
