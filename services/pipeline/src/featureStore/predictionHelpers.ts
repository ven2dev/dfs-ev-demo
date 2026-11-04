import { isDeepStrictEqual } from "node:util";
import type { ModelReadPins } from "./modelArtifacts.ts";
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
  | "descriptor-mismatch" | "evidence-mode-mismatch";
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
