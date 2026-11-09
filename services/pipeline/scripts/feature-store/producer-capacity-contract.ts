import type { LiveDownloadReceipt } from "./live-download.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";

export const PRODUCER_CAPACITY_FORMAT = "producer-capacity-v1";
export const REPRESENTATIVES = ["games.csv.gz", "stats_player_week_2025.csv.gz", "roster_weekly_2021.csv", "pbp_participation_2023.csv"] as const;
export const DISK_GROWTH_BYTES = 489_472_000;
export const FEATURE_OUTPUT_SHA256 = "315806925202863e226a4a93f5d477b8a6d32cd38c5a4977a1d98f889bf242a9";
export type Coordinate = { workload: string; block: number; temperature: "cold" | "warm" };
export const attemptId = (c: Coordinate) => `${c.workload}-b${c.block}-${c.temperature}`;
export const capacitySchedule = (): Coordinate[] => [...REPRESENTATIVES, "features-2025"].flatMap(workload =>
  [1, 2, 3].flatMap(block => (["cold", "warm"] as const).map(temperature => ({ workload, block, temperature }))));

export type ClockObservation = { hostBeforeMs: number; hostAfterMs: number; databaseMs: number };
export const clockOffset = (observations: ClockObservation[]) => {
  if (observations.length !== 10 || observations.some(o =>
    ![o.hostBeforeMs, o.hostAfterMs, o.databaseMs].every(Number.isFinite) || o.hostAfterMs < o.hostBeforeMs))
    throw new Error("capacity-clock-observations-refused");
  const values = observations.map(o => ({ ...o, offsetMs: o.databaseMs - (o.hostBeforeMs + o.hostAfterMs) / 2,
    lowerMs: o.databaseMs - o.hostAfterMs - 1, upperMs: o.databaseMs - o.hostBeforeMs + 1 }));
  return { toleranceMs: 250, observations: values, pass: values.every(o => Math.abs(o.offsetMs) <= 250) };
};
export type ClockPreflight = ReturnType<typeof clockOffset>;
export type StatementTime = { index: number; sqlSha256: string; kind: string; elapsedMs: number; status: "running" | "completed" | "failed" };
export type LoopbackEvidence = { kind: "test-only-loopback"; origin: string; pathname: string; sourceUrl: string;
  key: string; sha256: string; wireBytes: number; reads: number; requests: number };
export type WorkerResult = {
  status: "completed" | "failed"; error?: string; sql: StatementTime[]; handlerMs: number;
  live?: LiveDownloadReceipt; loopback?: LoopbackEvidence;
  ingestion?: { status: string; wireBytes: number; sha256: string; bulkInserts: number };
  features?: { status: string; jobId: string; rows: number; materializations: number; perExampleQueries: number; sourceByteReads: number };
};
export type ProcessMeasurement = { totalMs: number; liveMs: number; pinnedMs: number; startupMs: number;
  spawnMs: number; bootstrapMs: number; importMs: number; connectMs: number; setupMs: number;
  pid?: number; backendPid?: number; censored: boolean; error?: string; sqlState?: string; result?: WorkerResult };
export type Cleanup = { objects: { key: string; sha256: string; byteSize: number }[]; verified: boolean; deleted: boolean };
export type DiskSample = { at: string; mountBytes: number; usedBytes: number; availableBytes: number;
  walBytes: number; tempFiles: unknown[]; databases: unknown[] };
export type Diagnostics = { before: Record<string, unknown>; after: Record<string, unknown>;
  autovacuum: { at: string; activity: Record<string, unknown>[] }[] };
export type Attempt = Coordinate & { id: string; clock: ClockPreflight; measurement: ProcessMeasurement;
  cleanup: Cleanup; disk: DiskSample[]; admissionUsedBytes: number; preparation: { name: string; sha256: string; sql: number }[];
  featureParity?: { rows: number; lineage: number; historicalFlags: boolean; sha256: string }; diagnostics?: Diagnostics };
const finite = (values: number[]) => values.every(n => Number.isFinite(n) && n >= 0);

// This is the sole capacity verdict, reused by the runner and hash-first auditor.
// Unknown/incomplete records cannot qualify; diagnostics never affect speed gates.
export const producerAttemptVerdict = (a: Attempt) => {
  const m = a.measurement, r = m.result, feature = a.workload === "features-2025";
  const errors: string[] = [];
  if (!a.clock.pass) errors.push("environment-clock-offset");
  if (m.censored || m.error || r?.error || r?.status !== "completed") errors.push("failed-or-censored");
  if (!finite([m.totalMs, m.liveMs, m.pinnedMs, m.startupMs, m.setupMs])) errors.push("invalid-timing");
  if (feature ? m.totalMs > 120_000 : m.liveMs > 60_000 || m.pinnedMs > 60_000) errors.push("deadline");
  if (m.totalMs > (feature ? 84_000 : 42_000)) errors.push("capacity-target");
  if (!feature && Math.abs(m.totalMs - m.liveMs - m.pinnedMs) > 1e-6) errors.push("pair-arithmetic");
  if (r?.sql.length !== (feature ? 8 : 12) || r.sql.some((q, i) => q.index !== i + 1 || q.status !== "completed" || !finite([q.elapsedMs]))) errors.push("sql-budget");
  if (!a.cleanup.verified || !a.cleanup.deleted) errors.push("raw-cleanup");
  if (!a.disk.length || a.disk.some(d => d.mountBytes !== 2_147_483_648 || !finite([d.usedBytes, d.availableBytes]) ||
    d.usedBytes - a.admissionUsedBytes > DISK_GROWTH_BYTES)) errors.push("disk-requalification-required");
  if (feature) {
    const f = r?.features, p = a.featureParity;
    if (f?.status !== "succeeded" || f.rows !== 1948 || f.materializations !== 1 || f.perExampleQueries !== 0 || f.sourceByteReads !== 0 ||
      p?.rows !== 1948 || p.lineage !== 31168 || !p.historicalFlags || p.sha256 !== FEATURE_OUTPUT_SHA256) errors.push("feature-work-or-parity");
    if (a.preparation.length !== 16 || a.preparation.some(p => p.sql !== 12)) errors.push("feature-preparation");
  } else {
    const l = r?.loopback, i = r?.ingestion;
    if (r?.live?.status !== "completed") errors.push("live-transfer");
    if (!l || l.kind !== "test-only-loopback" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(l.origin) || !/^\/fixture\/\d+$/.test(l.pathname) ||
      l.reads !== 1 || l.requests !== 1 || l.key !== "raw/" + l.sha256 || i?.status !== "ingested" ||
      i.sha256 !== l.sha256 || i.wireBytes !== l.wireBytes || i.bulkInserts !== 1 ||
      !a.cleanup.objects.some(o => o.key === l.key && o.byteSize === l.wireBytes && o.sha256 === l.sha256)) errors.push("pinned-ingestion");
  }
  return { pass: errors.length === 0, errors };
};

export type SourcePin = { asset: SourceAsset; key: string };
