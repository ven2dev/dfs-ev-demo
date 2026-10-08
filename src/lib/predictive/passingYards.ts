import type { Bundle, Dataset, Dependency, Exclusion, Kind, Observation,
  Passing, PassingGame, Request, Schedule, Summary } from "./types.ts";
import { createReplay } from "./replay.ts";
import { applicableQuarterback } from "./identity.ts";
import { canonical, compareText, digest, exact, gameIdentity, instant, playerIdentity, refuse } from "./validation.ts";

const WINDOWS = [4, 8, 16] as const;
const key = (kind: Kind, game: string, entity?: string) => kind + ":" + game + (entity ? ":" + entity : "");
type Slot = { schedule: Schedule; game: PassingGame | null; reason: string | null };

function summarize(slots: Slot[], window: number): Summary {
  const selected = slots.slice(0, window);
  const games = selected.flatMap((slot) => slot.game ? [slot.game] : []);
  const exclusions = selected.flatMap((slot) => slot.reason ? [{ gameId: slot.schedule.gameId, reason: slot.reason }] : []);
  const attemptsSum = games.reduce((sum, game) => sum + game.attempts, 0);
  const passingYardsSum = games.reduce((sum, game) => sum + game.passingYards, 0);
  return { window, expectedGames: selected.length, observedGames: games.length, excludedGames: exclusions.length,
    unknownGames: exclusions.filter((item) => item.reason !== "participation-absent").length,
    gameIds: selected.map((slot) => slot.schedule.gameId), dateRange: selected.length ?
      [selected.at(-1)!.schedule.kickoff, selected[0].schedule.kickoff] : null,
    games, exclusions, attemptsSum, passingYardsSum, attemptsPerGame: games.length ? attemptsSum / games.length : null,
    passingYardsPerAttempt: attemptsSum > 0 ? passingYardsSum / attemptsSum : null };
}

export function bundleInputDigest(bundle: Omit<Bundle, "inputDigest"> | Bundle) {
  // Computation may happen later without changing the historical input bundle.
  // All cutoff, source, feature, identity and selected-value facts remain bound.
  const { computedAt: ignoredTime, inputDigest: ignoredDigest, ...facts } = bundle as Bundle;
  void ignoredTime; void ignoredDigest;
  return digest(canonical(facts));
}

