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
  evScore: EVScore;
  evHistory: EVHistory;
  // Optional: only present once a real SSE tick has landed -- the
  // optimistic watch/unwatch placeholder (watchlistToggle.ts) has
  // neither, same as it's always had a zeroed-out evScore.
  stages?: EVPipelineStages;
  // Average of the prop's OWN stat (same stat as the line itself, e.g.
  // passing yards) over the currently-selected sampleWindow -- not a
  // fantasy-points projection.
  recentStatAverage?: number;
};

export type Prop = {
  propId: string;
  playerName: string;
  propType: string;
  marketKey: string;
  line: number;
  salary: number;
  recentGameStats: number[];
};

export type Matchup = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  sportKey: string;
  eventId: string;
  props: Prop[];
};

export type Slate = Matchup[];

export type EVPipelineStage =
  | "baseRate"
  | "environmentAdjustment"
  | "coverageAdjustment"
  | "finalEv";
