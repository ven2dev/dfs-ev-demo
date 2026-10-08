import type { Artifact, DataByKind, Dataset, Kind, Request, Revision, Schedule } from "../../../src/lib/predictive/types.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";

export const PLAYER = "00-0000001";
export const TEAM = "nfl:team:PHI";
export const OPPONENT = "nfl:team:DAL";
export const CAPTURE_A = "2026-10-07T12:00:00.000Z";
export const CAPTURE_B = "2026-10-08T13:00:00.000Z";
export const CUTOFF_A = "2026-10-08T12:00:00.000Z";
export const CUTOFF_B = "2026-10-08T14:00:00.000Z";
export const gameId = (number: number) => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
export const TARGET = gameId(10);
export const PRIOR = [1, 2, 3, 4, 5].map(gameId);

export function revision<K extends Kind>(id: string, kind: K, data: DataByKind[K], predecessorId: string | null = null): Revision<K> {
  return { id, kind, data, predecessorId, correctionReason: predecessorId ? "synthetic correction" : null } as Revision<K>;
}
export function artifact(id: string, feed: Kind, rows: Revision[]): Artifact {
  const bytes = canonical(rows);
  return { id, feed, bytes, sha256: digest(bytes), source: "synthetic", origin: "fixture://passing-yards/" + id,
    schemaVersion: "predictive-proof-v1", parserVersion: "synthetic-json-v1", rightsReviewVersion: "synthetic-only-v1" };
}
export function addCapture(dataset: Dataset, id: string, rows: Revision[], at = CAPTURE_A) {
  dataset.artifacts.push(artifact(id, rows[0].kind, rows));
  dataset.captures.push({ id: "capture-" + id, artifactId: id, capturedAt: at, availableAt: at, ingestedAt: at,
    publishedAt: null, publicationEvidence: null, state: "published" });
}
export function request(cutoff = CUTOFF_A): Request {
  return { playerId: PLAYER, gameId: TARGET, cutoff, computedAt: "2026-10-09T00:00:00.000Z", candidate: "player-opponent-v1:player_pass_yds" };
}
export function schedule(number: number, kickoff: string, home = TEAM, away = "nfl:team:NYG", season = 2026, seasonType: "REG" | "POST" = "REG"): Schedule {
  return { gameId: gameId(number), rawGameId: "synthetic-game-" + number, season, seasonType, week: number <= 5 ? number : 6,
    kickoff, homeTeamId: home, awayTeamId: away, rawHomeTeam: home.split(":").at(-1)!, rawAwayTeam: away.split(":").at(-1)!, mappingVersion: "synthetic-identity-v1" };
}

// No provider rows, player names, network calls, database or environment reads.
// Capturing old games now establishes only this synthetic forward replay proof.
export function passingYardsFixture(includeB = true): Dataset {
  const dataset: Dataset = { formatVersion: 1, artifacts: [], captures: [] };
  const rows: Record<Kind, Revision[]> = { schedule: [], membership: [], "player-passing": [], "team-passing": [], completion: [], participation: [], availability: [] };
  const games = ["09-06", "09-13", "09-20", "09-27", "10-04"].map((date, i) => schedule(i + 1, "2026-" + date + "T17:00:00.000Z"));
  const opponents = ["BUF", "KC", "NE", "SF"];
  const against = ["09-13", "09-20", "09-27", "10-04"].map((date, i) => schedule(i + 20, "2026-" + date + "T20:00:00.000Z", OPPONENT, "nfl:team:" + opponents[i]));
  const target = schedule(10, "2026-10-11T17:00:00.000Z", TEAM, OPPONENT);
  const ignored = [schedule(30, "2026-01-11T17:00:00.000Z", TEAM, OPPONENT, 2025, "POST"),
    schedule(31, "2023-09-10T17:00:00.000Z", TEAM, "nfl:team:NYG", 2023), schedule(32, "2026-10-18T17:00:00.000Z", TEAM)];
  for (const game of [...games, ...against, target, ...ignored]) rows.schedule.push(revision("schedule-" + game.rawGameId, "schedule", game));
  for (const game of [...games, target]) {
    rows.membership.push(revision("member-" + game.rawGameId, "membership", {
      gameId: game.gameId, playerId: PLAYER, rawPlayerId: PLAYER, teamId: TEAM, rawTeam: "PHI", position: "QB",
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z", mappingVersion: "synthetic-identity-v1" }));
    const i = games.indexOf(game);
    const base = { gameId: game.gameId, rawGameId: game.rawGameId, teamId: TEAM, rawTeam: "PHI", season: 2026, seasonType: "REG" as const, missingReason: null };
    // Deliberately plant target-game outcomes: they must never be selected.
    rows["player-passing"].push(revision("player-" + game.rawGameId, "player-passing", {
      ...base, playerId: PLAYER, rawPlayerId: PLAYER, attempts: i < 0 ? 99 : [10, 20, 30, 10, 40][i], passingYards: i < 0 ? 999 : [50, 100, 210, 90, 300][i] }));
    rows["team-passing"].push(revision("team-" + game.rawGameId, "team-passing", {
      ...base, attempts: i < 0 ? 100 : [12, 24, 35, 15, 45][i], passingYards: i < 0 ? 1_000 : [60, 144, 245, 120, 360][i] }));
    if (i >= 0) rows.participation.push(revision("participation-" + game.rawGameId, "participation", { gameId: game.gameId, playerId: PLAYER, state: "confirmed", evidenceVersion: "synthetic-offense-v1" }));
  }
  for (const [i, game] of against.entries()) {
    const base = { gameId: game.gameId, rawGameId: game.rawGameId, season: 2026, seasonType: "REG" as const, missingReason: null };
    rows["team-passing"].push(revision("against-" + game.rawGameId, "team-passing", { ...base, teamId: game.awayTeamId, rawTeam: game.rawAwayTeam, attempts: [20, 30, 40, 10][i], passingYards: [120, 210, 320, 50][i] }));
    // Opponent's own offense is deliberately different from passing allowed.
    rows["team-passing"].push(revision("opponent-offense-" + game.rawGameId, "team-passing", { ...base, teamId: OPPONENT, rawTeam: "DAL", attempts: 50, passingYards: 500 }));
  }
  for (const game of [...games, ...against]) rows.completion.push(revision("complete-" + game.rawGameId, "completion", {
    gameId: game.gameId, state: "confirmed", bound: CAPTURE_A, boundKind: "completion-observed-at", evidenceVersion: "synthetic-complete-v1" }));
  rows.availability.push(revision("availability-target", "availability", { gameId: TARGET, playerId: PLAYER, injury: "unknown", depth: "unknown", evidenceVersion: "synthetic-availability-v1" }));
  for (const kind of Object.keys(rows) as Kind[]) addCapture(dataset, "A-" + kind, rows[kind]);
  if (includeB) {
    const playerA = rows["player-passing"].find((row) => row.data.gameId === PRIOR[4])! as Revision<"player-passing">;
    const teamA = rows["team-passing"].find((row) => row.data.gameId === PRIOR[4])! as Revision<"team-passing">;
    addCapture(dataset, "B-player", [revision("player-correction-B", "player-passing", { ...playerA.data, passingYards: 320 }, playerA.id)], CAPTURE_B);
    addCapture(dataset, "B-team", [revision("team-correction-B", "team-passing", { ...teamA.data, passingYards: 380 }, teamA.id)], CAPTURE_B);
  }
  return dataset;
}
