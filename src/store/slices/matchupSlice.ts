import type { MatchupConfig } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";
import { mockCoverageFilters } from "../mockData";
import type { SlateEvent } from "@/lib/oddsApi";
import type { DiscoveredPlayer } from "@/lib/discoveredProps";
import type { PlayerPropMarketKey } from "@/lib/playerPropMarkets";
import type { PlayerPropDirection } from "@/lib/playerPropMarkets";
import type { NflSlateWindow } from "@/lib/nflWeek";

export type RealSlateStatus = "idle" | "loading" | "loaded" | "error";
export type DiscoveryStatus = "idle" | "loading" | "loaded" | "error";

// Captured at the moment a user clicks "Watch" on a real discovered
// prop -- everything /api/stream and the header need to drive the live
// EV pipeline off a real selection instead of mockMatchup. Display
// fields (propType/homeTeam/awayTeam) are captured here rather than
// re-derived later so page.tsx doesn't need to cross-reference
// realSlate/PLAYER_PROP_MARKETS just to render a label.
export type WatchSelection = {
  eventId: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  marketKey: string;
  propType: string;
  playerName: string;
  bookmakerKey: string;
  direction: PlayerPropDirection;
};

export interface MatchupSlice {
  matchupConfig: MatchupConfig;
  setMatchupConfig: (config: MatchupConfig) => void;

  // Real slate ingestion (#27). Populated by whichever hook/effect calls
  // /api/slate and /api/slate/[eventId]/props (step 6) -- slices in this
  // store are plain state + setters, never fetch themselves, same as
  // every other slice here (see useInitAuth.ts for where fetching
  // actually lives).
  realSlate: SlateEvent[];
  realSlateWindow: NflSlateWindow | null;
  realSlateStatus: RealSlateStatus;
  realSlateError: string | null;
  setRealSlate: (events: SlateEvent[], window: NflSlateWindow) => void;
  setRealSlateStatus: (status: RealSlateStatus) => void;
  setRealSlateError: (error: string | null) => void;

  selectedEventId: string | null;
  setSelectedEventId: (eventId: string | null) => void;

  checkedMarketKeys: PlayerPropMarketKey[];
  toggleMarketKey: (key: PlayerPropMarketKey) => void;
  setCheckedMarketKeys: (keys: PlayerPropMarketKey[]) => void;

  discoveredProps: DiscoveredPlayer[];
  discoveredPropsEventId: string | null;
  discoveredPropsMarketKeys: PlayerPropMarketKey[];
  discoveryStatus: DiscoveryStatus;
  discoveryError: string | null;
  setDiscoveredProps: (
    players: DiscoveredPlayer[],
    eventId: string,
    marketKeys: PlayerPropMarketKey[]
  ) => void;
  setDiscoveryStatus: (status: DiscoveryStatus) => void;
  setDiscoveryError: (error: string | null) => void;

  // The real selection driving /api/stream + the EV-breakdown header.
  primaryWatch: WatchSelection | null;
  setPrimaryWatch: (selection: WatchSelection | null) => void;
  // A second, independent real selection -- NOT live-tracked over SSE,
  // used only to demonstrate the optimistic watch/unwatch + rollback
  // pattern the brief calls for. Real prop data, just not the one
  // driving the live pipeline.
  secondaryWatch: WatchSelection | null;
  setSecondaryWatch: (selection: WatchSelection | null) => void;
}

export const createMatchupSlice: StateCreator<
  AppState,
  [],
  [],
  MatchupSlice
> = (set) => ({
  matchupConfig: {
    sampleWindow: 5,
    // Empty, not a mock seed. Live line/weather values are stored in the
    // watched prop's keyed snapshot rather than this global config.
    environment: {},
    coverageFilters: mockCoverageFilters,
  },
  setMatchupConfig: (config) => set({ matchupConfig: config }),

  realSlate: [],
  realSlateWindow: null,
  realSlateStatus: "idle",
  realSlateError: null,
  setRealSlate: (events, window) =>
    set((state) => {
      const selectedEventStillExists =
        state.selectedEventId === null || events.some((event) => event.id === state.selectedEventId);
      return {
        realSlate: events,
        realSlateWindow: window,
        ...(selectedEventStillExists
          ? {}
          : {
              selectedEventId: null,
              checkedMarketKeys: [],
              discoveredProps: [],
              discoveredPropsEventId: null,
              discoveredPropsMarketKeys: [],
              discoveryStatus: "idle" as const,
              discoveryError: null,
            }),
      };
    }),
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
      discoveredPropsEventId: null,
      discoveredPropsMarketKeys: [],
      discoveryStatus: "idle",
      discoveryError: null,
    }),

  checkedMarketKeys: [],
  toggleMarketKey: (key) =>
    set((state) => ({
      checkedMarketKeys: state.checkedMarketKeys.includes(key)
        ? state.checkedMarketKeys.filter((existing) => existing !== key)
        : [...state.checkedMarketKeys, key],
      discoveredProps: [],
      discoveredPropsEventId: null,
      discoveredPropsMarketKeys: [],
      discoveryStatus: "idle",
      discoveryError: null,
    })),
  setCheckedMarketKeys: (keys) =>
    set({
      checkedMarketKeys: keys,
      discoveredProps: [],
      discoveredPropsEventId: null,
      discoveredPropsMarketKeys: [],
      discoveryStatus: "idle",
      discoveryError: null,
    }),

  discoveredProps: [],
  discoveredPropsEventId: null,
  discoveredPropsMarketKeys: [],
  discoveryStatus: "idle",
  discoveryError: null,
  setDiscoveredProps: (players, eventId, marketKeys) =>
    set({
      discoveredProps: players,
      discoveredPropsEventId: eventId,
      discoveredPropsMarketKeys: [...marketKeys].sort(),
    }),
  setDiscoveryStatus: (status) => set({ discoveryStatus: status }),
  setDiscoveryError: (error) => set({ discoveryError: error }),

  primaryWatch: null,
  setPrimaryWatch: (selection) => set({ primaryWatch: selection }),
  secondaryWatch: null,
  setSecondaryWatch: (selection) => set({ secondaryWatch: selection }),
});
