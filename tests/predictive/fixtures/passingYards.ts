import { KINDS, STAT_FIELDS, type Artifact, type DataByKind, type Dataset, type Kind, type Membership, type PlayerGameSnaps, type PlayerGameStats,
  type Profile, type Request, type Revision, type RightsDecision, type Schedule, type TeamGameSnaps, type TeamGameStats } from "../../../src/lib/predictive/types.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";

export const PLAYER = "00-0000001";
export const TEAM = "nfl:team:PHI";
export const OPPONENT = "nfl:team:DAL";
export const PROFILE = "synthetic-proof-v1";
export const CAPTURE_A = "2026-10-07T12:00:00.000Z";
export const CAPTURE_B = "2026-10-08T13:00:00.000Z";
export const CUTOFF_A = "2026-10-08T12:00:00.000Z";
export const CUTOFF_B = "2026-10-08T14:00:00.000Z";
export const gameId = (number: number) => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
export const TARGET = gameId(10);
export const PRIOR = [1, 2, 3, 4, 5].map(gameId);

// A synthetic-test profile can never reach public display, and in PostgreSQL its
// rows are accepted only from the disposable harness role.
export const profile = (id = PROFILE): Profile => ({
  id, purpose: "synthetic-test", provider: "synthetic", feed: "passing-yards-proof", releaseTag: null, assetPattern: null,
  headerProfileSha256: null, parserVersion: "synthetic-json-v2", allowlistVersion: "predictive-raw-allowlist-v1",
  license: "synthetic-test-data", attribution: null, evidenceKinds: [...KINDS], registeredAt: "2026-01-01T00:00:00.000Z",
});
export const rights = (profileId = PROFILE, overrides: Partial<RightsDecision> = {}): RightsDecision => ({
  id: "rights-" + profileId, profileId, predecessorId: null, allowedUses: ["internal-research", "model-input", "outcome-label"],
  effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, decidedAt: "2026-01-01T00:00:00.000Z",
  evidenceKind: "synthetic", evidenceReference: "synthetic fixtures only", ...overrides,
});
export const emptyDataset = (): Dataset => ({ formatVersion: 2, profiles: [profile()], rightsDecisions: [rights()], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] });

type FixtureData<K extends Kind> = K extends "membership" | "player-game-stats" | "player-game-snaps" | "participation-evidence" | "availability"
  ? Omit<DataByKind[K], "rawPlayerId" | "playerIdProvider"> & Partial<{ rawPlayerId: string; playerIdProvider: string }> : DataByKind[K];
