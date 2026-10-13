import type { Observation, ParticipationRecord, Reconciliation } from "./types.ts";
import { participationOutcome } from "./participation.ts";
import { sourceFactRequest, type SourceFactSnapshot } from "./sourceFacts.ts";
import { sourceFactWitness, sourceReconciliationEvidence, sourceUsageEvidence, type SourceHeadReference, type SourceWitness } from "./sourceWitness.ts";
import { canonical, compareText, digest, exact, instant, refuse } from "./validation.ts";

export const SOURCE_DECISION_VERSION = "source-decision-plan-v1";
export type SourceDecisionRequest = { kind: "reconciliation" | "participation"; profileIds: string[]; entityKey: string; cutoff: string };
export type SourceDecisionInput = {
  role: "participation-evidence"; observationId: string; profileId: string; sourceKey: string;
  captureId: string; artifactId: string; artifactSha256: string; availableAt: string; ingestedAt: string;
};
export type SourceDecisionPlan = {
  version: typeof SOURCE_DECISION_VERSION; kind: SourceDecisionRequest["kind"]; entityKey: string;
  policyId: "reconciliation-v1" | "participation-v1"; mode: "production-research" | "synthetic-proof";
  witness: SourceWitness; nativeInputs: SourceDecisionInput[]; state: "evaluated" | "withheld";
  outcome: Reconciliation["outcome"] | ParticipationRecord["outcome"] | null;
  selected: SourceHeadReference | null; planDigest: string;
};
export type SourceDecisionRecord = {
  id: string; predecessorId: string | null; recordedAt: string; plan: SourceDecisionPlan;
};

export const sourceDecisionRequest = (input: SourceDecisionRequest): SourceDecisionRequest => {
  exact(input, ["kind", "profileIds", "entityKey", "cutoff"]);
  if (!["reconciliation", "participation"].includes(input.kind) ||
      (input.kind === "participation" && !input.entityKey.startsWith("player-game-stats:"))) refuse("source-decision-request-refused");
  const request = sourceFactRequest({ profileIds: input.profileIds, entityKeys: [input.entityKey], cutoff: input.cutoff });
  return { kind: input.kind, profileIds: request.profileIds, entityKey: request.entityKeys[0], cutoff: request.cutoff };
};
export const sourceDecisionPlan = (snapshot: SourceFactSnapshot, input: SourceDecisionRequest, native: Observation[], mode: SourceDecisionPlan["mode"]): SourceDecisionPlan => {
  const request = sourceDecisionRequest(input);
  if (canonical(snapshot.request.profileIds) !== canonical(request.profileIds) || snapshot.request.cutoff !== request.cutoff)
    refuse("source-decision-scope-refused");
  const witness = sourceFactWitness(snapshot, [request.entityKey]);
  const prefix = "participation-evidence:" + request.entityKey.slice("player-game-stats:".length) + ":";
  if (native.length > 256 || (request.kind === "reconciliation" && native.length) || native.some((row) =>
    !row.entityKey.startsWith(prefix) || instant(row.capture.availableAt) > instant(request.cutoff) || instant(row.capture.ingestedAt) > instant(request.cutoff)))
    refuse("source-decision-native-scope-refused");
  const nativeInputs = native.map((row): SourceDecisionInput => ({ role: "participation-evidence", observationId: row.revision.id,
    profileId: row.artifact.profileId, sourceKey: row.sourceKey, captureId: row.capture.id, artifactId: row.artifact.id,
    artifactSha256: row.artifact.sha256, availableAt: row.capture.availableAt, ingestedAt: row.capture.ingestedAt }))
    .sort((a, b) => compareText(a.observationId, b.observationId));
  if (new Set(nativeInputs.map((row) => row.observationId)).size !== nativeInputs.length) refuse("source-decision-native-scope-refused");
  const reconciliation = request.kind === "reconciliation" ? sourceReconciliationEvidence(snapshot, request.entityKey) : null;
  const usage = request.kind === "participation" ? sourceUsageEvidence(snapshot, request.entityKey) : null;
  const withheld = reconciliation?.state === "withheld" || usage?.state === "withheld";
  const fields: Omit<SourceDecisionPlan, "planDigest"> = {
    version: SOURCE_DECISION_VERSION, kind: request.kind, entityKey: request.entityKey,
    policyId: request.kind === "participation" ? "participation-v1" : "reconciliation-v1", mode, witness, nativeInputs,
    state: withheld ? "withheld" : "evaluated",
    outcome: withheld ? null : reconciliation ? reconciliation.outcome : participationOutcome(native, usage?.state === "positive-usage"),
    selected: reconciliation?.selected ?? null,
  };
  return { ...fields, planDigest: digest(canonical(fields)) };
};

// Query time is not evidence. Mode, native evidence and binding IDs/tokens ARE
// evidence. This compares freshness, not authorization or complete population.
export const sourceDecisionBasis = ({ planDigest: _digest, witness, ...fields }: SourceDecisionPlan) => {
  const { cutoff: _cutoff, ...evidence } = witness; void _digest; void _cutoff;
  return canonical({ ...fields, witness: evidence });
};
