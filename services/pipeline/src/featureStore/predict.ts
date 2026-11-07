import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION } from "@dfs-ev/domain/qb-evaluation";
import { FEATURE_VERSION, HISTORY_POLICY, LABEL_VERSION } from "./derived.ts";
import { EMPIRICAL_ADAPTER, EMPIRICAL_DEADLINE_MS } from "./empiricalAdapter.ts";
import { ArtifactGovernanceError, type ArtifactGovernanceCode } from "./artifactGovernanceErrors.ts";
import { connectionInterrupted } from "./connections.ts";
import { withModelArtifacts } from "./modelArtifacts.ts";
import { ModelContextError, resolveModelContext, type ModelContextCode } from "./modelContext.ts";
import type { ObjectStore } from "./objectStore.ts";
import { predictionDeadline } from "./predictionClock.ts";
import { buildPredictionResponse, computePredictionForecast, validateModelDescriptor, PredictionValidationError,
  type PredictionRequestPins, type PredictionResponseData, type PredictionValidationCode,
  type SupportedPredictionPolicy } from "./predictionHelpers.ts";

export type PredictionRequest = PredictionRequestPins & { knownAsOf: string; line: number };
export type PredictionOptions = {
  signal?: AbortSignal;
  /** Same-process performance.now() clock; can only shorten the 300 ms default. */
  deadlineAt?: number;
};
export const PREDICTION_DEADLINE_MS = EMPIRICAL_DEADLINE_MS;
type Connection = Pick<Client, "query">;
type Disposition = { connectionDisposition: "reusable" | "discard" };
export type PredictionRefusal = ModelContextCode | ArtifactGovernanceCode | PredictionValidationCode
  | "deadline-exceeded" | "cancelled" | "connection-interrupted" | "prediction-unavailable";
export type PredictionResponse = PredictionResponseData | { status: "unavailable"; reason: PredictionRefusal };
export type PredictionRead = Disposition & { response: PredictionResponse; serialized: string };

// Policy comes from the producer/domain constants, never caller or descriptor
// claims. Capture the exported adapter's scalars rather than its mutable object.
const supported: SupportedPredictionPolicy = Object.freeze({
  modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
  historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION,
  adapter: Object.freeze({ ...EMPIRICAL_ADAPTER }),
  evidenceModes: Object.freeze(["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const),
});
class PredictionInterruption extends Error {
  readonly code: "deadline-exceeded" | "cancelled";
  constructor(code: "deadline-exceeded" | "cancelled") { super(code); this.code = code; }
}

// Thin orchestration over #231 and #235: no SQL, authorization, feature selection
// or example qualification is implemented here. Borrow an exclusive connected,
// idle READ COMMITTED client, as required by the composite boundary.
export const predictQbModel = async (client: Connection, store: Pick<ObjectStore, "get">,
  request: PredictionRequest, options: PredictionOptions = {}): Promise<PredictionRead> => {
  const started = performance.now(), { signal, deadlineAt } = options;
  const deadline = predictionDeadline(started, deadlineAt);
  let connectionDisposition: Disposition["connectionDisposition"] = "reusable";
  const serialize = (response: PredictionResponse): PredictionRead =>
    ({ response, serialized: JSON.stringify(response), connectionDisposition });
  if (deadline === undefined) return serialize({ status: "unavailable", reason: "invalid-request" });
  let inFlightSql = false;
  let interrupted: PredictionInterruption | undefined;
  let rejectInterruption: (error: PredictionInterruption) => void;
  const interruption = new Promise<never>((_, reject) => { rejectInterruption = reject; });
  const discard = () => {
    connectionDisposition = "discard";
  };
  const interrupt = (code: PredictionInterruption["code"]) => {
    if (interrupted) return;
    interrupted = new PredictionInterruption(code);
    if (inFlightSql) discard();
    rejectInterruption(interrupted);
  };
  const remaining = () => {
    if (signal?.aborted) interrupt("cancelled");
    const ms = deadline - performance.now();
    if (ms <= 0) interrupt("deadline-exceeded");
    if (interrupted) throw interrupted;
    return Math.max(1, Math.floor(ms));
  };
  const onAbort = () => interrupt("cancelled");
  const timer = setTimeout(() => interrupt("deadline-exceeded"), Math.max(0, deadline - performance.now()));
  signal?.addEventListener("abort", onAbort, { once: true });
  const boundedClient = { query: async (text: string, values: unknown[]) => {
    const config = { text, values, query_timeout: remaining() };
    inFlightSql = true;
    let result;
    try { result = await client.query(config); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "57014" || (error instanceof Error && error.message === "Query read timeout")) {
        discard(); interrupt("deadline-exceeded");
      } else if (connectionInterrupted(error)) discard();
      throw error;
    } finally { inFlightSql = false; }
    remaining();
    return result;
  } } as Pick<Client, "query">;
  const boundedStore = { get: async (key: string) => {
    remaining();
    const bytes = await store.get(key);
    // ObjectStore has no abort contract. A late result stays private and cannot
    // trigger calculation or Q2 even after the outer refusal has returned.
    remaining();
    return bytes;
  } };
  // Start synchronously so scalar capture precedes the first await. The race
  // observes both promises in this turn, including abandoned late rejections.
  const task = (async () => {
    remaining();
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

    const context = await resolveModelContext(boundedClient, { playerId, gameId, knownAsOf,
      featureVersion, historyPolicy, evidenceMode });
    const result = await withModelArtifacts(boundedClient, boundedStore, { runId, slots: ["descriptor"], context }, input => {
      remaining();
      if (!input.context) throw new ModelContextError("model-context-reference-refused");
      let descriptor: unknown;
      try { descriptor = JSON.parse(input.files[0].bytes.toString("utf8")); }
      catch { throw new PredictionValidationError("descriptor-mismatch"); }
      const model = validateModelDescriptor({ descriptor, request: pins, model: input, context: input.context, supported });
      remaining();
      const forecast = computePredictionForecast({ history: input.history,
        sampleSize: input.context.feature.sampleSize, line });
      remaining();
      return { model, forecast };
    });
    remaining();
    if (!result.context) throw new ModelContextError("model-context-reference-refused");
    // Only Q2 permits response construction. Its context refreshes flags while
    // the forecast keeps Q1's selected values and declared sample size.
    const response = buildPredictionResponse({ request: pins, ...result.value, context: result.context,
      authorization: result.authorization, delivery: result.delivery });
    remaining();
    const read = serialize(response);
    remaining();
    return read;
  })();
  try {
    const result = await Promise.race([task, interruption]);
    remaining(); // Includes response construction, serialization and final delivery.
    return result;
  } catch (error) {
    // A lower reader may wrap an interruption as an artifact error. The owned
    // latch wins, including when synchronous work outlasted the timer callback.
    try { remaining(); } catch { /* interrupted is already latched */ }
    let reason: PredictionRefusal;
    if (interrupted) reason = interrupted.code;
    else if (error instanceof PredictionValidationError || error instanceof ModelContextError || error instanceof ArtifactGovernanceError) {
      reason = error.code;
      if (reason === "model-read-session-refused") discard();
    } else {
      reason = connectionInterrupted(error) ? "connection-interrupted" : "prediction-unavailable";
      discard();
    }
    // No private context, bytes, receipts or partially computed forecast survive
    // any refusal. Provider messages/causes stay inside the trusted operation.
    return serialize({ status: "unavailable", reason });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};
