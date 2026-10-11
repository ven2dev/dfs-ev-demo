import type { Decision, Observation, Profile, SnapCompatibilityRecord } from "./types.ts";
import { canonical, compareText, instant, refuse } from "./validation.ts";

// snap-compatibility-v1, mirrored by predictive_decision_current() and
// predictive_decision_check() in migration 0003. Two snap providers may be mixed
// in one window only after a recorded decision over their complete overlap: every
// snap head (player and team, absences included) of both profiles in each game
// that both profiles cover with a team snap head at decidedAt. The overlap is not
// chosen by the caller, so disagreeing games cannot be left out.
const SNAP_FACTS = ["player-game-snaps", "team-game-snaps"];
const factOf = (row: Observation) => row.entityKey.split(":")[0];
const gameOf = (row: Observation) => row.entityKey.split(":")[1];

export const snapCompatibilityKey = (profileA: string, profileB: string) =>
  "snap-source-compatibility:" + [profileA, profileB].sort(compareText).join(":");

export const snapOverlapHeadsAt = (observations: Iterable<Observation>, profiles: readonly [string, string], t: number) => {
  const visible = [...observations].filter((row) => SNAP_FACTS.includes(factOf(row)) && profiles.includes(row.artifact.profileId) &&
    instant(row.capture.availableAt) <= t && instant(row.capture.ingestedAt) <= t);
  const superseded = new Set(visible.map((row) => row.revision.predecessorId));
  const heads = visible.filter((row) => !superseded.has(row.revision.id));
  const covered = (profile: string) => new Set(heads.filter((row) => row.revision.kind === "team-game-snaps" && row.artifact.profileId === profile).map(gameOf));
  const [a, b] = profiles.map(covered);
  return heads.filter((row) => a.has(gameOf(row)) && b.has(gameOf(row)));
};

// Compatible only when every overlapping fact has exactly one head from each
// profile, both present, with equal offensive snaps and, for teams, the same
// play-counting definition.
export const snapCompatibilityFromHeads = (heads: Observation[], profiles: readonly [string, string]): SnapCompatibilityRecord["outcome"] => {
  const overlapGames = new Set(heads.map(gameOf)).size;
  if (!overlapGames) return { result: "insufficient-overlap", overlapGames };
  const byFact = new Map<string, Observation[]>();
  for (const row of heads) byFact.set(row.entityKey, [...(byFact.get(row.entityKey) ?? []), row]);
  const agrees = (rows: Observation[]) => {
    const values = rows.map((row) => row.revision.kind === "player-game-snaps" || row.revision.kind === "team-game-snaps" ? row.revision.data : null);
    if (profiles.some((profile) => rows.filter((row) => row.artifact.profileId === profile).length !== 1)) return false;
    if (values.some((data) => data === null || data.offenseSnaps === null) || values[0]!.offenseSnaps !== values[1]!.offenseSnaps) return false;
    const definitions = values.map((data) => data && "playCountingDefinition" in data ? data.playCountingDefinition : null);
    return definitions[0] === definitions[1];
  };
  return { result: [...byFact.values()].every(agrees) ? "compatible" : "incompatible", overlapGames };
};

const profilesOf = (decision: SnapCompatibilityRecord) => decision.entityKey.split(":").slice(1) as [string, string];
const ids = (rows: Observation[]) => rows.map((row) => row.revision.id).sort(compareText).join("\n");

export const validateSnapCompatibilityDecisions = (decisions: Decision[], observations: Map<string, Observation>, profiles: Map<string, Profile>) => {
  for (const decision of decisions) {
    if (decision.kind !== "snap-source-compatibility") continue;
    const pair = profilesOf(decision);
    const inputs = decision.inputs.map((input) => observations.get(input.observationId) ?? refuse("decision-input-missing"));
    const heads = snapOverlapHeadsAt(observations.values(), pair, instant(decision.decidedAt));
    if (ids(inputs) !== ids(heads)) refuse("snap-compatibility-inputs-not-heads");
    if (canonical(snapCompatibilityFromHeads(heads, pair)) !== canonical(decision.outcome)) refuse("decision-rule-mismatch");
    const synthetic = heads.some((row) => profiles.get(row.artifact.profileId)?.purpose === "synthetic-test");
    if (heads.length && synthetic !== (decision.mode === "synthetic-proof")) refuse("decision-mode-mismatch");
  }
};

