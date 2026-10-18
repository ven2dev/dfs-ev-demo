import { readFile } from "node:fs/promises";
import type { Client, QueryResultRow } from "pg";
import { equalMassSupport, probabilityAt, priceSide, type SupportPoint, type Triple } from "../projection/empirical.ts";
import { MODEL_VERSION } from "../projection/baseline.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "./derived.ts";
import type { EvidenceMode } from "./asOf.ts";

export const EMPIRICAL_ADAPTER = { id: "qb-passing-yards-materialized", version: "empirical-feature-adapter-v1" } as const;
export const EMPIRICAL_DEADLINE_MS = 300;
export type EmpiricalRequest = {
  featureId: string; knownAsOf: string; line: number;
  featureVersion: typeof FEATURE_VERSION; historyPolicy: typeof HISTORY_POLICY; evidenceMode: EvidenceMode;
};
type Connection = Pick<Client, "query" | "end">;
type Stage = "authorization" | "history" | "delivery";
type RefusalReason = "invalid-request" | "unsupported-version" | "future-knowledge-as-of" | "feature-missing"
  | "feature-after-as-of" | "feature-unavailable" | "insufficient-history" | "history-limit-exceeded"
  | "invalid-history" | "target-or-future-history" | "current-rights-or-status-refused"
  | "delivery-rights-or-status-refused" | "deadline-exceeded" | "cancelled" | "connection-interrupted" | "database-unavailable";
type Feature = {
  feature_id: string; job_id: string; player_id: string; game_id: string; season: number; stat: string;
  cutoff: string; checkpoint: string; computed_at: string; feature_version: string; history_policy: string;
  evidence_mode: EvidenceMode; state: string; reasons: string[]; flags: string[]; sample_size: number;
  superseded: boolean; stale: boolean;
};
type Source = { snapshot_id: string; profile_id: string; available_at: string; ingested_at: string; evidence_basis: string };
type Decision = { profileId: string; decisionId: string };
type Access = { allowed: boolean; checked_at: string; selection_reason: RefusalReason | null;
  feature: Feature | null; snapshot_ids: string[]; lineage: Source[]; decisions: Decision[] };
type Common = { adapter: typeof EMPIRICAL_ADAPTER; rightsScope: "research"; connectionDisposition: "reusable" | "discard" };
export type EmpiricalResponse = Common & ({ status: "unavailable"; reason: RefusalReason } | {
  status: "available"; designation: "uncalibrated-interim-hit-rate"; calibration: "uncalibrated";
  modelVersion: typeof MODEL_VERSION; sampleSize: number;
  versions: { feature: typeof FEATURE_VERSION; historyPolicy: typeof HISTORY_POLICY; evidenceMode: EvidenceMode };
  feature: { id: string; jobId: string; playerId: string; gameId: string; stat: "passing_yards"; season: number };
  clocks: { knownAsOf: string; predictionCutoff: string; checkpoint: string; computedAt: string; authorizationCheckedAt: string; deliveryCheckedAt: string };
  historicalAvailability: "unverified" | "snapshot-qualified";
  freshness: { stale: boolean; superseded: boolean }; flags: string[];
  sourceLineage: { snapshotId: string; profileId: string; availableAt: string; ingestedAt: string; evidenceBasis: string }[];
  rights: { authorization: Decision[]; delivery: Decision[] };
  line: number; support: SupportPoint[]; probabilities: Triple;
  pricing: { over: ReturnType<typeof priceSide>; under: ReturnType<typeof priceSide> };
});
export type EmpiricalRead = { response: EmpiricalResponse; serialized: string;
  work: { statements: number; rightsChecks: number };
  timingMs: { authorization: number; history: number; calculation: number; delivery: number; serialization: number; total: number } };
type Options = { signal?: AbortSignal; deadlineAt?: number };

