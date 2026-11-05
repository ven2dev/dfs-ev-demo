import { isDeepStrictEqual } from "node:util";
import { equalMassSupport, probabilityAt, type Triple } from "@dfs-ev/domain/empirical";
import type { ModelFeatureHistory, ModelReadPins, ModelRightsReceipt } from "./modelArtifacts.ts";
import type { ModelContext, ModelContextRequest } from "./modelContext.ts";

// Private functional core. The handler supplies this policy from canonical
// pipeline constants, never from caller/descriptor claims. Type-only imports
// avoid loading the readers or their SQL/I/O dependencies here.
export type SupportedPredictionPolicy = Readonly<{
  modelVersion: string; featureVersion: string; labelVersion: string;
  historyPolicy: string; scoringPolicy: string;
  adapter: Readonly<{ id: string; version: string }>;
  evidenceModes: readonly ModelContextRequest["evidenceMode"][];
}>;
export type PredictionRequestPins = Readonly<Pick<ModelContextRequest,
  "playerId" | "gameId" | "featureVersion" | "historyPolicy" | "evidenceMode"> & {
  runId: string; modelVersion: string; scoringPolicy: string;
}>;
export type PredictionValidationCode = "invalid-request" | "unsupported-model-policy"
  | "descriptor-mismatch" | "evidence-mode-mismatch" | "materialization-refused";
