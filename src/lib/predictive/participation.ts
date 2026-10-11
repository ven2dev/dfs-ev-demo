import type { Decision, Observation, ParticipationRecord, Profile } from "./types.ts";
import { canonical, compareText, instant, refuse } from "./validation.ts";

// participation-v1, shared by replay and decision validation, and mirrored by
// predictive_decision_check() in migration 0003. Positive usage (an attempt,
// carry or target on every stats head) or explicit evidence supports one
// individual label. Several provider heads for one evidence kind, or evidence
// that disappeared, is a conflict. Missing evidence stays unresolved. Nothing
// here establishes a complete eligible population.
export type ParticipationState = ParticipationRecord["outcome"]["state"];

export const participationFromHeads = (heads: Observation[]): { state: ParticipationState } => {
  const evidence = heads.filter((row) => row.entityKey.startsWith("participation-evidence:"));
  const stats = heads.filter((row) => row.entityKey.startsWith("player-game-stats:"));
  const byKind = new Map<string, Observation[]>();
  for (const row of evidence) {
    const kind = row.entityKey.split(":")[3];
    byKind.set(kind, [...(byKind.get(kind) ?? []), row]);
  }
  if ([...byKind.values()].some((rows) => rows.length > 1 || rows.some((row) => row.revision.kind === "source-row-absent"))) return { state: "conflicting" };
  const claims = new Set(evidence.flatMap((row) => row.revision.kind === "participation-evidence" ? [row.revision.data.claim] : []));
  // Usage counts only when every stats head is present and shows an attempt,
  // carry or target; providers that disagree about usage supply no usage evidence.
  const positive = (row: Observation) => row.revision.kind === "player-game-stats" &&
    [row.revision.data.attempts, row.revision.data.carries, row.revision.data.targets].some((value) => value !== null && value > 0);
  if (stats.length && stats.every(positive)) claims.add("offensive-participant");
  if (claims.size > 1) return { state: "conflicting" };
  const [claim] = claims;
  return { state: claim ?? "unresolved" };
};

// The evidence scope for one player-game: every participation-evidence fact
// plus the player's stats fact, as heads usable at instant t.
export const participationHeadsAt = (observations: Iterable<Observation>, gameId: string, playerId: string, t: number) => {
  const prefix = "participation-evidence:" + gameId + ":" + playerId + ":";
  const stats = "player-game-stats:" + gameId + ":" + playerId;
  const visible = [...observations].filter((row) => (row.entityKey.startsWith(prefix) || row.entityKey === stats) &&
    instant(row.capture.availableAt) <= t && instant(row.capture.ingestedAt) <= t);
  const superseded = new Set(visible.map((row) => row.revision.predecessorId));
  return visible.filter((row) => !superseded.has(row.revision.id));
};

export const validateParticipationDecisions = (decisions: Decision[], observations: Map<string, Observation>, profiles: Map<string, Profile>) => {
  for (const decision of decisions) {
    if (decision.kind !== "participation") continue;
    const [, gameId, playerId] = decision.entityKey.split(":");
    const inputs = decision.inputs.map((input) => observations.get(input.observationId) ?? refuse("decision-input-missing"));
    const heads = participationHeadsAt(observations.values(), gameId, playerId, instant(decision.decidedAt));
    const ids = (rows: Observation[]) => rows.map((row) => row.revision.id).sort(compareText).join("\n");
    if (ids(inputs) !== ids(heads)) refuse("participation-inputs-not-heads");
    if (canonical(participationFromHeads(heads)) !== canonical(decision.outcome)) refuse("decision-rule-mismatch");
    const synthetic = heads.some((row) => profiles.get(row.artifact.profileId)?.purpose === "synthetic-test");
    if (heads.length && synthetic !== (decision.mode === "synthetic-proof")) refuse("decision-mode-mismatch");
  }
};

export const recordParticipation = (id: string, gameId: string, playerId: string, heads: Observation[], decidedAt: string,
  mode: ParticipationRecord["mode"], predecessorId: string | null = null): ParticipationRecord => ({
  id, kind: "participation", entityKey: "participation:" + gameId + ":" + playerId, policyId: "participation-v1", mode, decidedAt, predecessorId,
  outcome: participationFromHeads(heads),
  inputs: [...heads].sort((a, b) => compareText(a.revision.id, b.revision.id)).map((row) => ({ observationId: row.revision.id, role: "evidence" })),
});
