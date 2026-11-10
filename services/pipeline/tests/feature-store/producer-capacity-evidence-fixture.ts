import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { PRODUCER_CAPACITY_SOURCES } from "../../scripts/feature-store/producer-capacity-runtime.ts";
import { attemptId, capacitySchedule, clockOffset, FEATURE_OUTPUT_SHA256, PRODUCER_CAPACITY_FORMAT, producerAttemptVerdict,
  type Attempt, type SourcePin } from "../../scripts/feature-store/producer-capacity-contract.ts";
import type { ProducerBenchmark } from "../../scripts/feature-store/producer-capacity-evidence.ts";

const at = "2026-11-09T04:00:00.000Z", capacity = 2_147_483_648;
const disk = { at, mountBytes: capacity, usedBytes: 50_000_000, availableBytes: capacity - 50_000_000, walBytes: 16_777_216, tempFiles: [], databases: [] };
const clock = clockOffset(Array.from({ length: 10 }, () => ({ hostBeforeMs: 1, hostAfterMs: 3, databaseMs: 2 })));
const pins: SourcePin[] = JSON.parse(readFileSync(new URL("../../../../docs/evidence/feature-store-138/step-3-source-manifest.json", import.meta.url), "utf8")).assets
  .map(({ asset }: SourcePin) => ({ asset, key: "raw/" + asset.sha256 })).sort((a: SourcePin, b: SourcePin) =>
    a.asset.feed === "schedules" ? -1 : b.asset.feed === "schedules" ? 1 : a.asset.name.localeCompare(b.asset.name));

