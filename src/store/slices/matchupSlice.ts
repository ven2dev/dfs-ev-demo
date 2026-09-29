import type { MatchupConfig, Slate } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";
import { mockCoverageFilters, mockEnvironment, mockMatchup } from "../mockData";
import type { SlateEvent } from "@/lib/oddsApi";
import type { DiscoveredPlayer } from "@/lib/discoveredProps";
import type { PlayerPropMarketKey } from "@/lib/playerPropMarkets";

export type RealSlateStatus = "idle" | "loading" | "loaded" | "error";
export type DiscoveryStatus = "idle" | "loading" | "loaded" | "error";

export interface MatchupSlice {
  matchupConfig: MatchupConfig;
  setMatchupConfig: (config: MatchupConfig) => void;

  // Mock-seeded, single-game state -- kept until #27 steps 6-7 replace
  // page.tsx's hardcoded header and /api/stream's hardcoded prop with
  // the real ingestion state below.
  slate: Slate;
  selectedMatchupId: string;
  setSelectedMatchupId: (id: string) => void;

  // Real slate ingestion (#27). Populated by whichever hook/effect calls
  // /api/slate and /api/slate/[eventId]/props (step 6) -- slices in this
  // store are plain state + setters, never fetch themselves, same as
  // every other slice here (see useInitAuth.ts for where fetching
  // actually lives).
  realSlate: SlateEvent[];
  realSlateStatus: RealSlateStatus;
  realSlateError: string | null;
  setRealSlate: (events: SlateEvent[]) => void;
  setRealSlateStatus: (status: RealSlateStatus) => void;
  setRealSlateError: (error: string | null) => void;

  selectedEventId: string | null;
  setSelectedEventId: (eventId: string | null) => void;

  checkedMarketKeys: PlayerPropMarketKey[];
  toggleMarketKey: (key: PlayerPropMarketKey) => void;
  setCheckedMarketKeys: (keys: PlayerPropMarketKey[]) => void;

  discoveredProps: DiscoveredPlayer[];
  discoveryStatus: DiscoveryStatus;
  discoveryError: string | null;
  setDiscoveredProps: (players: DiscoveredPlayer[]) => void;
  setDiscoveryStatus: (status: DiscoveryStatus) => void;
  setDiscoveryError: (error: string | null) => void;
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

  realSlate: [],
  realSlateStatus: "idle",
  realSlateError: null,
  setRealSlate: (events) => set({ realSlate: events }),
  setRealSlateStatus: (status) => set({ realSlateStatus: status }),
  setRealSlateError: (error) => set({ realSlateError: error }),

  selectedEventId: null,
  setSelectedEventId: (eventId) =>
    set({
      selectedEventId: eventId,
      // Switching games invalidates whatever was discovered for the
      // PREVIOUS game in the SAME update -- stale props from a
      // different event must never render as if they belonged to the
      // newly-selected one, same reasoning as authSlice's dataVerified
      // reset on a uid change.
      checkedMarketKeys: [],
      discoveredProps: [],
      discoveryStatus: "idle",
      discoveryError: null,
    }),

  checkedMarketKeys: [],
  toggleMarketKey: (key) =>
    set((state) => ({
      checkedMarketKeys: state.checkedMarketKeys.includes(key)
        ? state.checkedMarketKeys.filter((existing) => existing !== key)
        : [...state.checkedMarketKeys, key],
    })),
  setCheckedMarketKeys: (keys) => set({ checkedMarketKeys: keys }),

  discoveredProps: [],
  discoveryStatus: "idle",
  discoveryError: null,
  setDiscoveredProps: (players) => set({ discoveredProps: players }),
  setDiscoveryStatus: (status) => set({ discoveryStatus: status }),
  setDiscoveryError: (error) => set({ discoveryError: error }),
});
