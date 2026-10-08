import type { Membership, Observation, Schedule } from "./types.ts";
import type { createReplay } from "./replay.ts";
import { compareText, instant } from "./validation.ts";

type Replay = ReturnType<typeof createReplay>;
const inRange = (game: Schedule, target: Schedule) => game.season >= target.season - 2 && game.season <= target.season;
const hasTeam = (game: Schedule, team: string) => game.homeTeamId === team || game.awayTeamId === team;

// Coverage is independently supplied evidence, not a count inferred from the
// rows that happened to survive parsing. A bye never creates a missing week.
export const scheduleContext = (replay: Replay, target: Schedule, member: Membership, enriched: boolean) => {
  const dependencies = new Map<string, Observation>();
  const reasons = new Set<string>();
  const missingGameIds = new Set<string>();
  const rows = new Map<string, Schedule>();
  const selections = replay.keys("schedule").map((key) => replay.select("schedule", key));
  for (const result of selections) if (result.observation) rows.set(result.observation.revision.data.gameId, result.observation.revision.data);
  const teams = new Set([member.teamId]);
  if (enriched) teams.add(target.homeTeamId === member.teamId ? target.awayTeamId : target.homeTeamId);
  const playerGameIds = new Set<string>();
  const retain = (observations: Observation[]) => observations.forEach((row) => dependencies.set(row.revision.id, row));
  for (const key of replay.keys("membership")) {
    const selection = replay.select("membership", key);
    const relevant = selection.dependencies.filter((row) => row.revision.kind === "membership" && row.revision.data.playerId === member.playerId);
    for (const row of relevant) {
      if (row.revision.kind !== "membership" || row.revision.data.gameId === target.gameId) continue;
      const data = row.revision.data;
      const game = rows.get(data.gameId);
      if (game && inRange(game, target) && instant(game.kickoff) < instant(target.kickoff)) {
        if (!teams.has(data.teamId) || selection.state === "ambiguous") {
          retain(relevant); retain(replay.select("schedule", "schedule:" + game.gameId).dependencies);
        }
        teams.add(data.teamId); playerGameIds.add(game.gameId);
      } else if (!game && instant(data.effectiveFrom) < instant(target.kickoff) &&
          instant(data.effectiveTo) > Date.UTC(target.season - 2, 0, 1)) {
        missingGameIds.add(data.gameId); reasons.add("player-schedule-missing"); retain(relevant);
      }
    }
  }
  const games = [...rows.values()].filter((game) => inRange(game, target) &&
    ([...teams].some((team) => hasTeam(game, team)) || playerGameIds.has(game.gameId)));
  for (const result of selections.filter((item) => !item.observation)) {
    if (result.dependencies.some((row) => {
      if (row.revision.kind !== "schedule") return false;
      const game = row.revision.data;
      return inRange(game, target) && [...teams].some((team) => hasTeam(game, team));
    })) {
      reasons.add("prior-schedule-ambiguous"); retain(result.dependencies);
    }
  }
  for (const team of [...teams].sort(compareText)) {
    const key = "schedule-coverage:" + team + ":" + (target.season - 2) + ":" + target.season;
    const selection = replay.select("schedule-coverage", key);
    retain(selection.dependencies);
    const coverage = selection.observation?.revision.data;
    if (!coverage) { reasons.add("schedule-coverage-" + selection.state); continue; }
    if (coverage.state !== "complete") reasons.add("schedule-coverage-incomplete");
    const expected = new Set(coverage.gameIds);
    for (const id of expected) {
      const game = rows.get(id);
      if (!game) { missingGameIds.add(id); reasons.add("schedule-row-missing"); }
      else if (!inRange(game, target) || !hasTeam(game, team)) {
        reasons.add("schedule-coverage-mismatch"); retain(replay.select("schedule", "schedule:" + id).dependencies);
      }
    }
    for (const game of games.filter((game) => hasTeam(game, team) && !expected.has(game.gameId))) {
      reasons.add("schedule-coverage-mismatch"); retain(replay.select("schedule", "schedule:" + game.gameId).dependencies);
    }
  }
  games.sort((a, b) => instant(b.kickoff) - instant(a.kickoff) || compareText(a.gameId, b.gameId));
  return { games, playerGameIds, dependencies: [...dependencies.values()], reasons: [...reasons].sort(),
    coverage: { state: reasons.size ? "unverified" as const : "complete" as const, missingGameIds: [...missingGameIds].sort(compareText) } };
};
