import type { SourceFeed, SourceRow } from "./sourceAdapters.ts";
import { easternKickoff, sourceInteger } from "./sourceAdapters.ts";
import { canonical, digest, refuse } from "./validation.ts";

type Samples = Partial<Record<SourceFeed, SourceRow[]>>;
const knownTeams = new Set("ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAC LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(" "));
const gsis = (value: string) => /^00-\d{7}$/.test(value);
const seasonType = (row: SourceRow) => {
  const type = row.season_type || row.game_type;
  if (row.season_type && row.game_type && row.season_type !== row.game_type) return null;
  return ["REG", "POST"].includes(type) ? type : null;
};
const key = (row: SourceRow, player: boolean) => `${row.game_id}:${row.team}` + (player ? `:${row.player_id}` : "");
const unique = (rows: SourceRow[], identify: (row: SourceRow) => string) => {
  const map = new Map<string, SourceRow>(); const conflicts = new Set<string>();
  for (const row of rows) {
    const id = identify(row); const prior = map.get(id);
    if (prior && canonical(prior) !== canonical(row)) conflicts.add(id);
    else map.set(id, row);
  }
  return { map, conflicts };
};

// A qualification inventory, never an input-bundle adapter. A current stats
// row does not independently confirm completion or population participation.
export const qualifySourceSamples = (samples: Samples, season: number, targetGameId: string) => {
  const schedules = unique((samples.schedule ?? []).filter((row) => Number(row.season) >= season - 2 && Number(row.season) <= season), (row) => row.game_id);
  const target = schedules.map.get(targetGameId);
  if (!target || schedules.conflicts.has(targetGameId) || Number(target.season) !== season || !seasonType(target) ||
      !knownTeams.has(target.home_team) || !knownTeams.has(target.away_team) || target.home_team === target.away_team) refuse("source-target-unresolved");
  const kickoff = easternKickoff(target.gameday, target.gametime);
  const players = unique(samples.player ?? [], (row) => key(row, true));
  const teams = unique(samples.team ?? [], (row) => key(row, false));
  const identifiers = unique(samples.identifiers ?? [], (row) => row.gsis_id);
  const roster = unique(samples.roster ?? [], (row) => `${row.season}:${seasonType(row)}:${row.week}:${row.team}:${row.gsis_id}`);
  const counts = { playerRows: samples.player?.length ?? 0, playerQbRows: 0, playerIdentityUnresolved: 0, playerScheduleUnresolved: 0,
    playerIdentityMissing: 0, playerIdentityAmbiguous: 0,
    playerCountPairs: 0, playerBlankPairs: 0, playerInvalidNumbers: 0, teamRows: samples.team?.length ?? 0, teamScheduleUnresolved: 0,
    qbRosterCandidates: 0, qbRosterIdentityUnresolved: 0, qbRosterScheduleUnresolved: 0, qbRosterWithStats: 0,
    qbRosterIdentityMissing: 0, qbRosterIdentityAmbiguous: 0, qbRosterAmbiguous: 0, qbRosterStatsUnresolved: 0,
    qbRosterWithoutStats: 0, offensiveParticipationConfirmed: 0, offensiveParticipationAbsent: 0, offensiveParticipationUnresolved: 0,
    scheduleConflicts: schedules.conflicts.size, playerConflicts: players.conflicts.size, teamConflicts: teams.conflicts.size,
    rosterConflicts: roster.conflicts.size, identifierConflicts: identifiers.conflicts.size, statsTeamSumMismatches: 0 };
  const validSchedule = (row: SourceRow) => {
    const schedule = schedules.map.get(row.game_id);
    return schedule && !schedules.conflicts.has(row.game_id) && seasonType(row) === seasonType(schedule) &&
      row.season === schedule.season && row.week === schedule.week && knownTeams.has(row.team) &&
      [schedule.home_team, schedule.away_team].includes(row.team) &&
      row.opponent_team === (row.team === schedule.home_team ? schedule.away_team : schedule.home_team);
  };
  const sums = new Map<string, { attempts: number; yards: number }>();
  for (const row of players.map.values()) {
    if (Number(row.season) !== season || !seasonType(row)) { counts.playerScheduleUnresolved++; continue; }
    if (row.position === "QB") counts.playerQbRows++;
    if (!gsis(row.player_id) || !identifiers.map.has(row.player_id)) { counts.playerIdentityMissing++; counts.playerIdentityUnresolved++; }
    else if (identifiers.conflicts.has(row.player_id)) { counts.playerIdentityAmbiguous++; counts.playerIdentityUnresolved++; }
    const resolvedSchedule = validSchedule(row) && !players.conflicts.has(key(row, true));
    if (!resolvedSchedule) counts.playerScheduleUnresolved++;
    try {
      const attempts = sourceInteger(row.attempts, 0, 1000); const yards = sourceInteger(row.passing_yards, -10000, 10000);
      if (attempts === null || yards === null) counts.playerBlankPairs++;
      else {
        counts.playerCountPairs++;
        if (resolvedSchedule) {
          const id = key(row, false); const sum = sums.get(id) ?? { attempts: 0, yards: 0 };
          sum.attempts += attempts; sum.yards += yards; sums.set(id, sum);
        }
      }
    } catch { counts.playerInvalidNumbers++; }
  }
  for (const row of teams.map.values()) {
    const resolvedSchedule = Number(row.season) === season && validSchedule(row) && !teams.conflicts.has(key(row, false));
    if (!resolvedSchedule) counts.teamScheduleUnresolved++;
    try {
      const sum = sums.get(key(row, false));
      if (!resolvedSchedule || !sum || sum.attempts !== sourceInteger(row.attempts, 0, 1000) || sum.yards !== sourceInteger(row.passing_yards, -10000, 10000)) counts.statsTeamSumMismatches++;
    } catch { counts.statsTeamSumMismatches++; }
  }
  const scheduleByTeamWeek = new Map<string, SourceRow[]>();
  for (const row of schedules.map.values()) for (const team of [row.home_team, row.away_team]) {
    const id = `${row.season}:${seasonType(row)}:${row.week}:${team}`;
    scheduleByTeamWeek.set(id, [...(scheduleByTeamWeek.get(id) ?? []), row]);
  }
  for (const row of roster.map.values()) {
    if (row.position !== "QB" || Number(row.season) !== season || !seasonType(row)) continue;
    // Enumeration includes ACT, reserve and other statuses. None are a game-day
    // active list; missing numeric rows cannot be converted into absent/zero.
    counts.qbRosterCandidates++;
    const identityMissing = !gsis(row.gsis_id) || !identifiers.map.has(row.gsis_id);
    const identityAmbiguous = !identityMissing && identifiers.conflicts.has(row.gsis_id);
    if (identityMissing) { counts.qbRosterIdentityMissing++; counts.qbRosterIdentityUnresolved++; }
    if (identityAmbiguous) { counts.qbRosterIdentityAmbiguous++; counts.qbRosterIdentityUnresolved++; }
    const ambiguous = roster.conflicts.has(`${row.season}:${seasonType(row)}:${row.week}:${row.team}:${row.gsis_id}`);
    if (ambiguous) counts.qbRosterAmbiguous++;
    const games = scheduleByTeamWeek.get(`${row.season}:${seasonType(row)}:${row.week}:${row.team}`) ?? [];
    if (games.length !== 1 || !knownTeams.has(row.team) || games.some((game) => schedules.conflicts.has(game.game_id))) {
      counts.qbRosterScheduleUnresolved++; counts.offensiveParticipationUnresolved++; counts.qbRosterStatsUnresolved++; continue;
    }
    const match = `${games[0].game_id}:${row.team}:${row.gsis_id}`;
    if (ambiguous || identityMissing || identityAmbiguous || players.conflicts.has(match) ||
        (players.map.has(match) && !validSchedule(players.map.get(match)!))) counts.qbRosterStatsUnresolved++;
    else if (players.map.has(match)) counts.qbRosterWithStats++;
    else counts.qbRosterWithoutStats++;
    counts.offensiveParticipationUnresolved++;
  }
  const scope = [target.home_team, target.away_team].map((team) => ({ rawTeam: team,
    gamesBySeason: [season - 2, season - 1, season].map((year) => ({ season: year,
      games: [...schedules.map.values()].filter((row) => Number(row.season) === year && [row.home_team, row.away_team].includes(team) && seasonType(row)).length })) }));
  return { target: { rawGameId: targetGameId, rawHomeTeam: target.home_team, rawAwayTeam: target.away_team, kickoff },
    counts, scope, selectedProjectionDigest: digest(canonical(samples)), featureStatus: "unavailable-inputs" as const,
    reasons: ["completion-source-unqualified", "offensive-participation-unqualified", "independent-schedule-enumeration-unqualified",
      "canonical-event-bridge-unqualified", "weekly-membership-effective-bounds-unqualified", "injury-report-cycle-unqualified",
      samples.depth ? "depth-effective-context-unqualified" : "depth-capture-incomplete", "prior-season-source-samples-missing"],
    sampledStatsSeasons: [season], requiredCandidateHistorySeasons: [season - 2, season - 1, season],
    historicalCutoffCoverage: "unverified", modelValidated: false, populationCoverage: "unqualified",
    notes: ["Player/team sum parity checks provider consistency, not independent official reconciliation.",
      "Weekly roster membership/status does not establish participation or exact effective timestamp bounds.",
      "Schedule row counts describe one mutable source, not independent complete enumeration evidence.",
      "LA is a retained raw source alias; a qualified canonical bridge must resolve it explicitly."] };
};