export const revision = <K extends Kind>(id: string, kind: K, data: FixtureData<K>, predecessorId: string | null = null, sourceRecordId = ""): Revision<K> => {
  const sourceData = ["membership", "player-game-stats", "player-game-snaps", "participation-evidence", "availability"].includes(kind)
    ? { rawPlayerId: (data as { playerId: string }).playerId, playerIdProvider: "gsis", ...data } : data;
  return { id, kind, sourceRecordId, data: sourceData, predecessorId, correctionReason: predecessorId ? "synthetic correction" : null } as Revision<K>;
};
export const artifact = (id: string, rows: Revision[], profileId = PROFILE): Artifact => {
  const bytes = canonical(rows);
  return { id, bytes, sha256: digest(bytes), profileId, retrievalKind: "full", origin: "fixture://passing-yards/" + id,
    providerEtag: null, providerLastModified: null, releaseUpdatedAt: null, scopeKind: "manual", scopeSeason: null, scopeWeek: null, scopeGameId: null, scopeFilter: null };
};
export const addCapture = (dataset: Dataset, id: string, rows: Revision[], at = CAPTURE_A, profileId = PROFILE) => {
  dataset.artifacts.push(artifact(id, rows, profileId));
  dataset.captures.push({ id: "capture-" + id, artifactId: id, capturedAt: at, availableAt: at, ingestedAt: at,
    publishedAt: null, publicationEvidence: null, state: "published", bodyComplete: true, headerVerified: true,
    parserSucceeded: true, parsedRows: rows.length });
};
export const request = (cutoff = CUTOFF_A): Request => {
  return { playerId: PLAYER, gameId: TARGET, cutoff, computedAt: "2026-10-09T00:00:00.000Z", candidate: "player-opponent-v1:player_pass_yds" };
};
export const schedule = (number: number, kickoff: string, home = TEAM, away = "nfl:team:NYG", season = 2026, seasonType: "REG" | "POST" = "REG"): Schedule => {
  return { gameId: gameId(number), rawGameId: "synthetic-game-" + number, season, seasonType, week: number <= 5 ? number : 6,
    kickoff, rawGameday: null, rawGametime: null, homeTeamId: home, awayTeamId: away,
    rawHomeTeam: home.split(":").at(-1)!, rawAwayTeam: away.split(":").at(-1)!, rawRoof: null, rawSurface: null, rawStadiumId: null };
};
export const coverage = (teamId: string, gameIds: string[]): DataByKind["schedule-coverage"] => ({
  teamId, fromSeason: 2024, throughSeason: 2026, gameIds: [...gameIds].sort(), state: "complete",
});
export const membership = (game: Schedule, overrides: Partial<Membership> = {}): Membership => ({
  gameId: game.gameId, playerId: PLAYER, rawPlayerId: PLAYER, playerIdProvider: "gsis", teamId: TEAM, rawTeam: "PHI", position: "QB", rosterStatus: "ACT",
  season: game.season, seasonType: game.seasonType, week: game.week,
  effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z", ...overrides,
});
// Passing-yards fixtures set attempts and yards; the other eight counts are
// explicit zeros so positive usage comes only from the passing values.
export const teamStats = (game: Schedule, teamId: string, rawTeam: string, attempts: number | null, passingYards: number | null): TeamGameStats => {
  const counts = Object.fromEntries(STAT_FIELDS.map((field) => [field, 0])) as Record<(typeof STAT_FIELDS)[number], number | null>;
  return { gameId: game.gameId, rawGameId: game.rawGameId, teamId, rawTeam, season: game.season, seasonType: game.seasonType,
    ...counts, attempts, passingYards, missing: {} };
};
export const playerStats = (game: Schedule, attempts: number | null, passingYards: number | null, teamId = TEAM, rawTeam = "PHI"): PlayerGameStats =>
  ({ ...teamStats(game, teamId, rawTeam, attempts, passingYards), playerId: PLAYER, rawPlayerId: PLAYER, playerIdProvider: "gsis" });
export const playerSnaps = (game: Schedule, offenseSnaps: number | null, teamId = TEAM, rawTeam = "PHI"): PlayerGameSnaps => ({
  gameId: game.gameId, rawGameId: game.rawGameId, playerId: PLAYER, rawPlayerId: PLAYER, playerIdProvider: "gsis", teamId, rawTeam, season: game.season, seasonType: game.seasonType,
  offenseSnaps, specialTeamsSnaps: 0, played: true, started: true, routesRun: null,
  missing: { routesRun: "source-missing", ...(offenseSnaps === null ? { offenseSnaps: "source-blank" as const } : {}) },
});
export const teamSnaps = (game: Schedule, offenseSnaps: number | null, playCountingDefinition = "offensive-plays-v1", teamId = TEAM, rawTeam = "PHI"): TeamGameSnaps => ({
  gameId: game.gameId, rawGameId: game.rawGameId, teamId, rawTeam, season: game.season, seasonType: game.seasonType,
  offenseSnaps, dropbacks: null, playCountingDefinition,
  missing: { dropbacks: "source-missing", ...(offenseSnaps === null ? { offenseSnaps: "source-blank" as const } : {}) },
});
export const completionMarkers = (game: Schedule, at: string = CAPTURE_A) => [
  revision("final-" + game.rawGameId, "event-state-marker", { gameId: game.gameId, markerType: "provider-final-status", markerValue: "final", terminalPlayTimeOfDay: null }),
  revision("terminal-" + game.rawGameId, "event-state-marker", { gameId: game.gameId, markerType: "terminal-play", markerValue: "END GAME", terminalPlayTimeOfDay: at.slice(11, 19) }),
];

