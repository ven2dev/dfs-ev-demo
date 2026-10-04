import type { OddsDataSource } from "@/lib/oddsDataSource";

export type ConnectionStatus = "connecting" | "live" | "stale" | "disconnected";

export type AuthStatus = "loading" | "signed-in" | "signed-out" | "unavailable";

export type EVScore = {
  modelProb: number;
  impliedProb: number;
  edge: number;
};

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
  // Optional, not a zeroed placeholder: undefined means "no fresh tick
  // yet under the CURRENT sampleWindow" (either never watched live, or
  // just reconnected after a window change) -- a zeroed EVScore would
  // be indistinguishable from a real "0% edge" result. The optimistic
  // watch/unwatch placeholder (watchlistToggle.ts) still seeds a
  // zeroed value for its own narrower purpose (that flow never reads
  // evScore back), but every evScore-dependent UI element must treat
  // undefined as "nothing to show yet," not "edge is zero."
  evScore?: EVScore;
  evHistory: EVHistory;
  // Optional: only present once a fresh SSE tick has landed under the
  // CURRENT sampleWindow.
  stages?: EVPipelineStages;
  // Average of the prop's OWN stat (same stat as the line itself, e.g.
  // passing yards) over the currently-selected sampleWindow -- not a
  // fantasy-points projection. Same "undefined until a fresh tick
  // lands" rule as evScore/stages.
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
