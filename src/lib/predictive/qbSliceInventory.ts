import type { SourceFeed, SourceRow } from "./sourceAdapters.ts";
import { easternKickoff } from "./sourceAdapters.ts";
import { indexSourceRows, projectSourceStats, sourceSeasonType } from "./sourceStats.ts";
import { canonical, compareText, digest, exact, instant, PredictiveError, refuse, TEAM_IDS } from "./validation.ts";

export const QB_SLICE_INVENTORY_VERSION = "qb-slice-inventory-v1";
export type QbSliceRequest = { playerId: string; rawTeam: string; rawTargetGameId: string; proposedCutoff: string };
export type SliceSamples = Partial<Record<SourceFeed, SourceRow[]>>;
// Schedule round codes are raw source context; keep POST out of REG windows.
const scheduleSeasonType = (row: SourceRow) => row.game_type === "REG" ? "REG" :
  ["POST", "WC", "DIV", "CON", "SB"].includes(row.game_type) ? "POST" : null;
const teamAliases = new Set(TEAM_IDS.map(id => id.slice("nfl:team:".length)));

/** Discovery only. Raw chronology/claims do not qualify canonical history or coverage. */
export function inventoryQbSlice(samples: SliceSamples, request: QbSliceRequest) {
  exact(request, ["playerId", "rawTeam", "rawTargetGameId", "proposedCutoff"]);
  if (!/^00-\d{7}$/.test(request.playerId) || !teamAliases.has(request.rawTeam)) refuse("slice-identity-refused");
  const cutoff = instant(request.proposedCutoff);
  const schedules = indexSourceRows(samples.schedule ?? [], row => row.game_id);
  const target = schedules.map.get(request.rawTargetGameId);
  if (!target || schedules.conflicts.has(target.game_id) || ![target.home_team, target.away_team].includes(request.rawTeam)) refuse("slice-target-unresolved");
  const season = Number(target.season), seasonType = scheduleSeasonType(target);
  if (!Number.isSafeInteger(season) || season < 1922 || season > 9999 || !seasonType) refuse("slice-target-unresolved");
  const targetKickoff = easternKickoff(target.gameday, target.gametime);
  if (!targetKickoff || cutoff >= instant(targetKickoff)) refuse("slice-cutoff-not-pregame");
  const opponent = request.rawTeam === target.home_team ? target.away_team : target.home_team;
  if (!teamAliases.has(opponent) || opponent === request.rawTeam) refuse("slice-target-unresolved");
  const identifiers = indexSourceRows(samples.identifiers ?? [], row => row.gsis_id);
  const identity = identifiers.map.get(request.playerId);
  if (!identity || identifiers.conflicts.has(request.playerId) || identity.position !== "QB") refuse("slice-player-unresolved");
  const fromSeason = season - 2;
  const relevantTeams = [request.rawTeam, opponent];
  const allSchedules = [...schedules.map.values()].filter(row => Number(row.season) >= fromSeason && Number(row.season) <= season &&
    relevantTeams.some(team => [row.home_team, row.away_team].includes(team)));
  const games = allSchedules.map(row => {
    const parts = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(row.game_id);
    if (schedules.conflicts.has(row.game_id) || !parts || Number(parts[1]) !== Number(row.season) || Number(parts[2]) !== Number(row.week) ||
      parts[3] !== row.away_team || parts[4] !== row.home_team || !teamAliases.has(row.home_team) || !teamAliases.has(row.away_team) ||
      row.home_team === row.away_team || !scheduleSeasonType(row) || !Number.isSafeInteger(Number(row.week)) || Number(row.week) < 1 || Number(row.week) > 22) refuse("slice-schedule-unresolved");
    const kickoff = easternKickoff(row.gameday, row.gametime);
    if (!kickoff) refuse("slice-schedule-unresolved");
    return { row, kickoff };
  }).sort((a, b) => instant(b.kickoff) - instant(a.kickoff) || compareText(a.row.game_id, b.row.game_id));
  const players = indexSourceRows(samples.player ?? [], row => canonical([row.game_id, row.team, row.player_id]));
  const teams = indexSourceRows(samples.team ?? [], row => canonical([row.game_id, row.team]));
  const rosters = indexSourceRows(samples.roster ?? [], row => canonical([row.season, sourceSeasonType(row), row.week, row.team, row.gsis_id]));
  const claim = (game: SourceRow, rawTeam: string, player: boolean) => {
    const index = player ? players : teams;
    const key = canonical([game.game_id, rawTeam, ...(player ? [request.playerId] : [])]);
    const row = index.map.get(key);
    if (!row) return { state: "missing" as const, reason: "statistics-not-in-captured-sample", selectedDigest: null, values: null };
    if (index.conflicts.has(key)) return { state: "unresolved" as const, reason: "statistics-conflicting", selectedDigest: null, values: null };
    try {
      const projected = projectSourceStats(player ? "player" : "team", row);
      if (projected.season !== Number(game.season) || projected.seasonType !== scheduleSeasonType(game) || projected.week !== Number(game.week) ||
          projected.rawOpponent !== (rawTeam === game.home_team ? game.away_team : game.home_team)) refuse("slice-stat-schedule-conflict");
      if (projected.values.attempts === null || projected.values.passingYards === null) refuse("slice-passing-pair-missing");
      return { state: "observed-raw-claim" as const, reason: null, selectedDigest: digest(canonical(row)),
        values: { attempts: projected.values.attempts, passingYards: projected.values.passingYards } };
    } catch (error) {
      if (!(error instanceof PredictiveError)) throw error;
      return { state: "unresolved" as const, reason: error.code, selectedDigest: digest(canonical(row)), values: null };
    }
  };
  const history = (team: string, against: boolean, player: boolean) => games.filter(({ row, kickoff }) =>
    row.game_id !== target.game_id && scheduleSeasonType(row) === seasonType && instant(kickoff) < cutoff &&
    [row.home_team, row.away_team].includes(team)).slice(0, 16).map(({ row, kickoff }, ordinal) => {
      const offense = against ? (row.home_team === team ? row.away_team : row.home_team) : team;
      const stats = claim(row, offense, player);
      const rosterKey = canonical([row.season, scheduleSeasonType(row), row.week, offense, request.playerId]);
      const roster = player ? rosters.map.get(rosterKey) : null;
      return { ordinal, rawGameId: row.game_id, season: Number(row.season), week: Number(row.week), kickoff, rawOffenseTeam: offense,
        statistics: stats, sourceSeasonSupported: Number(row.season) === 2026,
        rosterClaim: player ? rosters.conflicts.has(rosterKey) ? "conflicting" : !roster ? "missing" : roster.position === "QB" ? "observed-weekly-qb-claim" : "incompatible-position" : null,
        completion: "unqualified", participation: player ? "unqualified" : "not-applicable",
        canonicalBinding: "unqualified" };
    });
  const player = history(request.rawTeam, false, true), team = history(request.rawTeam, false, false), opposingOffenses = history(opponent, true, false);
  const windows = (rows: typeof player) => [4, 8, 16].map(window => ({ window, expectedRawSlots: rows.slice(0, window).length,
    observedRawPairs: rows.slice(0, window).filter(row => row.statistics.state === "observed-raw-claim").length,
    rawGameIds: rows.slice(0, window).map(row => row.rawGameId) }));
  const betweenCutoffAndTarget = games.filter(({ row, kickoff }) => row.game_id !== target.game_id &&
    instant(kickoff) >= cutoff && instant(kickoff) < instant(targetKickoff)).map(({ row }) => row.game_id);
  const report = { version: QB_SLICE_INVENTORY_VERSION, request, candidate: "player-opponent-v1:player_pass_yds",
    featureVersion: "passing-yards-source-v1", historyPolicy: "qb-passing-history-three-season-v1",
    target: { rawGameId: target.game_id, kickoff: targetKickoff, season, seasonType, rawTeam: request.rawTeam, rawOpponent: opponent },
    discoveryBasis: "captured-raw-claims-only", coverage: { fromSeason, throughSeason: season, state: "independently-unqualified",
      knownFormerTeams: "not-qualified", observedScheduleCounts: relevantTeams.map(rawTeam => ({ rawTeam,
        seasons: [fromSeason, fromSeason + 1, season].map(season => ({ season, rawRows: allSchedules.filter(row =>
          Number(row.season) === season && [row.home_team, row.away_team].includes(rawTeam)).length })) })) },
    player, team, opposingOffenses, windows: { player: windows(player), team: windows(team), opponent: windows(opposingOffenses) },
    betweenCutoffAndTarget, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified", modelValidated: false,
    blockers: ["canonical-identity-and-membership-unqualified", "independent-schedule-coverage-unqualified", "completion-source-unqualified",
      "official-reconciliation-use-unqualified", ...(betweenCutoffAndTarget.length ? ["intervening-scheduled-game"] : []),
      ...([...player, ...team, ...opposingOffenses].some(row => !row.sourceSeasonSupported) ? ["prior-season-publication-contract-unsupported"] : [])] };
  return { ...report, inventoryDigest: digest(canonical(report)) };
}
