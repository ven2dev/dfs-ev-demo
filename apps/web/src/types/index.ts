import type { EVScore, PlayerPropDirection } from "@dfs-ev/domain";

import type { OddsDataSource } from "@/lib/oddsDataSource";

export type ConnectionStatus = "connecting" | "live" | "stale" | "disconnected";

export type AuthStatus = "loading" | "signed-in" | "signed-out" | "unavailable";

export type EVHistoryEntry = {
  timestamp: number;
  evScore: number;
};

export type EVHistory = EVHistoryEntry[];

export type MatchupConfig = {
  sampleWindow: 3 | 5 | 7;
  environment: Record<string, unknown>;
  coverageFilters: Record<string, unknown>;
};

export type Pick = {
  propId: string;
  direction: "over" | "under";
  impliedProb: number;
};

export type SalaryCapGoal = {
  kind: "salaryCap";
  salaryCap: number;
  rosterSlots: number;
  progress: { slotsFilled: number; capUsed: number };
};

export type PickEmGoal = {
  kind: "pickEm";
  pickCount: number;
  picks: Pick[];
};

export type Goal = SalaryCapGoal | PickEmGoal;

export type EVPipelineStages = {
  baseRate: number;
  afterEnvironment: number;
  afterCoverage: number;
};

export type MarketConsensus = {
  method: "exact-line-median";
  version: 1;
  contributingBookCount: number;
};

export type WatchedProp = {
  propId: string;
  // Server-authoritative provenance for every value in the latest tick.
  // UI copy must not infer this from hostnames or missing credentials.
  dataSource?: OddsDataSource;
  // Latest valid result for this prop. Keep its original provenance while
  // refreshing; a placeholder without stages is not a calculated result.
  evScore?: EVScore;
  evHistory: EVHistory;
  // Present after a valid tick. Window/count belong to this snapshot, not
  // the currently requested window. Older saved entries may lack metadata.
  sampleWindow?: 3 | 5 | 7;
  sampleSize?: number;
  updatedAt?: number;
  refreshState?: "updating" | "failed" | "paused";
  stages?: EVPipelineStages;
  // Average of the prop's OWN stat (same stat as the line itself, e.g.
  // passing yards) over this snapshot's sampleWindow, not a projection.
  recentStatAverage?: number;
  // The tick's line and weather belong to the same prop identity as the
  // EV values above. Keeping them here prevents a newly-selected prop
  // from rendering another selection's last global line or weather.
  line?: number;
  marketConsensus?: MarketConsensus;
  weather?: {
    temperatureF: number;
    windSpeedMph: number;
    precipitationMm: number;
  };
};

export type EVPipelineStage =
  | "baseRate"
  | "environmentAdjustment"
  | "coverageAdjustment"
  | "finalEv";

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
