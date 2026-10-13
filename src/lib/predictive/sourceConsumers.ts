import type { Bundle, Kind, Observation, ParticipationRecord, Request, Revision } from "./types.ts";
import type { Replay, Selection } from "./replay.ts";
import { buildPassingYardsFromReplay } from "./passingYards.ts";
import { eligibleFinalAt } from "./labels.ts";
import type { SourceDecisionRecord } from "./sourceDecisions.ts";
import { sourceFactWitness, sourcePostWindowCapture, type SourceHeadReference, type SourceWitness } from "./sourceWitness.ts";
import type { SourceFactSnapshot } from "./sourceFacts.ts";
import { canonical, compareText, digest, instant, refuse } from "./validation.ts";

export const SOURCE_CONSUMER_VERSION = "source-consumer-v1";
export type SourceConsumerFact = {
  snapshot: SourceFactSnapshot; reconciliation: SourceDecisionRecord | null; participation: SourceDecisionRecord | null;
  reconciliationReason: string | null; participationReason: string | null;
};
export type SourceConsumerInput = {
  entityKey: string; witness: SourceWitness; reconciliationId: string | null; participationId: string | null;
  reconciliationReason: string | null; participationReason: string | null; selected: SourceHeadReference | null;
};
export type SourceConsumerManifest = {
  version: typeof SOURCE_CONSUMER_VERSION; use: "model-input" | "outcome-label"; cutoff: string; profileIds: string[];
  sources: SourceConsumerInput[]; observations: string[]; decisions: string[];
};
export type SourceFeatureBundle = Omit<Bundle, "featureVersion" | "usage"> & {
  featureVersion: "passing-yards-source-v1"; usage: "internal-research";
};
export type SourceFeatureBody = { kind: "feature"; bundle: SourceFeatureBundle; manifest: SourceConsumerManifest; inputDigest: string };
export type SourceFinalLabelBody = {
  kind: "label"; version: "source-final-label-v1"; playerId: string; gameId: string; seasonType: "REG" | "POST";
  stat: "passing_yards"; value: number; completionDecisionId: string; eligibleFinalAt: string;
  postWindowCaptureId: string; playerBridgeObservationId: string; manifest: SourceConsumerManifest; inputDigest: string;
};
export type SourceConsumerBody = SourceFeatureBody | SourceFinalLabelBody;
export type SourceConsumerRecord = {
  id: string; kind: "feature" | "label"; predecessorId: string | null; recordedAt: string; mode: "production-research" | "synthetic-proof";
  body: SourceConsumerBody; bodySha256: string; executionDigest: string; rightsDecisions: string[];
};
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compareText);
const input = (fact: SourceConsumerFact, entityKey: string): SourceConsumerInput => {
  const witness = sourceFactWitness(fact.snapshot, [entityKey]);
  for (const [kind, record] of [["reconciliation", fact.reconciliation], ["participation", fact.participation]] as const) {
    if (record && (record.plan.kind !== kind || record.plan.entityKey !== entityKey ||
        record.plan.witness.evidenceDigest !== witness.evidenceDigest || instant(record.recordedAt) > instant(witness.cutoff)))
      refuse("source-consumer-decision-refused");
  }
  return { entityKey, witness, reconciliationId: fact.reconciliation?.id ?? null, participationId: fact.participation?.id ?? null,
    reconciliationReason: fact.reconciliationReason, participationReason: fact.participationReason,
    selected: fact.reconciliation?.plan.selected ?? null };
};
const manifest = (use: SourceConsumerManifest["use"], cutoff: string, profileIds: string[], sources: SourceConsumerInput[], observations: string[], decisions: string[]): SourceConsumerManifest => ({
  version: SOURCE_CONSUMER_VERSION, use, cutoff, profileIds: sorted(profileIds), sources: sources.sort((a,b) => compareText(a.entityKey,b.entityKey)),
  observations: sorted(observations), decisions: sorted(decisions),
});
// SQL verifies this evidence digest independently. Computation time remains
// execution metadata and cannot change an earlier cutoff's feature inputs.
export const sourceConsumerInputDigest = (body: Omit<SourceFeatureBody,"inputDigest"> | Omit<SourceFinalLabelBody,"inputDigest"> | SourceConsumerBody) => {
  const { inputDigest: _digest, ...fields } = body as SourceConsumerBody; void _digest;
  if (fields.kind === "feature") {
    const { computedAt: _time, inputDigest: _bundleDigest, ...bundle } = fields.bundle; void _time; void _bundleDigest;
    return digest(canonical({ ...fields, bundle }));
  }
  return digest(canonical(fields));
};
export const sourceConsumerExecutionDigest = (bodySha256: string, rights: string[], recordedAt: string) =>
  digest(canonical({ bodySha256, rightsDecisions: sorted(rights), recordedAt }));

