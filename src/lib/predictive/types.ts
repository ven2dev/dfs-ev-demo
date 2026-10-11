export type SeasonType = "REG" | "POST";
export type Candidate = "stats-v1:player_pass_yds" | "player-opponent-v1:player_pass_yds";
export type Kind = "schedule" | "schedule-coverage" | "membership" | "player-game-stats" | "team-game-stats" |
  "event-state-marker" | "participation-evidence" | "availability" | "source-row-absent";
export const KINDS: readonly Kind[] = ["schedule", "schedule-coverage", "membership", "player-game-stats",
  "team-game-stats", "event-state-marker", "participation-evidence", "availability", "source-row-absent"];
export type ScopeKind = "season-file" | "week-file" | "game" | "all-seasons" | "manual";

// The ten count fields behind the nine registry markets. Values are per game.
export const STAT_FIELDS = ["attempts", "completions", "passingYards", "passingTds", "passingInterceptions",
  "carries", "rushingYards", "targets", "receptions", "receivingYards"] as const;
export type StatField = typeof STAT_FIELDS[number];
export type MissingReason = "source-blank" | "source-missing";
type StatValues = { [F in StatField]: number | null };

export type Schedule = {
  gameId: string; rawGameId: string; season: number; seasonType: SeasonType; week: number; kickoff: string;
  rawGameday: string | null; rawGametime: string | null;
  homeTeamId: string; awayTeamId: string; rawHomeTeam: string; rawAwayTeam: string;
  rawRoof: string | null; rawSurface: string | null; rawStadiumId: string | null;
};
// Independent enumeration evidence for a team's complete REG + POST schedule
// across the requested seasons. Missing rows cannot shrink this expected set.
export type ScheduleCoverage = {
  teamId: string; fromSeason: number; throughSeason: number; gameIds: string[]; state: "complete" | "incomplete";
};
export type Membership = {
  gameId: string; playerId: string; teamId: string; rawTeam: string; position: string; rosterStatus: string;
  season: number; seasonType: SeasonType; week: number; effectiveFrom: string; effectiveTo: string;
};
export type TeamGameStats = StatValues & {
  gameId: string; rawGameId: string; teamId: string; rawTeam: string; season: number; seasonType: SeasonType;
  missing: Partial<Record<StatField, MissingReason>>;
};
export type PlayerGameStats = TeamGameStats & { playerId: string };
export type MarkerType = "provider-final-status" | "terminal-play" | "final-team-totals" | "suspension-notice" | "postponement-notice";
export type EventStateMarker = { gameId: string; markerType: MarkerType; markerValue: string; terminalPlayTimeOfDay: string | null };
export type ParticipationEvidence = {
  gameId: string; playerId: string; teamId: string;
  evidenceKind: "participation-feed" | "official-inactive-list" | "provider-snap-count";
  claim: "offensive-participant" | "zero-offensive-participation" | "inactive-or-dnp";
};
export type Availability = {
  gameId: string; playerId: string; teamId: string;
  rawReportStatus: string | null; rawPracticeStatus: string | null; rawDepthRank: number | null;
};
// A row present in an earlier capture is missing from a later complete capture
// that covers its scope. It joins the prior row's source chain as its head and
// copies the prior row's routing fields so scoped reads still find it.
export const ROUTING_FIELDS = ["gameId", "playerId", "teamId", "season", "seasonType"] as const;
export type SourceRowAbsent = {
  priorObservationId: string; priorEntityKey: string; coveringCaptureId: string;
  scopeKind: ScopeKind; scopeSeason: number | null; scopeWeek: number | null; scopeFilter: string | null;
  gameId?: string; playerId?: string; teamId?: string; season?: number; seasonType?: SeasonType;
};
export type DataByKind = {
  schedule: Schedule; "schedule-coverage": ScheduleCoverage; membership: Membership;
  "player-game-stats": PlayerGameStats; "team-game-stats": TeamGameStats;
  "event-state-marker": EventStateMarker; "participation-evidence": ParticipationEvidence; availability: Availability;
  "source-row-absent": SourceRowAbsent;
};
export type Revision<K extends Kind = Kind> = K extends Kind ? {
  id: string; kind: K; sourceRecordId: string; predecessorId: string | null; correctionReason: string | null; data: DataByKind[K];
} : never;

