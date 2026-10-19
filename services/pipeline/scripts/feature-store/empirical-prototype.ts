import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { equalMassSupport, probabilityAt, priceSide } from "../../../../packages/domain/src/projection/empirical.ts";
import { MODEL_VERSION } from "../../../../packages/domain/src/projection/baseline.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";

// Spike only: full version/refusal/deadline integration is the next approved step.
// No application route imports this prototype.
export type ProbeRequest = { featureId: string; knownAsOf: string; line: number };
export type ProbeSql = { authorize: string; history: string };
type Access = {
  allowed: boolean; checked_at: string; snapshot_ids: string[]; lineage: unknown[]; decisions: unknown[];
  feature: { feature_id: string; game_id: string; sample_size: number; cutoff: string; flags: string[] };
};
type History = { gameId: string; kickoff: string; yards: number }[];
export type ProbeTiming = { connection: number; authorization: number; history: number; calculation: number; recheck: number; serialization: number; request: number };

export const loadProbeSql = async (): Promise<ProbeSql> => ({
  authorize: await readFile(new URL("../../../../packages/db/proposals/163_empirical_authorize.sql", import.meta.url), "utf8"),
  history: await readFile(new URL("../../../../packages/db/proposals/163_empirical_history.sql", import.meta.url), "utf8"),
});

export const prototypePrediction = async (client: Pick<Client, "query">, sql: ProbeSql, request: ProbeRequest,
  started = performance.now(), connectionMs = 0) => {
  const timing: ProbeTiming = { connection: connectionMs, authorization: 0, history: 0, calculation: 0, recheck: 0, serialization: 0, request: 0 };
  const work = { statements: 0, rightsChecks: 0, rawEvidenceReads: 0, perRowValidationReads: 0 };
  const query = async <T extends import("pg").QueryResultRow>(text: string, values: unknown[], stage: "authorization" | "history" | "recheck") => {
    const remaining = Math.floor(300 - (performance.now() - started));
    if (remaining <= 0) throw new Error("prototype-deadline-refused");
    const begin = performance.now();
    work.statements++;
    if (stage !== "history") work.rightsChecks++;
    const queryConfig = { text, values, query_timeout: remaining };
    const result = await client.query<T>(queryConfig);
    timing[stage] = performance.now() - begin;
    return result.rows[0];
  };
  const values = [request.featureId, request.knownAsOf, FEATURE_VERSION, HISTORY_POLICY, "retrospective-reconstruction-v1"];
  const authorization = await query<Access>(sql.authorize, [...values, null], "authorization");
  if (!authorization?.allowed) throw new Error("prototype-authorization-refused");
  const materialized = await query<{ history: History }>(sql.history, [request.featureId], "history");
  if (!materialized || materialized.history.length !== authorization.feature.sample_size) throw new Error("prototype-feature-missing");
  const calculationStarted = performance.now();
  const support = equalMassSupport(materialized.history.map(row => row.yards));
  const probabilities = probabilityAt(support, request.line)!;
  const pricing = { over: priceSide(probabilities, "over"), under: priceSide(probabilities, "under") };
  timing.calculation = performance.now() - calculationStarted;
  const delivery = await query<Access>(sql.authorize, [...values, authorization.snapshot_ids], "recheck");
  if (!delivery?.allowed) throw new Error("prototype-delivery-refused");
  const output = { status: "available", adapterVersion: "empirical-materialized-prototype-v0", rightsScope: "research",
    designation: "uncalibrated-interim-hit-rate", calibrated: false, modelVersion: MODEL_VERSION,
    sampleSize: materialized.history.length, feature: delivery.feature, knownAsOf: request.knownAsOf, line: request.line,
    support, probabilities, pricing, lineage: delivery.lineage,
    authorization: { checkedAt: authorization.checked_at, decisions: authorization.decisions },
    delivery: { checkedAt: delivery.checked_at, decisions: delivery.decisions } };
  const serializationStarted = performance.now();
  const serialized = JSON.stringify(output);
  timing.serialization = performance.now() - serializationStarted;
  timing.request = performance.now() - started;
  if (timing.request > 300) throw new Error("prototype-deadline-refused");
  return { serialized, timing, work };
};