// No provider rows, player names, network calls, database or environment reads.
// Capturing old games now establishes only this synthetic forward replay proof.
export const passingYardsFixture = (includeB = true): Dataset => {
  const dataset = emptyDataset();
  const rows: Partial<Record<Kind, Revision[]>> = {};
  const push = (kind: Kind, row: Revision) => { (rows[kind] ??= []).push(row); };
  const games = ["09-06", "09-13", "09-20", "09-27", "10-04"].map((date, i) => schedule(i + 1, "2026-" + date + "T17:00:00.000Z"));
  const opponents = ["BUF", "KC", "NE", "SF"];
  const against = ["09-13", "09-20", "09-27", "10-04"].map((date, i) => schedule(i + 20, "2026-" + date + "T20:00:00.000Z", OPPONENT, "nfl:team:" + opponents[i]));
  const target = schedule(10, "2026-10-11T17:00:00.000Z", TEAM, OPPONENT);
  const ignored = [schedule(30, "2026-01-11T17:00:00.000Z", TEAM, OPPONENT, 2025, "POST"),
    schedule(31, "2023-09-10T17:00:00.000Z", TEAM, "nfl:team:NYG", 2023), schedule(32, "2026-10-18T17:00:00.000Z", TEAM)];
  for (const game of [...games, ...against, target, ...ignored]) push("schedule", revision("schedule-" + game.rawGameId, "schedule", game));
  for (const team of [TEAM, OPPONENT]) push("schedule-coverage", revision("coverage-" + team, "schedule-coverage", coverage(team,
    [...games, ...against, target, ...ignored].filter((game) => game.season >= 2024 && [game.homeTeamId, game.awayTeamId].includes(team)).map((game) => game.gameId))));
  for (const game of [...games, target]) {
    push("membership", revision("member-" + game.rawGameId, "membership", membership(game)));
    const i = games.indexOf(game);
    // Deliberately plant target-game outcomes: they must never be selected.
    push("player-game-stats", revision("player-" + game.rawGameId, "player-game-stats",
      playerStats(game, i < 0 ? 99 : [10, 20, 30, 10, 40][i], i < 0 ? 999 : [50, 100, 210, 90, 300][i])));
    push("team-game-stats", revision("team-" + game.rawGameId, "team-game-stats",
      teamStats(game, TEAM, "PHI", i < 0 ? 100 : [12, 24, 35, 15, 45][i], i < 0 ? 1_000 : [60, 144, 245, 120, 360][i])));
  }
  for (const [i, game] of against.entries()) {
    push("team-game-stats", revision("against-" + game.rawGameId, "team-game-stats", teamStats(game, game.awayTeamId, game.rawAwayTeam, [20, 30, 40, 10][i], [120, 210, 320, 50][i])));
    // Opponent's own offense is deliberately different from passing allowed.
    push("team-game-stats", revision("opponent-offense-" + game.rawGameId, "team-game-stats", teamStats(game, OPPONENT, "DAL", 50, 500)));
  }
  for (const game of [...games, ...against]) completionMarkers(game).forEach((row) => push("event-state-marker", row));
  push("availability", revision("availability-target", "availability", { gameId: TARGET, playerId: PLAYER, teamId: TEAM, rawReportStatus: null, rawPracticeStatus: null, rawDepthRank: null }));
  for (const kind of KINDS) if (rows[kind]) addCapture(dataset, "A-" + kind, rows[kind]!);
  if (includeB) {
    const playerA = rows["player-game-stats"]!.find((row) => row.kind === "player-game-stats" && row.data.gameId === PRIOR[4])! as Revision<"player-game-stats">;
    const teamA = rows["team-game-stats"]!.find((row) => row.kind === "team-game-stats" && row.data.gameId === PRIOR[4])! as Revision<"team-game-stats">;
    addCapture(dataset, "B-player", [revision("player-correction-B", "player-game-stats", { ...playerA.data, passingYards: 320 }, playerA.id)], CAPTURE_B);
    addCapture(dataset, "B-team", [revision("team-correction-B", "team-game-stats", { ...teamA.data, passingYards: 380 }, teamA.id)], CAPTURE_B);
  }
  return dataset;
};
