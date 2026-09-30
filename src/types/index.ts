export type ConnectionStatus = "live" | "stale" | "disconnected";

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

export type WatchedProp = {
  propId: string;
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
  // Optional: only present once a real SSE tick has landed under the
  // CURRENT sampleWindow.
  stages?: EVPipelineStages;
  // Average of the prop's OWN stat (same stat as the line itself, e.g.
  // passing yards) over the currently-selected sampleWindow -- not a
  // fantasy-points projection. Same "undefined until a fresh tick
  // lands" rule as evScore/stages.
  recentStatAverage?: number;
};

export type EVPipelineStage =
  | "baseRate"
  | "environmentAdjustment"
  | "coverageAdjustment"
  | "finalEv";
