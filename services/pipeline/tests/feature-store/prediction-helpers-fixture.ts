import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { MODEL_PREREGISTRATION } from "../../src/featureStore/modelManifests.ts";
import type { ModelReadPins, ModelRightsReceipt } from "../../src/featureStore/modelArtifacts.ts";
import type { ModelContext } from "../../src/featureStore/modelContext.ts";
import type { PredictionRequestPins, SupportedPredictionPolicy } from "../../src/featureStore/predictionHelpers.ts";

// Synthetic in-memory values follow the actual #165 publisher and Q1/Q2 shapes.
// No database/ObjectStore access or historical-availability claim is made here.
export const predictionFixture = (modes: readonly QbEvidenceMode[] = ["strict-point-in-time-v1", "retrospective-reconstruction-v1"],
  servedMode: QbEvidenceMode = modes[modes.length - 1]) => {
  const supported: SupportedPredictionPolicy = { modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION,
    labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION,
    adapter: { ...EMPIRICAL_ADAPTER }, evidenceModes: ["strict-point-in-time-v1", "retrospective-reconstruction-v1"] };
  const identity = { format: "qb-model-run-v1", designation: "uncalibrated-interim-hit-rate",
    modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
    historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION, adapter: { ...EMPIRICAL_ADAPTER },
    preregistration: { ...MODEL_PREREGISTRATION }, code: { gitSha: "c".repeat(40), contentSha256: "d".repeat(64) } };
  const datasets: ModelReadPins["datasets"] = modes.map((mode, i) => ({
    datasetId: `${i + 1}`.repeat(8) + "-1111-1111-1111-111111111111", mode,
    fileSha256: `${i + 1}`.repeat(64), contentSha256: `${i + 3}`.repeat(64), rowCount: i ? 2504 : 0,
    recordedAt: "2026-10-31T01:02:03.123456+00:00", spec: { mode, featureVersion: FEATURE_VERSION,
      labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY, featuresAsOf: "2026-10-30T00:00:00.123456Z",
      labelsAsOf: "2026-10-30T00:00:00.654321Z", includeRetrospective: mode === "retrospective-reconstruction-v1",
      includeSuperseded: true } }));
  const model = { run: { runId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", descriptorSha256: "e".repeat(64), identity,
    recordedAt: "2026-10-31T01:02:03.123456+00:00", rightsReceipt: { publication: "synthetic" } }, datasets };
  const request: PredictionRequestPins = { runId: model.run.runId, playerId: "new-QB-A", gameId: "unlabeled-new-game",
    modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY,
    scoringPolicy: QB_EVALUATOR_VERSION, evidenceMode: servedMode };
  const context: ModelContext = { request: { playerId: request.playerId, gameId: request.gameId,
    featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: servedMode,
    knownAsOf: "2026-10-31T00:00:00.123456+00:00" },
  feature: { featureId: "ffffffff-ffff-ffff-ffff-ffffffffffff", jobId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    playerId: request.playerId, gameId: request.gameId, stat: "passing_yards", season: 2026,
    cutoff: "2026-11-01T12:00:00.000001+00:00", checkpoint: "2026-10-30T01:02:03.123456+00:00",
    computedAt: "2026-10-30T01:02:04.654321+00:00", featureVersion: FEATURE_VERSION,
    historyPolicy: HISTORY_POLICY, evidenceMode: servedMode, sampleSize: 3,
    flags: servedMode === "retrospective-reconstruction-v1" ? ["historical-availability-unverified"] : [] },
  snapshotIds: ["cccccccc-cccc-cccc-cccc-cccccccccccc"],
  selection: { visibleHeadId: "ffffffff-ffff-ffff-ffff-ffffffffffff", lastValid: false, reasons: [] },
  freshness: { observedAt: "2026-10-31T01:02:03.987654+00:00", headId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    checkpoint: "2026-10-30T01:02:03.123456+00:00", computedAt: "2026-10-30T01:02:04.654321+00:00",
    superseded: false, stale: false, reasons: [] } };
  const descriptor = { format: "qb-model-descriptor-v1", rightsScope: "research", identity: structuredClone(identity),
    inputPins: { objectKey: "audits/" + "a".repeat(64), sha256: "a".repeat(64), byteSize: 100 },
    inputCode: { ...identity.code }, datasets: datasets.map(({ recordedAt: ignored, ...pin }) => {
      void ignored; return { ...structuredClone(pin), objectKey: "datasets/" + pin.fileSha256, byteSize: 200 };
    }), reports: datasets.map(pin => ({ mode: pin.mode, datasetId: pin.datasetId, objectKey: "audits/" + "b".repeat(64),
      sha256: "b".repeat(64), byteSize: 300, logicalSha256: "c".repeat(64) })) };
  return { descriptor, request, model, context, supported };
};

export const predictionDeliveryFixture = () => {
  const input = predictionFixture();
  input.context.selection = { ...input.context.selection, lastValid: true, reasons: ["insufficient-history"] };
  const finalContext = structuredClone(input.context);
  finalContext.freshness = { observedAt: "2026-10-31T01:02:05.987654+00:00",
    headId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", checkpoint: "2026-10-31T00:00:00.123457+00:00",
    computedAt: "2026-10-31T00:00:01.654322+00:00", superseded: true, stale: true,
    reasons: ["insufficient-history", "newest-revision-unavailable"] };
  const authorization: ModelRightsReceipt = { checkedAt: "2026-10-31T01:02:04.123456+00:00",
    decisions: [{ profileId: "profile-model", decisionId: "decision-model-q1" },
      { profileId: "profile-feature", decisionId: "decision-feature-q1" }] };
  const delivery: ModelRightsReceipt = { checkedAt: "2026-10-31T01:02:05.987654+00:00",
    decisions: [{ profileId: "profile-model", decisionId: "decision-model-q2" },
      { profileId: "profile-feature", decisionId: "decision-feature-q2" }] };
  return { ...input, finalContext, authorization, delivery,
    history: [100, 200, 300].map((yards, i) => ({ gameId: `prior-${i}`, kickoff: "2026-09-01T12:00:00Z", yards })) };
};
