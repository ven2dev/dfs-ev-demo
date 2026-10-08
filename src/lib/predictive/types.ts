export type SeasonType = "REG" | "POST";
export type Candidate = "stats-v1:player_pass_yds" | "player-opponent-v1:player_pass_yds";
export type Kind = "schedule" | "membership" | "player-passing" | "team-passing" |
  "completion" | "participation" | "availability";

export type Schedule = {
  gameId: string; rawGameId: string; season: number; seasonType: SeasonType; week: number;
  kickoff: string; homeTeamId: string; awayTeamId: string;
  rawHomeTeam: string; rawAwayTeam: string; mappingVersion: string;
};
export type Membership = {
  gameId: string; playerId: string; rawPlayerId: string; teamId: string; rawTeam: string;
  position: string; effectiveFrom: string; effectiveTo: string; mappingVersion: string;
};
export type Passing = {
  gameId: string; rawGameId: string; teamId: string; rawTeam: string;
  season: number; seasonType: SeasonType; attempts: number | null; passingYards: number | null;
  missingReason: "source-blank" | "source-missing" | null;
};
export type PlayerPassing = Passing & { playerId: string; rawPlayerId: string };
export type Completion = {
  gameId: string; state: "confirmed" | "unresolved"; bound: string | null;
  boundKind: "actual-end" | "completion-observed-at" | null; evidenceVersion: string;
};
export type Participation = {
  gameId: string; playerId: string; state: "confirmed" | "absent" | "unresolved"; evidenceVersion: string;
};
export type Availability = {
  gameId: string; playerId: string; injury: "unknown" | "eligible" | "excluded";
  depth: "unknown" | "observed"; evidenceVersion: string;
};
export type DataByKind = {
  schedule: Schedule; membership: Membership; "player-passing": PlayerPassing; "team-passing": Passing;
  completion: Completion; participation: Participation; availability: Availability;
};
export type Revision<K extends Kind = Kind> = K extends Kind ? {
  id: string; kind: K; predecessorId: string | null; correctionReason: string | null; data: DataByKind[K];
} : never;
export type Artifact = {
  id: string; sha256: string; bytes: string; source: "synthetic"; origin: string; feed: Kind;
  schemaVersion: "predictive-proof-v1"; parserVersion: "synthetic-json-v1"; rightsReviewVersion: "synthetic-only-v1";
};
export type Capture = {
  id: string; artifactId: string; capturedAt: string; availableAt: string; ingestedAt: string;
  publishedAt: string | null; publicationEvidence: string | null; state: "published" | "incomplete";
};
export type Dataset = { formatVersion: 1; artifacts: Artifact[]; captures: Capture[] };
export type Observation<K extends Kind = Kind> = {
  revision: Revision<K>; capture: Capture; artifact: Artifact;
};
export type Dependency = {
  observationId: string; predecessorId: string | null; correctionReason: string | null;
  kind: Kind; captureId: string; artifactId: string; artifactSha256: string;
  source: string; origin: string; schemaVersion: string; parserVersion: string;
  rightsReviewVersion: string; publishedAt: string | null; publicationEvidence: string | null;
  capturedAt: string; availableAt: string; ingestedAt: string; mappingVersion: string | null;
};
export type Request = { playerId: string; gameId: string; cutoff: string; computedAt: string; candidate: Candidate };
export type Exclusion = { gameId: string; reason: string };
export type PassingGame = {
  gameId: string; season: number; seasonType: SeasonType; kickoff: string; teamId: string;
  attempts: number; passingYards: number;
};
export type Summary = {
  window: number; expectedGames: number; observedGames: number; excludedGames: number; unknownGames: number;
  gameIds: string[]; dateRange: [string, string] | null; games: PassingGame[];
  exclusions: Exclusion[]; attemptsSum: number; passingYardsSum: number;
  attemptsPerGame: number | null; passingYardsPerAttempt: number | null;
};
export type Bundle = {
  formatVersion: 1; featureVersion: "passing-yards-replay-v1"; readMode: "application-data-replay";
  usage: "synthetic-internal-research"; modelValidated: false; populationCoverage: "unqualified";
  units: { attempts: "attempts"; passingYards: "yards"; attemptsPerGame: "attempts/game";
    passingYardsPerAttempt: "yards/attempt"; scheduledRestHours: "hours" };
  request: Omit<Request, "computedAt">; computedAt: string; status: "ready-inputs" | "unavailable-inputs";
  reasons: string[]; quality: string[]; target: Schedule | null; teamId: string | null; opponentId: string | null;
  availability: { injury: Availability["injury"]; depth: Availability["depth"]; participation: "future-unknown" };
  player: Summary[]; team: Summary[] | null; opponent: Summary[] | null;
  scheduledRestHours: number | null; dependencyAvailableAt: string | null; dependencies: Dependency[];
  excludedSchedule: Exclusion[]; inputDigest: string;
};
