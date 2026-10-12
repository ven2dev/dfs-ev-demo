import { createReplay, replayObservations, type BridgeResolution, type Replay } from "./replay.ts";
import { SOURCE_CLAIM_VERSION, type SourceStatsReplay } from "./sourceClaims.ts";
import { SOURCE_PROFILE_VERSION } from "./sourceAdapters.ts";
import { SOURCE_STATS_VERSION } from "./sourceStats.ts";
import type { Dataset, IdentityLink, Observation, PlayerGameStats, TeamGameStats } from "./types.ts";
import { allows, canonical, compareText, digest, instant, refuse, rightsInForce, validateRevision } from "./validation.ts";

export const SOURCE_NORMALIZATION_VERSION = "nflverse-stats-normalization-plan-v1";
type Role = "game-bridge" | "team-alias" | "opponent-alias" | "player-bridge" | "schedule";
type Binding = {
  role: Role; observationId: string; profileId: string; sourceKey: string;
  captureId: string; artifactId: string; artifactSha256: string; availableAt: string; ingestedAt: string;
};
type Candidate = { kind: "player-game-stats"; data: PlayerGameStats } | { kind: "team-game-stats"; data: TeamGameStats };
type Context = Pick<Dataset, "profiles" | "rightsDecisions" | "identityLinks"> & { replay: Replay };