export class PredictionValidationError extends Error {
  readonly code: PredictionValidationCode;
  constructor(code: PredictionValidationCode) {
    super(code); this.name = "PredictionValidationError"; this.code = code;
  }
}
export type ValidatedPredictionModel = {
  runId: string; descriptorSha256: string;
  rightsScope: "research"; designation: "uncalibrated-interim-hit-rate";
  modelVersion: string; featureVersion: string; labelVersion: string;
  historyPolicy: string; scoringPolicy: string; adapter: { id: string; version: string };
  evidenceMode: ModelContextRequest["evidenceMode"];
  datasetModes: ModelContextRequest["evidenceMode"][];
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const named = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function refused(code: PredictionValidationCode): never { throw new PredictionValidationError(code); }

// Q1's dataset projection is authoritative. It deliberately omits transport
// objectKey/byteSize and recordedAt from this comparison: the first two are not
// exposed by descriptor-only Q1; recordedAt is not a descriptor dataset pin.
const datasetPin = (value: Record<string, unknown>) => ({
  datasetId: value.datasetId, mode: value.mode, fileSha256: value.fileSha256,
  contentSha256: value.contentSha256, spec: value.spec, rowCount: value.rowCount,
});

// GET and JSON parsing belong to #167's private Q1 callback. This function takes
// values only, does no authorization, and cannot permit delivery before Q2.
export const validateModelDescriptor = ({ descriptor, request, model, context, supported }: {
  descriptor: unknown; request: PredictionRequestPins;
  model: Pick<ModelReadPins, "run"> & { datasets: readonly ModelReadPins["datasets"][number][] };
  context: ModelContext; supported: SupportedPredictionPolicy;
}): ValidatedPredictionModel => {
  if (!request || !uuid(request.runId) || !named(request.playerId) || !named(request.gameId)) refused("invalid-request");
  if (request.modelVersion !== supported.modelVersion || request.featureVersion !== supported.featureVersion
    || request.historyPolicy !== supported.historyPolicy || request.scoringPolicy !== supported.scoringPolicy
    || !supported.evidenceModes.includes(request.evidenceMode)) refused("unsupported-model-policy");

  const document = object(descriptor), identity = object(document?.identity);
  if (!document || document.format !== "qb-model-descriptor-v1" || document.rightsScope !== "research"
    || !identity || identity.format !== "qb-model-run-v1" || identity.designation !== "uncalibrated-interim-hit-rate"
    || !uuid(model.run.runId) || request.runId.toLowerCase() !== model.run.runId.toLowerCase()
    || !isDeepStrictEqual(identity, model.run.identity)) refused("descriptor-mismatch");
  if (identity.modelVersion !== supported.modelVersion || identity.featureVersion !== supported.featureVersion
    || identity.labelVersion !== supported.labelVersion || identity.historyPolicy !== supported.historyPolicy
    || identity.scoringPolicy !== supported.scoringPolicy || !isDeepStrictEqual(identity.adapter, supported.adapter))
    refused("unsupported-model-policy");

  // The resolver/SQL guard owns time selection and re-resolution. Do not parse
  // or normalize clocks here; compare just the requested identity/policy pins.
  for (const key of ["playerId", "gameId", "featureVersion", "historyPolicy", "evidenceMode"] as const)
    if (context?.request?.[key] !== request[key] || context?.feature?.[key] !== request[key]) refused("descriptor-mismatch");

  if (!Array.isArray(model.datasets) || model.datasets.length < 1 || model.datasets.length > 2
    || !Array.isArray(document.datasets) || document.datasets.length !== model.datasets.length) refused("descriptor-mismatch");
  const expected = new Map<string, ModelReadPins["datasets"][number]>(), modes = new Set<ModelContextRequest["evidenceMode"]>();
  for (const pin of model.datasets) {
    if (!uuid(pin.datasetId) || expected.has(pin.datasetId) || modes.has(pin.mode)
      || !supported.evidenceModes.includes(pin.mode)) refused("descriptor-mismatch");
    expected.set(pin.datasetId, pin); modes.add(pin.mode);
  }
  const seen = new Set<string>();
  for (const value of document.datasets) {
    const pin = object(value);
    if (!pin || !uuid(pin.datasetId) || seen.has(pin.datasetId)) refused("descriptor-mismatch");
    const recorded = expected.get(pin.datasetId);
    if (!recorded || !isDeepStrictEqual(datasetPin(pin), datasetPin(recorded))) refused("descriptor-mismatch");
    seen.add(pin.datasetId);
  }
  if (!modes.has(context.feature.evidenceMode)) refused("evidence-mode-mismatch");

  // Return owned, bounded values rather than retaining the descriptor, dataset
  // specs, caller policy or any other mutable input container.
  return { runId: model.run.runId, descriptorSha256: model.run.descriptorSha256,
    rightsScope: "research", designation: "uncalibrated-interim-hit-rate",
    modelVersion: supported.modelVersion, featureVersion: supported.featureVersion, labelVersion: supported.labelVersion,
    historyPolicy: supported.historyPolicy, scoringPolicy: supported.scoringPolicy,
    adapter: { id: supported.adapter.id, version: supported.adapter.version },
    evidenceMode: context.feature.evidenceMode, datasetModes: [...modes].sort() };
};

export type PredictionForecast = { line: number; sampleCount: number; probabilities: Triple };

// Q1/producer owns example eligibility and lineage. Only yards enter arithmetic;
// finite support is a math backstop, not a second per-example qualification pass.
export const computePredictionForecast = ({ history, sampleSize, line }: {
  history: readonly Pick<ModelFeatureHistory[number], "yards">[] | undefined;
  sampleSize: number; line: number;
}): PredictionForecast => {
  if (!Number.isFinite(line)) refused("invalid-request");
  if (!Array.isArray(history) || !Number.isInteger(sampleSize) || sampleSize < 2 || sampleSize > 16
    || history.length !== sampleSize) refused("materialization-refused");
  const support = equalMassSupport(history.map(row => row?.yards));
  if (support.some(point => !Number.isFinite(point.value))) refused("materialization-refused");
  const probabilities = probabilityAt(support, line);
  if (!probabilities) refused("materialization-refused");
  return { line, sampleCount: sampleSize, probabilities };
};

export type PredictionResponseData = {
  status: "available"; playerId: string; gameId: string;
  model: ValidatedPredictionModel; forecast: PredictionForecast; context: ModelContext;
  authorization: ModelRightsReceipt; delivery: ModelRightsReceipt;
};
const copyReceipt = (receipt: ModelRightsReceipt): ModelRightsReceipt => ({
  checkedAt: receipt.checkedAt,
  decisions: receipt.decisions.map(({ profileId, decisionId }) => ({ profileId, decisionId })),
});

// Trusted composition only: #167 calls this after Q2, then serializes and applies
// its final deadline/delivery gate. Copy explicit fields to keep extra private
// caller data out of the response. No clocks or freshness policy are evaluated.
export const buildPredictionResponse = ({ request, model, forecast, context, authorization, delivery }: {
  request: PredictionRequestPins; model: ValidatedPredictionModel; forecast: PredictionForecast;
  context: ModelContext; authorization: ModelRightsReceipt; delivery: ModelRightsReceipt;
}): PredictionResponseData => ({
  status: "available", playerId: request.playerId, gameId: request.gameId,
  model: { runId: model.runId, descriptorSha256: model.descriptorSha256,
    rightsScope: model.rightsScope, designation: model.designation,
    modelVersion: model.modelVersion, featureVersion: model.featureVersion, labelVersion: model.labelVersion,
    historyPolicy: model.historyPolicy, scoringPolicy: model.scoringPolicy,
    adapter: { id: model.adapter.id, version: model.adapter.version },
    evidenceMode: model.evidenceMode, datasetModes: [...model.datasetModes] },
  forecast: { line: forecast.line, sampleCount: forecast.sampleCount,
    probabilities: { overProbability: forecast.probabilities.overProbability,
      underProbability: forecast.probabilities.underProbability, pushProbability: forecast.probabilities.pushProbability } },
  context: {
    request: { playerId: context.request.playerId, gameId: context.request.gameId,
      knownAsOf: context.request.knownAsOf, featureVersion: context.request.featureVersion,
      historyPolicy: context.request.historyPolicy, evidenceMode: context.request.evidenceMode },
    feature: { featureId: context.feature.featureId, jobId: context.feature.jobId,
      playerId: context.feature.playerId, gameId: context.feature.gameId, stat: context.feature.stat,
      season: context.feature.season, cutoff: context.feature.cutoff, checkpoint: context.feature.checkpoint,
      computedAt: context.feature.computedAt, featureVersion: context.feature.featureVersion,
      historyPolicy: context.feature.historyPolicy, evidenceMode: context.feature.evidenceMode,
      sampleSize: context.feature.sampleSize, flags: [...context.feature.flags] },
    snapshotIds: [...context.snapshotIds],
    selection: { visibleHeadId: context.selection.visibleHeadId, lastValid: context.selection.lastValid,
      reasons: [...context.selection.reasons] },
    freshness: { observedAt: context.freshness.observedAt, headId: context.freshness.headId,
      checkpoint: context.freshness.checkpoint, computedAt: context.freshness.computedAt,
      superseded: context.freshness.superseded, stale: context.freshness.stale, reasons: [...context.freshness.reasons] },
  },
  authorization: copyReceipt(authorization), delivery: copyReceipt(delivery),
});
