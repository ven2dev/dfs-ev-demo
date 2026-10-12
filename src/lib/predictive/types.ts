export type SeasonType = "REG" | "POST";
export type Candidate = "stats-v1:player_pass_yds" | "player-opponent-v1:player_pass_yds";
export type Kind = "schedule" | "schedule-coverage" | "membership" | "player-game-stats" | "team-game-stats" |
  "event-state-marker" | "participation-evidence" | "availability" | "source-row-absent" |
  "team-alias" | "game-bridge" | "player-bridge" | "game-relation" | "player-game-snaps" | "team-game-snaps";
export const KINDS: readonly Kind[] = ["schedule", "schedule-coverage", "membership", "player-game-stats",
  "team-game-stats", "event-state-marker", "participation-evidence", "availability", "source-row-absent",
  "team-alias", "game-bridge", "player-bridge", "game-relation", "player-game-snaps", "team-game-snaps"];
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
// Exact raw identity survives normalization. The provider names the ID
// namespace (e.g. gsis), which can differ from the feed's distributor.
export type RawPlayerIdentity = { rawPlayerId: string; playerIdProvider: string };
export type Membership = RawPlayerIdentity & {
  gameId: string; playerId: string; teamId: string; rawTeam: string; position: string; rosterStatus: string;
  season: number; seasonType: SeasonType; week: number; effectiveFrom: string; effectiveTo: string;
};
export type TeamGameStats = StatValues & {
  gameId: string; rawGameId: string; teamId: string; rawTeam: string; season: number; seasonType: SeasonType;
  missing: Partial<Record<StatField, MissingReason>>;
};
export type PlayerGameStats = TeamGameStats & RawPlayerIdentity & { playerId: string };
// Snap counts (approved for #49 snap share). Every nullable field carries its
// own missing reason; a blank never becomes zero. playCountingDefinition names
// the provider's play-counting rule, so two providers compare only when equal.
type SnapIdentity = { gameId: string; rawGameId: string; teamId: string; rawTeam: string; season: number; seasonType: SeasonType };
export type PlayerGameSnaps = SnapIdentity & RawPlayerIdentity & {
  playerId: string; offenseSnaps: number | null; specialTeamsSnaps: number | null; played: boolean | null; started: boolean | null;
  routesRun: number | null; missing: Partial<Record<"offenseSnaps" | "specialTeamsSnaps" | "played" | "started" | "routesRun", MissingReason>>;
};
export type TeamGameSnaps = SnapIdentity & {
  offenseSnaps: number | null; dropbacks: number | null; playCountingDefinition: string;
  missing: Partial<Record<"offenseSnaps" | "dropbacks", MissingReason>>;
};
export type MarkerType = "provider-final-status" | "terminal-play" | "final-team-totals" | "suspension-notice" | "postponement-notice";
export type EventStateMarker = { gameId: string; markerType: MarkerType; markerValue: string; terminalPlayTimeOfDay: string | null };
export type ParticipationEvidence = RawPlayerIdentity & {
  gameId: string; playerId: string; teamId: string;
  evidenceKind: "participation-feed" | "official-inactive-list" | "provider-snap-count";
  claim: "offensive-participant" | "zero-offensive-participation" | "inactive-or-dnp";
};
export type Availability = RawPlayerIdentity & {
  gameId: string; playerId: string; teamId: string;
  rawReportStatus: string | null; rawPracticeStatus: string | null; rawDepthRank: number | null;
};
// A row present in an earlier capture is missing from a later complete capture
// that covers its scope. It joins the prior row's source chain as its head and
// copies the prior row's routing fields so scoped reads still find it.
export const ROUTING_FIELDS = ["gameId", "playerId", "teamId", "season", "seasonType"] as const;
export type SourceRowAbsent = {
  priorObservationId: string; priorEntityKey: string; coveringCaptureId: string;
  scopeKind: ScopeKind; scopeSeason: number | null; scopeWeek: number | null; scopeGameId: string | null; scopeFilter: string | null;
  gameId?: string; playerId?: string; teamId?: string; season?: number; seasonType?: SeasonType;
};
// Identity bridges. Keys name the provider and its raw ID, the documented
// exception to provider-free entity keys: a raw ID only means something inside
// its provider. Mappings are dated where membership can change.
export type TeamAlias = { provider: string; rawAlias: string; teamId: string; effectiveFromSeason: number; effectiveToSeason: number };
export type GameBridge = { provider: string; rawGameId: string; gameId: string };
export type PlayerBridge = { provider: string; rawPlayerId: string; playerId: string; effectiveFrom: string; effectiveTo: string };
export type GameRelation = { gameId: string; predecessorGameId: string; relation: "replacement" };
export type DataByKind = {
  schedule: Schedule; "schedule-coverage": ScheduleCoverage; membership: Membership;
  "player-game-stats": PlayerGameStats; "team-game-stats": TeamGameStats;
  "event-state-marker": EventStateMarker; "participation-evidence": ParticipationEvidence; availability: Availability;
  "source-row-absent": SourceRowAbsent;
  "team-alias": TeamAlias; "game-bridge": GameBridge; "player-bridge": PlayerBridge; "game-relation": GameRelation;
  "player-game-snaps": PlayerGameSnaps; "team-game-snaps": TeamGameSnaps;
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
  scopeSeason: number | null; scopeWeek: number | null; scopeGameId: string | null; scopeFilter: string | null;
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
// A recorded application of event-completion-v1 to exactly the marker heads
// known at decidedAt. Replay recomputes the policy and cites a matching record.
export type CompletionRecord = {
  id: string; kind: "completion"; entityKey: string; policyId: "event-completion-v1";
  mode: "production-research" | "synthetic-proof"; decidedAt: string; predecessorId: string | null;
  outcome: { state: "scheduled" | "in-progress" | "completed" | "suspended" | "postponed" | "conflicting"; completionObservedAt: string | null; actualEnd: null };
  inputs: { observationId: string; role: "marker" }[];
};
// A recorded application of participation-v1 to exactly the participation
// evidence and stats heads for one player-game known at decidedAt.
export type ParticipationRecord = {
  id: string; kind: "participation"; entityKey: string; policyId: "participation-v1";
  mode: "production-research" | "synthetic-proof"; decidedAt: string; predecessorId: string | null;
  outcome: { state: "offensive-participant" | "zero-offensive-participation" | "inactive-or-dnp" | "unresolved" | "conflicting" };
  inputs: { observationId: string; role: "evidence" }[];
};
// snap-compatibility-v1: whether two snap providers count the same plays, decided
// from every snap head of both profiles in the games both cover at decidedAt.
export type SnapCompatibilityRecord = {
  id: string; kind: "snap-source-compatibility"; entityKey: string; policyId: "snap-compatibility-v1";
  mode: "production-research" | "synthetic-proof"; decidedAt: string; predecessorId: string | null;
  outcome: { result: "compatible" | "incompatible" | "insufficient-overlap"; overlapGames: number };
  inputs: { observationId: string; role: "evidence" }[];
};
export type Decision = Reconciliation | CompletionRecord | ParticipationRecord | SnapCompatibilityRecord;
// Canonical outcome labels (canonical-label-finalization-v1). Stat names are the
// registry's canonical fields; values come from the selected stats revision.
export const LABEL_STATS = { passing_yards: "passingYards", passing_tds: "passingTds", completions: "completions", attempts: "attempts",
  passing_interceptions: "passingInterceptions", rushing_yards: "rushingYards", carries: "carries", receiving_yards: "receivingYards",
  receptions: "receptions" } as const;
export type LabelStat = keyof typeof LABEL_STATS;
export type Label = {
  id: string; playerId: string; gameId: string; seasonType: SeasonType; stat: LabelStat; value: number | null;
  state: "provisional" | "final" | "unresolved" | "excluded"; mode: "production-research" | "synthetic-proof";
  policyId: "canonical-label-finalization-v1"; labelVersion: number; predecessorId: string | null;
  completionDecisionId: string; participationDecisionId: string; reconciliationDecisionId: string | null;
  selectedObservationId: string | null; eligibleFinalAt: string | null; postWindowCaptureId: string | null;
  finalizedAt: string | null; createdAt: string;
  // The exact player-bridge revision resolving the label's player: required for
  // final labels, optional for provisional ones, absent otherwise.
  playerBridgeObservationId: string | null;
};
// An explicit permission for a bridge profile's player bridges in one provider
// namespace to resolve identities for a stats profile's rows. Roster and
// statistics feeds can be different profiles; equality is never assumed.
export type IdentityLink = { id: string; statsProfileId: string; bridgeProfileId: string; provider: string; decidedAt: string };
export type Dataset = {
  formatVersion: 2; profiles: Profile[]; rightsDecisions: RightsDecision[]; artifacts: Artifact[]; captures: Capture[];
  decisions: Decision[]; labels: Label[]; identityLinks: IdentityLink[];
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
  participations: { decisionId: string; gameId: string; state: ParticipationRecord["outcome"]["state"]; decidedAt: string }[];
  completions: { decisionId: string; gameId: string; state: CompletionRecord["outcome"]["state"]; decidedAt: string }[];
  reconciliations: { decisionId: string; entityKey: string; result: Reconciliation["outcome"]["result"]; decidedAt: string }[];
  scheduleCoverage: { state: "complete" | "unverified"; missingGameIds: string[] };
};

// retention-policy-v1. The scope descriptor is deterministic, so a restored
// backup re-applies an event by it and removes the same rows.
export type RetentionScope = { kind: "source"; profileIds: string[]; capturedFrom: string | null; capturedBefore: string | null } |
  { kind: "feature-run-expiry"; asOf: string };
export type RetentionEvent = {
  id: string; reason: "expiry" | "rights-revoked" | "provider-request" | "owner-request"; authority: string; decidedAt: string;
  scope: RetentionScope; auditLevel: "full" | "digest-only";
};
export type RecordedRetentionEvent = RetentionEvent & { removedCounts: Record<string, number>; removedIdsDigest: string; executedAt: string };
export type RetentionResult = { eventId: string; removedCounts: Record<string, number>; removedIdsDigest: string; removedBlobRefs: string[] };
