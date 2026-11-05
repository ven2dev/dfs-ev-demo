import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION } from "@dfs-ev/domain/qb-evaluation";
import { FEATURE_VERSION, HISTORY_POLICY, LABEL_VERSION } from "./derived.ts";
import { EMPIRICAL_ADAPTER } from "./empiricalAdapter.ts";
import { ArtifactGovernanceError, type ArtifactGovernanceCode } from "./artifactGovernanceErrors.ts";
import { connectionInterrupted } from "./connections.ts";
import { withModelArtifacts } from "./modelArtifacts.ts";
import { ModelContextError, resolveModelContext, type ModelContextCode } from "./modelContext.ts";
import type { ObjectStore } from "./objectStore.ts";
import { buildPredictionResponse, computePredictionForecast, validateModelDescriptor, PredictionValidationError,
  type PredictionRequestPins, type PredictionResponseData, type PredictionValidationCode,
  type SupportedPredictionPolicy } from "./predictionHelpers.ts";

export type PredictionRequest = PredictionRequestPins & { knownAsOf: string; line: number };
type Connection = Pick<Client, "query" | "end">;
type Disposition = { connectionDisposition: "reusable" | "discard" };
export type PredictionRefusal = ModelContextCode | ArtifactGovernanceCode | PredictionValidationCode
  | "connection-interrupted" | "prediction-unavailable";
export type PredictionResponse = Disposition & (PredictionResponseData | { status: "unavailable"; reason: PredictionRefusal });
export type PredictionRead = { response: PredictionResponse; serialized: string };

// Policy comes from the producer/domain constants, never caller or descriptor
// claims. Capture the exported adapter's scalars rather than its mutable object.
const supported: SupportedPredictionPolicy = Object.freeze({
  modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
  historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION,
  adapter: Object.freeze({ ...EMPIRICAL_ADAPTER }),
  evidenceModes: Object.freeze(["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const),
});

// Thin orchestration over #231 and #235: no SQL, authorization, feature selection
// or example qualification is implemented here. Borrow an exclusive connected,
// idle READ COMMITTED client, as required by the composite boundary.
export const predictQbModel = async (client: Connection, store: Pick<ObjectStore, "get">,
  request: PredictionRequest): Promise<PredictionRead> => {
  let connectionDisposition: Disposition["connectionDisposition"] = "reusable";
  const serialize = (response: PredictionResponse): PredictionRead => ({ response, serialized: JSON.stringify(response) });
  try {
    // Capture named scalars before awaits; target labels, caller histories and
    // other extras are neither read nor forwarded. Keep timestamp text verbatim.
    const { runId, playerId, gameId, modelVersion, featureVersion, historyPolicy, scoringPolicy,
      evidenceMode, knownAsOf, line } = request ?? {};
    const pins: PredictionRequestPins = { runId, playerId, gameId, modelVersion, featureVersion,
      historyPolicy, scoringPolicy, evidenceMode };
    if (typeof runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)
      || !Number.isFinite(line)) throw new PredictionValidationError("invalid-request");
    if (modelVersion !== supported.modelVersion || scoringPolicy !== supported.scoringPolicy)
      throw new PredictionValidationError("unsupported-model-policy");

    const context = await resolveModelContext(client, { playerId, gameId, knownAsOf,
      featureVersion, historyPolicy, evidenceMode });
    const result = await withModelArtifacts(client, store, { runId, slots: ["descriptor"], context }, input => {
      if (!input.context) throw new ModelContextError("model-context-reference-refused");
      let descriptor: unknown;
      try { descriptor = JSON.parse(input.files[0].bytes.toString("utf8")); }
      catch { throw new PredictionValidationError("descriptor-mismatch"); }
      const model = validateModelDescriptor({ descriptor, request: pins, model: input, context: input.context, supported });
      const forecast = computePredictionForecast({ history: input.history,
        sampleSize: input.context.feature.sampleSize, line });
      return { model, forecast };
    });
    if (!result.context) throw new ModelContextError("model-context-reference-refused");
    // Only Q2 permits response construction. Its context refreshes flags while
    // the forecast keeps Q1's selected values and declared sample size.
    return serialize({ ...buildPredictionResponse({ request: pins, ...result.value, context: result.context,
      authorization: result.authorization, delivery: result.delivery }), connectionDisposition });
  } catch (error) {
    let reason: PredictionRefusal;
    if (error instanceof PredictionValidationError || error instanceof ModelContextError || error instanceof ArtifactGovernanceError) {
      reason = error.code;
      if (reason === "model-read-session-refused") connectionDisposition = "discard";
    } else {
      reason = connectionInterrupted(error) ? "connection-interrupted" : "prediction-unavailable";
      connectionDisposition = "discard";
    }
    if (connectionDisposition === "discard") await client.end().catch(() => {});
    // No private context, bytes, receipts or partially computed forecast survive
    // any refusal. Provider messages/causes stay inside the trusted operation.
    return serialize({ status: "unavailable", reason, connectionDisposition });
  }
};