export const buildSourcePassingYards = (replay: Replay, request: Request, profileIds: string[], facts: Map<string, SourceConsumerFact>, synthetic = true): SourceFeatureBody => {
  const used = new Map<string, SourceConsumerInput>();
  const factFor = (key: string) => {
    const fact = facts.get(key) ?? refuse("source-consumer-fact-missing");
    const entry = input(fact,key); used.set(key,entry); return { fact, entry };
  };
  const adapter: Pick<Replay,"select" | "participation"> = {
    select: <K extends Kind>(kind: K, key: string): Selection<K> => {
      const { fact,entry } = factFor(key);
      const head = entry.selected && fact.snapshot.heads.find((row) => row.head.id === entry.selected!.bindingId);
      if (!head?.head.revision) return { state: entry.witness.withheld.length ? "absent" : entry.reconciliationReason ? "ambiguous" : "missing", observation: null, dependencies: [] };
      // Computation-only view: no source revision is inserted into the ordinary
      // observation ledger or its manifest. Exact CSV references live above.
      return { state: "selected", observation: { revision: head.head.revision as Revision<K> } as Observation<K>, dependencies: [] };
    },
    participation: (gameId,playerId) => {
      const { fact } = factFor("player-game-stats:" + gameId + ":" + playerId);
      const state = !fact.participationReason && fact.participation?.plan.state === "evaluated"
        ? (fact.participation.plan.outcome as ParticipationRecord["outcome"]).state : "unresolved";
      return { state, inputs: [] };
    },
  };
  const original = buildPassingYardsFromReplay(replay,request,adapter);
  if (!synthetic) original.quality = original.quality.filter((value) => value !== "synthetic-evidence-only");
  const sources = [...used.values()];
  const dependencies = original.dependencies;
  const body: SourceFeatureBody = { kind: "feature", bundle: { ...original, featureVersion: "passing-yards-source-v1", usage: "internal-research" },
    manifest: manifest("model-input",request.cutoff,profileIds,sources,dependencies.map((row) => row.observationId),
      [...original.completions,...original.participations,...original.reconciliations].map((row) => row.decisionId)), inputDigest: "" };
  body.inputDigest = sourceConsumerInputDigest(body); body.bundle.inputDigest = body.inputDigest;
  return body;
};

export const buildSourceFinalLabel = (fact: SourceConsumerFact, completion: { id: string; completionObservedAt: string }, profileIds: string[]): SourceFinalLabelBody => {
  const key = fact.snapshot.request.entityKeys[0]; const entry = input(fact,key);
  const selected = entry.selected && fact.snapshot.heads.find((row) => row.head.id === entry.selected!.bindingId);
  const revision = selected?.head.revision;
  if (fact.reconciliationReason || fact.participationReason || !revision || revision.kind !== "player-game-stats" ||
      (fact.participation?.plan.outcome as ParticipationRecord["outcome"] | null)?.state !== "offensive-participant" || revision.data.passingYards === null)
    refuse("source-label-inputs-unavailable");
  const eligible = eligibleFinalAt(completion.completionObservedAt);
  const capture = selected!.head.plan.binding.sourceCaptures[0];
  if (!capture || sourcePostWindowCapture(fact.snapshot,entry.witness,{ entityKey: key, bindingId: selected!.head.id,
    captureId: capture.id, eligibleAt: eligible }).state !== "confirmed-source-capture") refuse("source-label-post-window-refused");
  const bridges = selected!.head.plan.binding.dependencies.filter((row) => row.role === "player-bridge");
  if (bridges.length !== 1) refuse("source-label-identity-refused");
  const body: SourceFinalLabelBody = { kind: "label", version: "source-final-label-v1", playerId: revision.data.playerId, gameId: revision.data.gameId,
    seasonType: revision.data.seasonType, stat: "passing_yards", value: revision.data.passingYards, completionDecisionId: completion.id,
    eligibleFinalAt: eligible, postWindowCaptureId: capture.id, playerBridgeObservationId: bridges[0].observationId,
    manifest: manifest("outcome-label",fact.snapshot.request.cutoff,profileIds,[entry],[],[completion.id]), inputDigest: "" };
  body.inputDigest = sourceConsumerInputDigest(body); return body;
};
