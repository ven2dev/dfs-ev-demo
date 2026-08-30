import type { Matchup, MatchupConfig } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";
import { mockCoverageFilters, mockEnvironment, mockMatchup } from "../mockData";

export interface MatchupSlice {
  matchupConfig: MatchupConfig;
  setMatchupConfig: (config: MatchupConfig) => void;
  currentMatchup: Matchup;
  setCurrentMatchup: (matchup: Matchup) => void;
}

export const createMatchupSlice: StateCreator<
  AppState,
  [],
  [],
  MatchupSlice
> = (set) => ({
  matchupConfig: {
    sampleWindow: 5,
    environment: mockEnvironment,
    coverageFilters: mockCoverageFilters,
  },
  setMatchupConfig: (config) => set({ matchupConfig: config }),
  currentMatchup: mockMatchup,
  setCurrentMatchup: (matchup) => set({ currentMatchup: matchup }),
});
