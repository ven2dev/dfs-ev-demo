import { Client, Pool, type ClientConfig, type PoolClient } from "pg";
import { connectionInterrupted } from "./connections.ts";
import { predictionDeadline } from "./predictionClock.ts";
import { predictQbModel, PREDICTION_DEADLINE_MS, type PredictionOptions, type PredictionRead,
  type PredictionRefusal, type PredictionRequest } from "./predict.ts";
import type { ObjectStore } from "./objectStore.ts";

const unavailable = (reason: PredictionRefusal): PredictionRead => {
  const response = { status: "unavailable" as const, reason };
  return { response, serialized: JSON.stringify(response), connectionDisposition: "discard" };
};
const boundedTimeout = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 1
  ? Math.min(Math.floor(value), PREDICTION_DEADLINE_MS) : PREDICTION_DEADLINE_MS;

// Own a new standalone client or borrow from an owner-configured serving pool.
// Explicit pg fields only: connection-string options override explicit config
// in pg and could silently replace the bounded startup statement_timeout.
// Pool options/session settings stay private and unchanged under this owner.
export const predictQbModelOwned = async (source: ClientConfig | Pool, store: Pick<ObjectStore, "get">,
  request: PredictionRequest, options: PredictionOptions = {}): Promise<PredictionRead> => {
  const started = performance.now(), { signal, deadlineAt } = options;
  const deadline = predictionDeadline(started, deadlineAt);
  if (deadline === undefined) return unavailable("invalid-request");
  if (signal?.aborted) return unavailable("cancelled");
  if (deadline <= started) return unavailable("deadline-exceeded");
  const pool = source instanceof Pool ? source : undefined;
  const config = pool ? pool.options : source as ClientConfig;
  if (config.connectionString || config.pipeline || (pool && (!Number.isInteger(config.statement_timeout)
    || Number(config.statement_timeout) < 1 || Number(config.statement_timeout) > PREDICTION_DEADLINE_MS)))
    return unavailable("model-read-session-refused");
  // Capture the named scalars now, before connection acquisition can yield.
  const pins = { runId: request?.runId, playerId: request?.playerId, gameId: request?.gameId,
    modelVersion: request?.modelVersion, featureVersion: request?.featureVersion, historyPolicy: request?.historyPolicy,
    scoringPolicy: request?.scoringPolicy, evidenceMode: request?.evidenceMode, knownAsOf: request?.knownAsOf, line: request?.line };
  let standalone: Client | undefined, borrowed: PoolClient | undefined;
  let disposed = false, terminal: "cancelled" | "deadline-exceeded" | undefined;
  let discard = true;
  const dispose = () => {
    if (disposed || (!standalone && !borrowed)) return;
    disposed = true;
    // Initiate exactly once, without waiting for a broken close handshake.
    // Observe failures privately; the startup server timeout remains the bound.
    try {
      if (borrowed) {
        if (discard) borrowed.release(true);
        else borrowed.release();
      }
      else void standalone!.end().catch(() => {});
    } catch { /* A disposal failure cannot release a partial prediction. */ }
  };
  let rejectStop: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (reason: NonNullable<typeof terminal>) => {
    if (terminal) return;
    terminal = reason; discard = true; dispose(); rejectStop(new Error(reason));
  };
  const onAbort = () => stop("cancelled");
  const timer = setTimeout(() => stop("deadline-exceeded"), Math.max(0, deadline - performance.now()));
  signal?.addEventListener("abort", onAbort, { once: true });
  const task = (async () => {
    try {
      if (pool) borrowed = await pool.connect();
      else {
        standalone = new Client({ ...config, statement_timeout: boundedTimeout(config.statement_timeout),
          connectionTimeoutMillis: Math.max(1, Math.floor(deadline - performance.now())) });
        // pg may emit a connection error after an interrupted query settles.
        // The request promise owns its outcome; no provider error is delivered.
        standalone.on("error", () => {});
        await standalone.connect();
      }
      if (terminal) throw new Error(terminal);
      if (signal?.aborted) { stop("cancelled"); throw new Error(terminal); }
      if (performance.now() >= deadline) { stop("deadline-exceeded"); throw new Error(terminal); }
      const client = borrowed ?? standalone!;
      const result = await predictQbModel({ query: client.query.bind(client) } as Pick<Client, "query">,
        store, pins, { signal, deadlineAt: deadline });
      discard = result.connectionDisposition === "discard";
      return result;
    } finally { dispose(); }
  })();
  try {
    const result = await Promise.race([task, stopped]);
    if (signal?.aborted) stop("cancelled");
    else if (performance.now() >= deadline) stop("deadline-exceeded");
    return terminal ? unavailable(terminal) : result;
  } catch (error) {
    return unavailable(terminal ?? (connectionInterrupted(error) ? "connection-interrupted" : "prediction-unavailable"));
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
    if (terminal) { discard = true; dispose(); }
  }
};