export const recordSnapCompatibility = (id: string, profileA: string, profileB: string, observations: Iterable<Observation>, decidedAt: string,
  mode: SnapCompatibilityRecord["mode"], predecessorId: string | null = null): SnapCompatibilityRecord => {
  const pair = [profileA, profileB].sort(compareText) as [string, string];
  const heads = snapOverlapHeadsAt(observations, pair, instant(decidedAt));
  return { id, kind: "snap-source-compatibility", entityKey: snapCompatibilityKey(profileA, profileB), policyId: "snap-compatibility-v1", mode,
    decidedAt, predecessorId, outcome: snapCompatibilityFromHeads(heads, pair),
    inputs: [...heads].sort((a, b) => compareText(a.revision.id, b.revision.id)).map((row) => ({ observationId: row.revision.id, role: "evidence" })) };
};

// Two snap profiles are interchangeable at t when they are the same profile or
// the latest decision for the pair that is still current at t says compatible.
export const snapProfilesCompatible = (decisions: Decision[], observations: Iterable<Observation>, profileA: string, profileB: string, t: number) => {
  if (profileA === profileB) return true;
  const key = snapCompatibilityKey(profileA, profileB); const pair = profilesOf({ entityKey: key } as SnapCompatibilityRecord);
  const heads = ids(snapOverlapHeadsAt(observations, pair, t));
  const current = decisions.filter((decision): decision is SnapCompatibilityRecord => decision.kind === "snap-source-compatibility" &&
    decision.entityKey === key && instant(decision.decidedAt) <= t && decision.inputs.map((input) => input.observationId).sort(compareText).join("\n") === heads)
    .sort((a, b) => instant(b.decidedAt) - instant(a.decidedAt) || compareText(b.id, a.id));
  return current[0]?.outcome.result === "compatible";
};

export type SnapShareReason = "snap-pair-missing" | "snap-value-missing" | "snap-pair-invalid" | "snap-source-incompatible" | "snap-denominator-zero";
export type SnapShare = { value: number | null; playerSnaps: number; teamSnaps: number; games: number; reason: SnapShareReason | null };

// prior_snap_share (#49 amendment): pooled player offensive snaps over paired team
// offensive snaps across the same eligible games. Each game needs both rows, both
// present, for the same game and team, with the player's count within the team's.
// Every provider in the window must be the same or recorded compatible. Any gap
// leaves the ratio undefined; a zero denominator is undefined, never zero.
export const snapShare = (games: { player: Observation | null; team: Observation | null }[],
  compatible: (profileA: string, profileB: string) => boolean): SnapShare => {
  const result = (reason: SnapShareReason | null, playerSnaps = 0, teamSnaps = 0): SnapShare =>
    ({ value: reason === null ? playerSnaps / teamSnaps : null, playerSnaps, teamSnaps, games: games.length, reason });
  let playerSnaps = 0; let teamSnaps = 0;
  for (const { player, team } of games) {
    if (!player || !team) return result("snap-pair-missing");
    if (player.revision.kind !== "player-game-snaps" || team.revision.kind !== "team-game-snaps") return result("snap-pair-invalid");
    const p = player.revision.data; const q = team.revision.data;
    if (p.gameId !== q.gameId || p.teamId !== q.teamId) return result("snap-pair-invalid");
    if (p.offenseSnaps === null || q.offenseSnaps === null) return result("snap-value-missing");
    if (p.offenseSnaps > q.offenseSnaps) return result("snap-pair-invalid");
    playerSnaps += p.offenseSnaps; teamSnaps += q.offenseSnaps;
  }
  const providers = [...new Set(games.flatMap(({ player, team }) => [player!.artifact.profileId, team!.artifact.profileId]))].sort(compareText);
  for (let i = 0; i < providers.length; i += 1) {
    for (let j = i + 1; j < providers.length; j += 1) if (!compatible(providers[i], providers[j])) return result("snap-source-incompatible");
  }
  return teamSnaps === 0 ? result("snap-denominator-zero", playerSnaps, teamSnaps) : result(null, playerSnaps, teamSnaps);
};