export function buildPassingYardsBundle(dataset: Dataset, request: Request): Bundle {
  exact(request, ["playerId", "gameId", "cutoff", "computedAt", "candidate"]);
  playerIdentity(request.playerId); gameIdentity(request.gameId);
  const cutoff = instant(request.cutoff);
  if (instant(request.computedAt) < cutoff) refuse("computation-before-cutoff");
  if (!["stats-v1:player_pass_yds", "player-opponent-v1:player_pass_yds"].includes(request.candidate)) refuse("unsupported-candidate");
  const replay = createReplay(dataset, request.cutoff);
  const dependencyRows = new Map<string, Observation>();
  const reasons = new Set<string>();
  const quality = new Set<string>(["synthetic-evidence-only", "injury-unverified", "depth-unverified", "population-unqualified", "model-unvalidated"]);
  const excludedSchedule: Exclusion[] = [];
  const enrich = request.candidate === "player-opponent-v1:player_pass_yds";
  function select<K extends Kind>(kind: K, game: string, entity?: string) {
    const result = replay.select(kind, key(kind, game, entity));
    for (const row of result.dependencies) dependencyRows.set(row.revision.id, row);
    return result;
  }
  const targetResult = select("schedule", request.gameId);
  const target = targetResult.observation?.revision.data ?? null;
  if (!target) reasons.add("target-schedule-" + targetResult.state);
  if (target && instant(target.kickoff) <= cutoff) reasons.add("target-not-pregame");
  const targetCompletion = select("completion", request.gameId);
  if (targetCompletion.state === "ambiguous" || targetCompletion.observation?.revision.data.state === "confirmed") reasons.add("target-started-or-completed");
  const targetMember = select("membership", request.gameId, request.playerId);
  const member = targetMember.observation?.revision.data ?? null;
  if (!member) reasons.add("target-membership-" + targetMember.state);
  if (target && member && !applicableQuarterback(member, target)) reasons.add("target-membership-inapplicable");
  const teamId = member?.teamId ?? null;
  const opponentId = target && teamId && [target.homeTeamId, target.awayTeamId].includes(teamId) ?
    (target.homeTeamId === teamId ? target.awayTeamId : target.homeTeamId) : null;
  const availability = select("availability", request.gameId, request.playerId);
  const status = availability.observation?.revision.data;
  if (availability.state === "ambiguous") reasons.add("availability-ambiguous");
  if (status?.injury === "excluded") reasons.add("player-excluded");
  if (status?.injury === "eligible") quality.delete("injury-unverified");
  if (status?.depth === "observed") quality.delete("depth-unverified");
  const base: Omit<Bundle, "inputDigest"> = {
    formatVersion: 1, featureVersion: "passing-yards-replay-v1", readMode: "application-data-replay",
    usage: "synthetic-internal-research", modelValidated: false, populationCoverage: "unqualified",
    units: { attempts: "attempts", passingYards: "yards", attemptsPerGame: "attempts/game",
      passingYardsPerAttempt: "yards/attempt", scheduledRestHours: "hours" },
    request: { playerId: request.playerId, gameId: request.gameId, cutoff: request.cutoff, candidate: request.candidate },
    computedAt: request.computedAt, status: "unavailable-inputs", reasons: [], quality: [],
    target, teamId, opponentId, availability: { injury: status?.injury ?? "unknown", depth: status?.depth ?? "unknown", participation: "future-unknown" },
    player: [], team: enrich ? [] : null, opponent: enrich ? [] : null, scheduledRestHours: null,
    dependencyAvailableAt: null, dependencies: [], excludedSchedule,
  };
  if (target && member && !reasons.size) {
    const games: Schedule[] = [];
    for (const scheduleKey of replay.keys("schedule")) {
      const result = replay.select("schedule", scheduleKey);
      for (const row of result.dependencies) dependencyRows.set(row.revision.id, row);
      if (!result.observation) { reasons.add("prior-schedule-ambiguous"); continue; }
      const game = result.observation.revision.data;
      if (game.gameId === target.gameId) { excludedSchedule.push({ gameId: game.gameId, reason: "target-game" }); continue; }
      if (game.seasonType !== target.seasonType) { excludedSchedule.push({ gameId: game.gameId, reason: "season-type" }); continue; }
      if (game.season < target.season - 2 || game.season > target.season) { excludedSchedule.push({ gameId: game.gameId, reason: "season-range" }); continue; }
      if (instant(game.kickoff) >= cutoff) { excludedSchedule.push({ gameId: game.gameId, reason: "not-prior-game" }); continue; }
      games.push(game);
    }
    // Tied game time is explicitly ambiguous rather than ordered by UUID.
    games.sort((a, b) => instant(b.kickoff) - instant(a.kickoff) || compareText(a.gameId, b.gameId));
    const playerSlots: Slot[] = [], teamSlots: Slot[] = [], opponentSlots: Slot[] = [];
    function scheduleDependency(game: Schedule) { select("schedule", game.gameId); }
    function completed(game: Schedule): string | null {
      const completion = select("completion", game.gameId);
      if (!completion.observation) return "completion-" + completion.state;
      if (completion.observation.revision.data.state !== "confirmed") return "completion-unresolved";
      const data = completion.observation.revision.data;
      // This proof has no separately qualified earlier observation archive.
      // A conservative observed bound is the confirming capture itself.
      if (data.boundKind === "completion-observed-at" && data.bound !== completion.observation.capture.capturedAt) return "completion-bound-unverified";
      if (instant(data.bound!) <= instant(game.kickoff) || instant(data.bound!) >= cutoff ||
          instant(data.bound!) > instant(completion.observation.capture.capturedAt)) return "completion-not-before-cutoff";
      return null;
    }
    function values(game: Schedule, stats: Passing, expectedTeam: string): string | null {
      if (stats.rawGameId !== game.rawGameId || stats.teamId !== expectedTeam || stats.season !== game.season || stats.seasonType !== game.seasonType ||
          stats.rawTeam !== (expectedTeam === game.homeTeamId ? game.rawHomeTeam : game.rawAwayTeam)) return "stat-identity-mismatch";
      if (stats.attempts === null || stats.passingYards === null) return stats.missingReason;
      return null;
    }
    function passingGame(game: Schedule, stats: Passing): PassingGame {
      return { gameId: game.gameId, season: game.season, seasonType: game.seasonType, kickoff: game.kickoff,
        teamId: stats.teamId, attempts: stats.attempts!, passingYards: stats.passingYards! };
    }
    const playerGames = games.filter((game) => {
      const membership = replay.select("membership", key("membership", game.gameId, request.playerId));
      return membership.state !== "missing" || [game.homeTeamId, game.awayTeamId].includes(teamId!);
    }).slice(0, 16);
    for (const game of playerGames) {
      scheduleDependency(game);
      const membership = select("membership", game.gameId, request.playerId);
      const participation = select("participation", game.gameId, request.playerId);
      const stats = select("player-passing", game.gameId, request.playerId);
      const dated = membership.observation?.revision.data;
      let reason = !dated ? "membership-" + membership.state : !applicableQuarterback(dated, game) ? "membership-inapplicable" : completed(game);
      if (!reason && participation.observation?.revision.data.state !== "confirmed") reason = "participation-" + (participation.observation?.revision.data.state ?? participation.state);
      if (!reason) reason = stats.observation ? values(game, stats.observation.revision.data, dated!.teamId) : "player-stats-" + stats.state;
      if (!reason && stats.observation && enrich) {
        const own = select("team-passing", game.gameId, dated!.teamId);
        if (!own.observation || values(game, own.observation.revision.data, dated!.teamId)) reason = "paired-team-stats-unavailable";
        else if (own.observation && stats.observation.revision.data.attempts! > own.observation.revision.data.attempts!) reason = "player-team-count-conflict";
      }
      if (dated && dated.teamId !== teamId) quality.add("player-team-change");
      playerSlots.push({ schedule: game, game: reason || !stats.observation ? null : passingGame(game, stats.observation.revision.data), reason });
    }
    function teamHistory(team: string, against: boolean): Slot[] {
      const selected = games.filter((game) => [game.homeTeamId, game.awayTeamId].includes(team)).slice(0, 16);
      return selected.map((game) => {
        scheduleDependency(game);
        const offense = against ? (game.homeTeamId === team ? game.awayTeamId : game.homeTeamId) : team;
        const stats = select("team-passing", game.gameId, offense);
        const reason = completed(game) ?? (stats.observation ? values(game, stats.observation.revision.data, offense) : "team-stats-" + stats.state);
        return { schedule: game, game: reason || !stats.observation ? null : passingGame(game, stats.observation.revision.data), reason };
      });
    }
    // Scheduled rest belongs to the target team, including after a player trade.
    const previousTeamGame = games.find((game) => [game.homeTeamId, game.awayTeamId].includes(teamId!));
    if (enrich && previousTeamGame) {
      scheduleDependency(previousTeamGame);
      if (!completed(previousTeamGame)) base.scheduledRestHours = (instant(target.kickoff) - instant(previousTeamGame.kickoff)) / 3_600_000;
    }
    if (enrich && base.scheduledRestHours === null) quality.add("scheduled-rest-unavailable");
    if (enrich) {
      teamSlots.push(...teamHistory(teamId!, false));
      opponentSlots.push(...teamHistory(opponentId!, true));
    }
    base.player = WINDOWS.map((window) => summarize(playerSlots, window));
    if (enrich) {
      base.team = WINDOWS.map((window) => summarize(teamSlots, window));
      base.opponent = WINDOWS.map((window) => summarize(opponentSlots, window));
    }
    const groups = [["player", base.player], ...(enrich ? [["team", base.team!], ["opponent", base.opponent!]] : [])] as [string, Summary[]][];
    for (const [name, summaries] of groups) {
      if (summaries[0].expectedGames === 0) reasons.add(name + "-history-missing");
      if (summaries.some((summary) => summary.excludedGames > 0)) reasons.add(name + "-history-incomplete");
      if (summaries.some((summary) => summary.passingYardsPerAttempt === null)) reasons.add(name + "-zero-or-missing-denominator");
      if (summaries.some((summary) => summary.expectedGames < summary.window)) quality.add(name + "-short-history");
      for (let i = 1; i < summaries.at(-1)!.games.length; i++) {
        if (summaries.at(-1)!.games[i].kickoff === summaries.at(-1)!.games[i - 1].kickoff) reasons.add(name + "-game-order-ambiguous");
      }
    }
  }
  const dependencies: Dependency[] = [...dependencyRows.values()].map(({ revision, capture, artifact }) => ({
    observationId: revision.id, predecessorId: revision.predecessorId, correctionReason: revision.correctionReason,
    kind: revision.kind, captureId: capture.id, artifactId: artifact.id, artifactSha256: artifact.sha256,
    source: artifact.source, origin: artifact.origin, schemaVersion: artifact.schemaVersion,
    parserVersion: artifact.parserVersion, rightsReviewVersion: artifact.rightsReviewVersion,
    publishedAt: capture.publishedAt, publicationEvidence: capture.publicationEvidence, capturedAt: capture.capturedAt,
    availableAt: capture.availableAt, ingestedAt: capture.ingestedAt,
    mappingVersion: "mappingVersion" in revision.data ? revision.data.mappingVersion : null,
  })).sort((a, b) => compareText(a.observationId, b.observationId));
  base.dependencies = dependencies;
  base.dependencyAvailableAt = dependencies.length ? new Date(Math.max(...dependencies.map((row) => instant(row.availableAt)))).toISOString() : null;
  base.reasons = [...reasons].sort(); base.quality = [...quality].sort();
  base.excludedSchedule.sort((a, b) => compareText(a.gameId, b.gameId));
  base.status = reasons.size ? "unavailable-inputs" : "ready-inputs";
  return { ...base, inputDigest: bundleInputDigest(base) };
}