class Refusal extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason) { super(reason); this.reason = reason; }
}
// Preserve PostgreSQL microseconds rather than making two nearby instants equal
// through Date.parse's millisecond truncation. Knowledge timestamps stay verbatim.
const micros = (value: unknown): bigint | null => {
  if (typeof value !== "string") return null;
  const match = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  const milliseconds = Date.parse(value);
  return match && Number.isFinite(milliseconds)
    ? BigInt(milliseconds) * BigInt(1000) + BigInt((match[1] ?? "").padEnd(6, "0").slice(3)) : null;
};
const requestReason = (request: EmpiricalRequest): RefusalReason | null => {
  if (!request || typeof request.featureId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request.featureId)
    || micros(request.knownAsOf) === null || !Number.isFinite(request.line)) return "invalid-request";
  if (request.featureVersion !== FEATURE_VERSION || request.historyPolicy !== HISTORY_POLICY
    || !["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(request.evidenceMode)) return "unsupported-version";
  return null;
};
const qualifiedValues = (history: unknown, feature: Feature): number[] => {
  if (!Array.isArray(history)) throw new Refusal("invalid-history");
  if (history.length < 2) throw new Refusal("insufficient-history");
  if (history.length > 16) throw new Refusal("history-limit-exceeded");
  if (history.length !== feature.sample_size) throw new Refusal("invalid-history");
  const cutoff = micros(feature.cutoff);
  if (cutoff === null) throw new Refusal("invalid-history");
  const seen = new Set<string>();
  return history.map(row => {
    if (!row || typeof row.gameId !== "string" || !row.gameId || seen.has(row.gameId)
      || !Number.isSafeInteger(row.yards)) throw new Refusal("invalid-history");
    seen.add(row.gameId);
    const kickoff = micros(row.kickoff);
    if (kickoff === null) throw new Refusal("invalid-history");
    if (row.gameId === feature.game_id || kickoff >= cutoff) throw new Refusal("target-or-future-history");
    return row.yards;
  });
};

/**
 * Load code-owned SQL at setup, outside request timing. Each call borrows an
 * exclusive, connected, non-pipelined Client: sharing one can queue unrelated
 * work across authorization boundaries. Interrupted clients are ended, so the
 * caller replaces them instead of returning them to service.
 */
export const createEmpiricalAdapter = async () => {
  const [authorizeSql, historySql] = await Promise.all([
    readFile(new URL("../../../db/proposals/163_empirical_authorize.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../db/proposals/163_empirical_history.sql", import.meta.url), "utf8"),
  ]);
  return async (client: Connection, request: EmpiricalRequest, options: Options = {}): Promise<EmpiricalRead> => {
    const started = performance.now();
    const deadline = Math.min(started + EMPIRICAL_DEADLINE_MS, options.deadlineAt ?? Infinity);
    const work = { statements: 0, rightsChecks: 0 };
    const timingMs = { authorization: 0, history: 0, calculation: 0, delivery: 0, serialization: 0, total: 0 };
    let inFlight = false;
    let interrupted: "deadline-exceeded" | "cancelled" | undefined;
    let ending: Promise<void> | undefined;
    const discard = () => { ending ??= client.end().catch(() => {}); };
    const interrupt = (reason: typeof interrupted) => { interrupted = reason; if (inFlight) discard(); };
    const onAbort = () => interrupt("cancelled");
    const remaining = () => {
      if (options.signal?.aborted) throw new Refusal("cancelled");
      if (interrupted) throw new Refusal(interrupted);
      const ms = Math.floor(deadline - performance.now());
      if (ms <= 0) throw new Refusal("deadline-exceeded");
      return ms;
    };
    const response = (body: EmpiricalResponse): EmpiricalRead => {
      const begin = performance.now();
      const serialized = JSON.stringify(body);
      timingMs.serialization += performance.now() - begin;
      timingMs.total = performance.now() - started;
      return { response: body, serialized, work, timingMs };
    };
    const common = (): Common => ({ adapter: EMPIRICAL_ADAPTER, rightsScope: "research", connectionDisposition: ending ? "discard" : "reusable" });
    const invalid = requestReason(request);
    if (invalid || (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)))
      return response({ ...common(), status: "unavailable", reason: invalid ?? "invalid-request" });
    const timer = setTimeout(() => interrupt("deadline-exceeded"), Math.max(0, deadline - performance.now()));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const query = async <T extends QueryResultRow>(text: string, values: unknown[], stage: Stage) => {
      const config = { text, values, query_timeout: remaining() };
      work.statements++; if (stage !== "history") work.rightsChecks++;
      const begin = performance.now(); inFlight = true;
      try { return (await client.query<T>(config)).rows[0]; }
      finally { inFlight = false; timingMs[stage] += performance.now() - begin; }
    };
    const access = async (stage: "authorization" | "delivery", snapshots: string[] | null) => {
      const result = await query<Access>(authorizeSql, [request.featureId, request.knownAsOf, request.featureVersion,
        request.historyPolicy, request.evidenceMode, snapshots], stage);
      remaining();
      if (result?.selection_reason) throw new Refusal(result.selection_reason);
      if (!result?.allowed || !result.feature) throw new Refusal(stage === "delivery" ? "delivery-rights-or-status-refused" : "current-rights-or-status-refused");
      return result as Access & { feature: Feature };
    };
    try {
      remaining();
      const authorization = await access("authorization", null);
      const materialized = await query<{ history: unknown }>(historySql, [request.featureId], "history");
      remaining();
      if (!materialized) throw new Refusal("feature-missing");
      const calculationStarted = performance.now();
      const values = qualifiedValues(materialized.history, authorization.feature);
      const support = equalMassSupport(values);
      const probabilities = probabilityAt(support, request.line)!;
      const pricing = { over: priceSide(probabilities, "over"), under: priceSide(probabilities, "under") };
      timingMs.calculation = performance.now() - calculationStarted;
      const delivery = await access("delivery", authorization.snapshot_ids);
      const f = delivery.feature;
      const flags = [...new Set([...f.flags,
        ...(request.evidenceMode === "retrospective-reconstruction-v1" ? ["historical-availability-unverified"] : []),
        ...(f.stale ? ["stale-feature"] : []), ...(f.superseded ? ["superseded-feature"] : [])])].sort();
      const available: EmpiricalResponse = { ...common(), status: "available", designation: "uncalibrated-interim-hit-rate", calibration: "uncalibrated",
        modelVersion: MODEL_VERSION, sampleSize: values.length,
        versions: { feature: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: request.evidenceMode },
        feature: { id: f.feature_id, jobId: f.job_id, playerId: f.player_id, gameId: f.game_id, stat: "passing_yards", season: f.season },
        clocks: { knownAsOf: request.knownAsOf, predictionCutoff: f.cutoff, checkpoint: f.checkpoint, computedAt: f.computed_at,
          authorizationCheckedAt: authorization.checked_at, deliveryCheckedAt: delivery.checked_at },
        historicalAvailability: request.evidenceMode === "retrospective-reconstruction-v1" ? "unverified" : "snapshot-qualified",
        freshness: { stale: f.stale, superseded: f.superseded }, flags,
        sourceLineage: delivery.lineage.map(s => ({ snapshotId: s.snapshot_id, profileId: s.profile_id, availableAt: s.available_at,
          ingestedAt: s.ingested_at, evidenceBasis: s.evidence_basis })),
        rights: { authorization: authorization.decisions, delivery: delivery.decisions }, line: request.line, support, probabilities, pricing };
      remaining();
      const result = response(available);
      remaining(); // Withhold a response whose own serialization exhausted the budget.
      return result;
    } catch (error) {
      let reason: RefusalReason;
      if (error instanceof Refusal) reason = error.reason;
      else {
        discard();
        const code = (error as { code?: string }).code;
        reason = interrupted ?? (/Query read timeout/.test(String(error)) || code === "57014" ? "deadline-exceeded"
          : /Connection (terminated|closed)|ECONNRESET|EPIPE/.test(String(error)) || code?.startsWith("08") ? "connection-interrupted" : "database-unavailable");
      }
      await ending;
      return response({ ...common(), status: "unavailable", reason });
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
    }
  };
};
