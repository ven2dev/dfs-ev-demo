import type { MatchupConfig, Slate } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";
import { mockCoverageFilters, mockEnvironment, mockMatchup } from "../mockData";

export interface MatchupSlice {
  matchupConfig: MatchupConfig;
  setMatchupConfig: (config: MatchupConfig) => void;
  slate: Slate;
  selectedMatchupId: string;
  setSelectedMatchupId: (id: string) => void;
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
  slate: [mockMatchup],
  selectedMatchupId: mockMatchup.id,
  setSelectedMatchupId: (id) => set({ selectedMatchupId: id }),
});