// Actual text bytes for source-address tests; all timings/outcomes are synthetic.
// This fixture performs no producer work, network transfer or database access.
export const producerEvidenceFixture = (): ProducerBenchmark => {
  const sources: Record<string, string> = {};
  const migrations = JSON.parse(readFileSync(new URL("../../../../packages/db/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { filename: string; version: number }[] };
  const source = [...new Set([...PRODUCER_CAPACITY_SOURCES, ...migrations.migrations.flatMap(m =>
    ["packages/db/migrations/" + m.filename, "packages/db/catalog-contracts/" + String(m.version).padStart(4, "0") + ".json"])])].sort().map(path => {
    const bytes = readFileSync(new URL("../../../../" + path, import.meta.url)); sources[path] = bytes.toString("base64");
    return { path, sha256: sha256(bytes), gitBlobId: createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") };
  });
  const inventory = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from(JSON.stringify(source))), source };
  const full: ProducerBenchmark = { kind: "producer-capacity-benchmark", issue: 169, schemaVersion: 1, events: [], records: {
    "run-started.json": { format: PRODUCER_CAPACITY_FORMAT, issue: 169, source: inventory, at, runtime: "v24.18.1", loader: "Node 24 native type stripping",
      lane: "lane-3", tier: "large", port: 54349, parentPid: 999, schedule: capacitySchedule(), quietWindow: "synthetic control only" },
    "run-ended.json": { format: PRODUCER_CAPACITY_FORMAT, issue: 169, at, verdict: "pass", completed: 30, containerAbsent: true },
    "source-ended.json": inventory, "sources.json": sources, "inputs.json": { pins },
  } };
  const preflight = { diskPreflight: { project: "dfs-ev-demo-test-lane-3", tier: "large", capacityBytes: capacity,
    requiredFreeBytes: 608 * 1024 ** 2, availableBytes: capacity - disk.usedBytes, retainedWalBytes: disk.walBytes } };
  for (const [index, c] of capacitySchedule().entries()) {
    const id = attemptId(c), feature = c.workload === "features-2025", selected = feature ? pins : pins.filter(p => p.asset.name === c.workload);
    if (c.temperature === "cold") {
      const base = `${c.workload}-b${c.block}`;
      full.records[base + ".json"] = { clock, container: (index + 1).toString(16).padStart(64, "0"), identity: { started: at, version: "PostgreSQL 18 test" },
        admission: disk, restart: "new server once before this cold/warm block" };
      full.records[base + ".down.json"] = { at, containerAbsent: true };
    }
    const a: Attempt = { ...c, id, clock, admissionUsedBytes: disk.usedBytes, disk: [disk, disk, disk, disk],
      preparation: feature ? pins.map(p => ({ name: p.asset.name, sha256: p.asset.sha256!, sql: 12 })) : [],
      cleanup: { verified: true, deleted: true, objects: selected.map(p => ({ key: p.key, sha256: p.asset.sha256!, byteSize: p.asset.wire_bytes })) },
      measurement: { totalMs: 1000, liveMs: feature ? 0 : 400, pinnedMs: feature ? 0 : 600, startupMs: c.temperature === "cold" ? 30 : 0,
        spawnMs: 1, bootstrapMs: 5, importMs: 10, connectMs: 5, setupMs: c.temperature === "warm" ? 30 : 0, pid: 1000 + index, censored: false,
        result: { status: "completed", handlerMs: 500, sql: Array.from({ length: feature ? 8 : 12 }, (_, i) =>
          ({ index: i + 1, sqlSha256: "a".repeat(64), kind: "synthetic statement", elapsedMs: 1, status: "completed" })) } } };
    const r = a.measurement.result!;
    if (feature) {
      r.features = { status: "succeeded", jobId: "job-" + index, rows: 1948, materializations: 1, perExampleQueries: 0, sourceByteReads: 0 };
      a.featureParity = { rows: 1948, lineage: 31168, historicalFlags: true, sha256: FEATURE_OUTPUT_SHA256 };
      a.diagnostics = { before: { checkpointer: { num_timed: 0 }, wal: { wal_bytes: "1" }, tables: [] },
        after: { checkpointer: { num_timed: 1 }, wal: { wal_bytes: "2" }, tables: [] }, autovacuum: [{ at, activity: [] }, { at, activity: [] }] };
      full.records[id + ".preparation-preflight.json"] = structuredClone(preflight);
    } else {
      const p = selected[0];
      r.ingestion = { status: "ingested", wireBytes: p.asset.wire_bytes, sha256: p.asset.sha256!, bulkInserts: 1 };
      r.loopback = { kind: "test-only-loopback", origin: "http://127.0.0.1:12345", pathname: "/fixture/0", sourceUrl: p.asset.url,
        key: p.key, sha256: p.asset.sha256!, wireBytes: p.asset.wire_bytes, reads: 1, requests: 1 };
      r.live = { status: "completed", elapsedMs: 200, expected: { wire_bytes: p.asset.wire_bytes, sha256: p.asset.sha256, provider_digest: p.asset.provider_digest },
        observed: { wireBytes: p.asset.wire_bytes, sha256: p.asset.sha256! },
        requests: [{ host: "github.com", status: 302, contentLength: null }, { host: "release-assets.githubusercontent.com", status: 200, contentLength: p.asset.wire_bytes }],
        redirects: 1, error: null, changed: { wireBytes: false, sha256: false, providerDigest: p.asset.provider_digest === null ? null : false } };
    }
    full.records[id + ".started.json"] = { ...c, id, at, clock };
    full.records[id + ".context.json"] = { database: "dfs_ev_test_" + (index + 1).toString(16).padStart(20, "0"),
      user: "fs138_job_" + (index + 1).toString(16).padStart(16, "0"), destination: id + "-objects", initialRawObjects: 0 };
    full.records[id + ".measurement.json"] = a.measurement;
    full.records[id + ".diagnostics.json"] = { ...(a.diagnostics ? { diagnostics: a.diagnostics } : {}), disk: a.disk };
    full.records[id + ".preparation-disk.json"] = [disk, disk];
    full.records[id + ".fixture-preflight.json"] = structuredClone(preflight); full.records[id + ".work-preflight.json"] = structuredClone(preflight);
    if (c.temperature === "warm") {
      const { setupMs, pid, spawnMs, bootstrapMs, importMs, connectMs } = a.measurement;
      full.records[id + ".setup.json"] = { setupMs, pid, spawnMs, bootstrapMs, importMs, connectMs };
    }
    full.records[id + ".result.json"] = { ...a, verdict: producerAttemptVerdict(a) };
    const event = (value: Record<string, unknown> & { kind: string }) => full.events.push({ id, at, ...structuredClone(value) });
    event({ kind: "bootstrap", pid: a.measurement.pid }); event({ kind: "ready", importMs: 10, connectMs: 5 });
    if (!feature) event({ kind: "live-complete", live: r.live });
    for (const q of r.sql) { event({ kind: "statement", statement: { ...q, status: "running", elapsedMs: 0 } }); event({ kind: "statement", statement: q }); }
    const { live: _live, ...worker } = r; void _live; event({ kind: "result", result: worker });
  }
  return JSON.parse(JSON.stringify(full)) as ProducerBenchmark;
};

export const stopProducerEvidence = (full: ProducerBenchmark, index: number) => {
  const ids = capacitySchedule().slice(0, index + 1).map(attemptId), blocks = new Set(capacitySchedule().slice(0, index + 1).map(c => `${c.workload}-b${c.block}`));
  for (const c of capacitySchedule().slice(index + 1)) for (const name of Object.keys(full.records)) if (name.startsWith(attemptId(c) + ".")) delete full.records[name];
  for (const c of capacitySchedule()) {
    const base = `${c.workload}-b${c.block}`;
    if (!blocks.has(base)) { delete full.records[base + ".json"]; delete full.records[base + ".down.json"]; }
  }
  delete full.records["source-ended.json"];
  full.records["run-ended.json"] = { format: PRODUCER_CAPACITY_FORMAT, issue: 169, verdict: "fail", completed: index + 1, containerAbsent: true, error: "synthetic stop" };
  full.events = full.events.filter(e => ids.includes(e.id));
};