// This plans normalization from a verified raw replay; it cannot publish a
// revision or infer its predecessor. The recorder independently revalidates
// its binding before storing a research revision. No IDs/windows are minted.
export const planSourceStatsFromReplay = (source: SourceStatsReplay, context: Context, accessAt: string) => {
  const { request, captures, rows } = source.evidence;
  const cutoff = instant(request.cutoff); const now = instant(accessAt);
  if (cutoff > now || source.evidence.version !== SOURCE_CLAIM_VERSION || source.inputDigest !== digest(canonical(source.evidence)))
    refuse("source-normalization-evidence-refused");
  const dependencies = new Map<string, Binding>();
  let links: IdentityLink[] = [];
  let rightsDecisionIds: string[] = [];
  let decisions: ReturnType<Replay["usedDecisions"]> = [];
  const bind = (role: Role, observations: Observation[]) => {
    for (const row of observations) {
      if (instant(row.capture.availableAt) > cutoff || instant(row.capture.ingestedAt) > cutoff)
        refuse("source-normalization-context-time-refused");
      dependencies.set(role + ":" + row.revision.id, {
        role, observationId: row.revision.id, profileId: row.artifact.profileId, sourceKey: row.sourceKey,
        captureId: row.capture.id, artifactId: row.artifact.id, artifactSha256: row.artifact.sha256,
        availableAt: row.capture.availableAt, ingestedAt: row.capture.ingestedAt,
      });
    }
  };
  const result = (reason: string | null, candidate: Candidate | null = null) => {
    const binding = { version: SOURCE_NORMALIZATION_VERSION, cutoff: request.cutoff, sourceRequest: { ...request }, sourceInputDigest: source.inputDigest,
      sourceProfileId: request.profileId, rawSourceKey: rows[0]?.rawKeySha256 ?? null,
      sourceCaptures: captures, sourceRows: rows.map(({ id, rowOrdinal, selectedSha256 }) => ({ id, rowOrdinal, selectedSha256 }))
        .sort((a, b) => a.rowOrdinal - b.rowOrdinal),
      parserVersion: SOURCE_PROFILE_VERSION, projectionVersion: SOURCE_STATS_VERSION,
      dependencies: [...dependencies.values()].sort((a, b) => compareText(a.role, b.role) || compareText(a.observationId, b.observationId)),
      identityLinks: links, decisions, rightsDecisionIds };
    const dataDigest = candidate ? digest(canonical(candidate)) : null;
    return { status: reason ? "unavailable-source-normalization" as const : "planned-source-normalization" as const,
      reason, candidate, dataDigest, binding, planDigest: digest(canonical({ reason, candidate, binding })),
      observationsPublished: false, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" as const };
  };
  if (source.status !== "observed-source-claim") return result(source.reason ?? "source-claim-unavailable");
  const capture = captures[0]; const stats = rows[0]?.projection;
  if (source.reason !== null || captures.length !== 1 || !stats || !rows.length ||
      instant(capture.capturedAt) > instant(capture.availableAt) || instant(capture.availableAt) > instant(capture.ingestedAt) ||
      instant(capture.ingestedAt) > cutoff || rows.some((row) => row.failureCode !== null ||
        row.id !== "source-row:" + digest(canonical([capture.id, row.rowOrdinal])) || row.rowOrdinal < 1 || row.rowOrdinal > capture.parsedRows ||
        canonical(row.projection) !== canonical(stats) || row.selectedSha256 !== rows[0].selectedSha256) ||
      stats.version !== SOURCE_STATS_VERSION || stats.rawGameId !== request.rawGameId || stats.rawTeam !== request.rawTeam ||
      stats.rawPlayerId !== request.rawPlayerId) refuse("source-normalization-evidence-refused");
  const expectedKey = digest(canonical([stats.rawGameId, stats.rawTeam, ...(stats.feed === "player" ? [stats.rawPlayerId] : [])]));
  if (rows.some((row) => row.rawKeySha256 !== expectedKey)) refuse("source-normalization-evidence-refused");
  const profile = context.profiles.find((item) => item.id === request.profileId);
  if (!profile || profile.provider !== "nflverse" || profile.feed !== stats.feed || profile.parserVersion !== SOURCE_PROFILE_VERSION)
    refuse("source-normalization-profile-refused");
  if (!allows(rightsInForce(context.rightsDecisions, profile.id, now, now), "internal-research")) return result("rights-not-in-force");
  const replay = context.replay;
  const resolve = (role: Role, value: BridgeResolution) => {
    bind(role, value.dependencies);
    return value.state === "resolved" ? null : role + (value.state === "missing" ? "-missing" : "-conflict");
  };
  const game = replay.resolveGame(profile.provider, stats.rawGameId);
  let reason = resolve("game-bridge", game); if (reason || game.state !== "resolved") return result(reason);
  const gameRivals = replay.keys("game-bridge").flatMap((key) => replay.heads(key)).filter((row) =>
    row.revision.kind === "game-bridge" && row.revision.data.provider === profile.provider &&
    row.revision.data.gameId === game.value && row.revision.data.rawGameId !== stats.rawGameId);
  if (gameRivals.length) { bind("game-bridge", gameRivals); return result("game-bridge-conflict"); }
  const team = replay.resolveTeam(profile.provider, stats.rawTeam, stats.season);
  reason = resolve("team-alias", team); if (reason || team.state !== "resolved") return result(reason);
  const opponent = replay.resolveTeam(profile.provider, stats.rawOpponent, stats.season);
  reason = resolve("opponent-alias", opponent); if (reason || opponent.state !== "resolved") return result(reason);
  const schedule = replay.select("schedule", "schedule:" + game.value);
  bind("schedule", schedule.dependencies); decisions = replay.usedDecisions();
  if (decisions.some((decision) => instant(decision.decidedAt) > cutoff)) refuse("source-normalization-context-time-refused");
  if (schedule.state !== "selected") return result("normalization-schedule-" + schedule.state);
  const scheduled = schedule.observation.revision.data;
  const parts = stats.rawGameId.split("_");
  const away = stats.rawTeam === parts[2] ? team.value : opponent.value;
  const home = stats.rawTeam === parts[3] ? team.value : opponent.value;
  if (scheduled.season !== stats.season || scheduled.seasonType !== stats.seasonType || scheduled.week !== stats.week ||
      home === away || scheduled.homeTeamId !== home || scheduled.awayTeamId !== away) return result("source-schedule-context-conflict");
  const common: TeamGameStats = { gameId: game.value, rawGameId: stats.rawGameId, teamId: team.value, rawTeam: stats.rawTeam,
    season: stats.season, seasonType: stats.seasonType, ...stats.values, missing: { ...stats.missing } };
  let candidate: Candidate = { kind: "team-game-stats", data: common };
  if (stats.feed === "player") {
    if (!stats.rawPlayerId || stats.playerIdProvider !== "gsis") refuse("source-normalization-evidence-refused");
    const player = replay.resolvePlayer(stats.playerIdProvider, stats.rawPlayerId, scheduled.kickoff);
    reason = resolve("player-bridge", player); if (reason || player.state !== "resolved") return result(reason);
    const playerRivals = replay.keys("player-bridge").flatMap((key) => replay.heads(key)).filter((row) =>
      row.revision.kind === "player-bridge" && row.revision.data.provider === stats.playerIdProvider &&
      row.revision.data.playerId === player.value && row.revision.data.rawPlayerId !== stats.rawPlayerId &&
      instant(row.revision.data.effectiveFrom) <= instant(scheduled.kickoff) && instant(scheduled.kickoff) < instant(row.revision.data.effectiveTo));
    if (playerRivals.length) { bind("player-bridge", playerRivals); return result("player-bridge-conflict"); }
    const applicable = player.dependencies.filter((row) => row.revision.kind === "player-bridge" &&
      row.revision.data.playerId === player.value && instant(row.revision.data.effectiveFrom) <= instant(scheduled.kickoff) &&
      instant(scheduled.kickoff) < instant(row.revision.data.effectiveTo));
    links = context.identityLinks.filter((link) => link.statsProfileId === profile.id && link.provider === stats.playerIdProvider &&
      instant(link.decidedAt) <= cutoff && applicable.some((row) => row.artifact.profileId === link.bridgeProfileId))
      .sort((a, b) => compareText(a.id, b.id));
    if (!links.length) return result("player-bridge-link-missing");
    candidate = { kind: "player-game-stats", data: { ...common, playerId: player.value,
      rawPlayerId: stats.rawPlayerId, playerIdProvider: stats.playerIdProvider } };
  }
  // Reuse the released payload contract; this does not create a source chain.
  validateRevision({ id: "normalization-plan", sourceRecordId: expectedKey, predecessorId: null, correctionReason: null, ...candidate });
  rightsDecisionIds = [...new Set([profile.id, ...[...dependencies.values()].map((row) => row.profileId)])].map((id) => {
    const decision = rightsInForce(context.rightsDecisions, id, now, now);
    if (!allows(decision, "internal-research")) refuse("source-normalization-rights-refused");
    return decision!.id;
  }).sort(compareText);
  return result(null, candidate);
};

export const planSourceStatsNormalization = (source: SourceStatsReplay, context: Dataset, accessAt: string) =>
  planSourceStatsFromReplay(source, { ...context, replay: source.status === "observed-source-claim"
    ? createReplay(context, source.evidence.request.cutoff, accessAt, "internal-research")
    : replayObservations([], new Set()) }, accessAt);

export type SourceNormalizationPlan = ReturnType<typeof planSourceStatsFromReplay>;