export type Use = "adapter-testing" | "internal-research" | "model-input" | "outcome-label" | "public-display";
export type Profile = {
  id: string; purpose: "source" | "owner-decision" | "synthetic-test"; provider: string; feed: string;
  releaseTag: string | null; assetPattern: string | null; headerProfileSha256: string | null;
  parserVersion: string; allowlistVersion: string; license: string; attribution: string | null;
  evidenceKinds: Kind[]; registeredAt: string;
};
export type RightsDecision = {
  id: string; profileId: string; predecessorId: string | null; allowedUses: Use[];
  effectiveFrom: string; effectiveTo: string | null; decidedAt: string;
  evidenceKind: "terms-review" | "written-confirmation" | "license-file" | "revocation" | "synthetic";
  evidenceReference: string;
};
export type Artifact = {
  id: string; sha256: string; bytes: string; profileId: string; retrievalKind: "full" | "header-probe"; origin: string;
  providerEtag: string | null; providerLastModified: string | null; releaseUpdatedAt: string | null;
  scopeKind: ScopeKind;
  scopeSeason: number | null; scopeWeek: number | null; scopeFilter: string | null;
};
export type Capture = {
  id: string; artifactId: string; capturedAt: string; availableAt: string; ingestedAt: string;
  publishedAt: string | null; publicationEvidence: string | null; state: "published" | "incomplete";
  bodyComplete: boolean; headerVerified: boolean; parserSucceeded: boolean; parsedRows: number;
};
// A cross-source selection, recorded by a versioned policy. It never edits a
// provider's revision; it only chooses among provider heads or reports conflict.
export type Reconciliation = {
  id: string; kind: "reconciliation"; entityKey: string; policyId: "reconciliation-v1";
  mode: "production-research" | "synthetic-proof"; decidedAt: string; predecessorId: string | null;
  outcome: { result: "selected" | "conflict" | "insufficient-sources"; selectedObservationId: string | null;
    rule: "single-source" | "sources-agree" | "material-discrepancy" | "no-candidates" };
  inputs: { observationId: string; role: "candidate" | "selected" }[];
};
export type Dataset = {
  formatVersion: 2; profiles: Profile[]; rightsDecisions: RightsDecision[]; artifacts: Artifact[]; captures: Capture[];
  decisions: Reconciliation[];
};
export type Observation<K extends Kind = Kind> = {
  revision: Revision<K>; capture: Capture; artifact: Artifact; entityKey: string; sourceKey: string;
};
export type Dependency = {
  observationId: string; predecessorId: string | null; correctionReason: string | null; kind: Kind;
  entityKey: string; sourceKey: string; profileId: string; captureId: string; artifactId: string; artifactSha256: string;
  origin: string; publishedAt: string | null; publicationEvidence: string | null;
  capturedAt: string; availableAt: string; ingestedAt: string;
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
  formatVersion: 1; featureVersion: "passing-yards-replay-v3"; readMode: "application-data-replay";
  usage: "synthetic-internal-research"; modelValidated: false; populationCoverage: "unqualified";
  units: { attempts: "attempts"; passingYards: "yards"; attemptsPerGame: "attempts/game";
    passingYardsPerAttempt: "yards/attempt"; scheduledRestHours: "hours" };
  policies: { completion: "event-completion-v1"; participation: "participation-v1"; availability: "availability-v1" };
  request: Omit<Request, "computedAt">; computedAt: string; status: "ready-inputs" | "unavailable-inputs";
  reasons: string[]; quality: string[]; target: Schedule | null; teamId: string | null; opponentId: string | null;
  availability: { injury: "unknown" | "excluded"; depth: "unknown" | "observed"; participation: "future-unknown" };
  player: Summary[]; team: Summary[] | null; opponent: Summary[] | null;
  scheduledRestHours: number | null; dependencyAvailableAt: string | null; dependencies: Dependency[];
  excludedSchedule: Exclusion[]; inputDigest: string;
  reconciliations: { decisionId: string; entityKey: string; result: Reconciliation["outcome"]["result"]; decidedAt: string }[];
  scheduleCoverage: { state: "complete" | "unverified"; missingGameIds: string[] };
};
