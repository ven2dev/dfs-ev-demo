import assert from "node:assert/strict";
import { capacityHash, validateCapacityManifest, type CapacityManifest } from "./prediction-capacity-workload.ts";
import type { CapacitySample } from "./prediction-capacity-process.ts";
import type { ReadCounters } from "../../tests/feature-store/artifact-read-work.ts";

export const CAPACITY_ORDER = ["C1", "W1", "C2", "W2", "C3", "W3"];
const expectedWork = { sql: 3, checks: 2, gets: 1, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 };
export const capacityP95 = (values: number[]) => {
  assert(values.length && values.every(v => Number.isFinite(v) && v >= 0), "capacity-invalid-duration");
  return [...values].sort((a, b) => a - b)[Math.ceil(.95 * values.length) - 1];
};
export const capacityTrial = (samples: CapacitySample[], name: string) => {
  const p95Ms = capacityP95(samples.map(s => s.totalMs));
  return { name, attempts: samples.length, available: samples.filter(s => s.verdict === "pass").length,
    p95Ms, headroom: 1 - p95Ms / 300, maximumMs: Math.max(...samples.map(s => s.totalMs)),
    startupP95Ms: capacityP95(samples.map(s => s.startupMs)),
    meanSetupShare: samples.reduce((sum, s) => sum + s.startupMs / s.totalMs, 0) / samples.length,
    pass: samples.length === 100 && samples.every(s => s.verdict === "pass" && s.totalMs <= 300 && s.startupMs <= 210) && p95Ms <= 210 };
};
export type FullCapacityBenchmark = { kind: "prediction-capacity-benchmark"; schemaVersion: 1; issue: 168; step: 1 | 2;
  verdict: string; manifest: CapacityManifest; manifestSha256: string; manifestPinnedBeforeTiming: boolean;
  code: { gitSha: string; contentSha256: string }; codeHashes: Record<string, string>; codeBlobIds: Record<string, string>;
  sourceUnchanged?: boolean; samples: CapacitySample[]; trials: ReturnType<typeof capacityTrial>[];
  fixture?: { wireFiles: number; rowCount: number; contentSha256: string; strictRows: number; [key: string]: unknown };
  serverWork?: { n: number; profiles: string[]; rightsCalls: number; q1: ReadCounters; q2: ReadCounters }[];
  modelOnly?: { sql: number; gets: number };
  warmControls?: { rightsRefusal: boolean; deletionRefusal: boolean; sameProcess: boolean };
  warmControlSamples?: CapacitySample[];
  warmSetup?: Record<string, { setupMs: number; pid?: number; [key: string]: unknown }>;
  [key: string]: unknown };
const verifyCapacityInputs = (full: FullCapacityBenchmark) => {
  assert.equal(full.kind, "prediction-capacity-benchmark"); assert.equal(full.issue, 168);
  assert.equal(full.schemaVersion, 1); assert.equal(full.sourceUnchanged, true);
  const coverage = validateCapacityManifest(full.manifest);
  assert.equal(capacityHash(full.manifest), full.manifestSha256, "capacity-manifest-hash-mismatch");
  assert.equal(full.manifestPinnedBeforeTiming, true);
  assert.equal(full.code.contentSha256, capacityHash(full.codeHashes), "capacity-source-hash-mismatch");
  assert(/^[a-f0-9]{40}$/.test(full.code.gitSha));
  assert.deepEqual(Object.keys(full.codeHashes), Object.keys(full.codeBlobIds));
  for (const path of Object.keys(full.codeHashes)) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."));
    assert(/^[a-f0-9]{64}$/.test(full.codeHashes[path])); assert(/^[a-f0-9]{40}$/.test(full.codeBlobIds[path]));
  }
  for (const path of ["predict.ts", "predictionOwner.ts", "predictionClock.ts", "modelArtifacts.ts", "modelContext.ts", "predictionHelpers.ts"])
    assert(`services/pipeline/src/featureStore/${path}` in full.codeHashes, "capacity-missing-source");
  for (const path of ["prediction-benchmark.ts", "prediction-capacity-benchmark.ts", "prediction-capacity-bootstrap.mjs",
    "prediction-capacity-worker.ts", "prediction-capacity-process.ts", "prediction-capacity-workload.ts", "prediction-capacity-evidence.ts",
    "artifact-governance-evidence.ts"])
    assert(`services/pipeline/scripts/feature-store/${path}` in full.codeHashes, "capacity-missing-measurement-source");
  assert(full.fixture); assert.equal(full.fixture.wireFiles, 16); assert.equal(full.fixture.rowCount, 2504);
  assert.equal(full.fixture.strictRows, 0);
  assert.equal(full.fixture.contentSha256, "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d");
  assert.deepEqual(full.modelOnly, { sql: 2, gets: 1 });
  assert.deepEqual(full.warmControls, { rightsRefusal: true, deletionRefusal: true, sameProcess: true });
  assert.equal(full.warmControlSamples?.length, 3);
  const [before, rights, deletion] = full.warmControlSamples!;
  assert.equal(before.verdict, "pass"); assert.deepEqual(before.work, expectedWork);
  assert.equal(JSON.parse(before.serialized!).status, "available");
  assert.equal(rights.verdict, "fail"); assert.equal(deletion.verdict, "fail");
  assert.deepEqual(JSON.parse(rights.serialized!), { status: "unavailable", reason: "model-current-rights-refused" });
  assert.deepEqual(JSON.parse(deletion.serialized!), { status: "unavailable", reason: "model-read-status-refused" });
  assert.equal(before.pid, rights.pid); assert.equal(before.pid, deletion.pid);
  assert.deepEqual(full.serverWork?.map(w => w.n), full.manifest.rules.n);
  for (const probe of full.serverWork!) {
    assert(probe.profiles.length > 0 && new Set(probe.profiles).size === probe.profiles.length);
    assert.equal(probe.rightsCalls, 2 * probe.profiles.length);
    for (const counters of [probe.q1, probe.q2]) {
      assert(counters.length > 0);
      for (const r of counters) {
        assert.equal(r.inserted + r.updated + r.deleted, 0);
        if (/^(dataset_members|outcome_labels|label_inputs|norm_)/.test(r.table))
          assert(Object.entries(r).every(([key, value]) => key === "table" || value === 0), "capacity-per-row-work");
      }
    }
  }
  return coverage;
};
export const verifyCapacityControls = (full: FullCapacityBenchmark) => {
  assert.equal(full.step, 1); assert.equal(full.verdict, "controls-pass-not-qualified");
  assert.equal(full.controlsOnly, true); const coverage = verifyCapacityInputs(full);
  assert.equal(full.samples.length, 2); assert.deepEqual(full.trials, []);
  for (const [i, sample] of full.samples.entries()) {
    assert.equal(sample.temperature, i === 0 ? "cold" : "warm"); assert.equal(sample.verdict, "pass");
    assert.equal(sample.featureId, full.manifest.requests[0].featureId); assert.deepEqual(sample.work, expectedWork);
    assert.deepEqual(sample.queries?.map(q => q.kind), ["context", "check", "check"]);
    assert.equal(JSON.parse(sample.serialized!).status, "available");
  }
  return { verdict: "controls-pass-not-qualified", coverage, work: expectedWork, allN: full.serverWork!.length, speedQualified: false };
};
export const verifyCapacityBenchmark = (full: FullCapacityBenchmark, enforceSpeed = true) => {
  assert.equal(full.step, 2); assert.equal(full.verdict, "pass");
  const coverage = verifyCapacityInputs(full);
  assert.equal(full.samples.length, 600); assert.deepEqual(full.trials.map(t => t.name), CAPACITY_ORDER);
  const coldPids = new Set<number>(), warmPids = new Set<number>();
  for (const [t, name] of CAPACITY_ORDER.entries()) {
    const temperature = name.startsWith("C") ? "cold" : "warm", trial = Number(name[1]);
    const selected = full.samples.slice(t * 100, (t + 1) * 100);
    const summary = capacityTrial(selected, name); assert.deepEqual(full.trials[t], summary, "capacity-trial-recomputation");
    if (enforceSpeed) assert(summary.pass && summary.headroom >= .3, "capacity-per-trial-headroom-failed");
    const pids = new Set<number>();
    for (const [i, sample] of selected.entries()) {
      const request = full.manifest.requests[i];
      assert.equal(sample.temperature, temperature); assert.equal(sample.trial, trial); assert.equal(sample.index, i);
      assert.equal(sample.featureId, request.featureId); assert.equal(sample.n, request.n);
      assert.equal(sample.verdict, "pass"); assert(!sample.error); assert.deepEqual(sample.work, expectedWork);
      assert.deepEqual(sample.queries?.map(q => q.kind), ["context", "check", "check"]);
      assert(sample.outputBytes! > 0 && sample.pid! > 0); pids.add(sample.pid!);
      const response = JSON.parse(sample.serialized!);
      assert.equal(response.status, "available"); assert.equal(Buffer.byteLength(sample.serialized!), sample.outputBytes);
      assert.equal(response.context.feature.featureId, request.featureId); assert.equal(response.forecast.sampleCount, request.n);
      assert(!("connectionDisposition" in response));
      capacityP95([sample.totalMs, sample.spawnMs, sample.bootstrapMs, sample.importMs, sample.storeMs,
        sample.startupMs, sample.residualMs, sample.connectMs!, sample.handlerMs!, ...sample.queries!.map(q => q.elapsedMs)]);
      assert(sample.totalMs > 0 && sample.spawnMs <= sample.bootstrapMs);
      assert(Math.abs(sample.totalMs - sample.startupMs - sample.handlerMs! - sample.residualMs) < 1e-6);
      if (temperature === "cold") {
        assert(sample.bootstrapMs > 0 && sample.importMs > 0 && sample.connectMs! > 0);
        assert(Math.abs(sample.startupMs - sample.bootstrapMs - sample.importMs - sample.storeMs - sample.connectMs!) < 1e-6);
        assert(!coldPids.has(sample.pid!) && !warmPids.has(sample.pid!), "capacity-cold-process-reused"); coldPids.add(sample.pid!);
      } else {
        assert.equal(sample.startupMs + sample.spawnMs + sample.bootstrapMs + sample.importMs + sample.storeMs, 0);
        assert(!coldPids.has(sample.pid!));
      }
    }
    if (temperature === "cold") assert.equal(pids.size, 100);
    else {
      assert.equal(pids.size, 1); const pid = [...pids][0]; assert(!warmPids.has(pid)); warmPids.add(pid);
      assert.equal(full.warmSetup?.[name].pid, pid); assert(full.warmSetup![name].setupMs > 0);
    }
  }
  return { verdict: "pass", samples: 600, trials: 6, coverage, work: expectedWork,
    worstP95Ms: Math.max(...full.trials.map(t => t.p95Ms)), minimumHeadroom: Math.min(...full.trials.map(t => t.headroom)),
    allTrialsAtLeast30PercentHeadroom: full.trials.every(t => t.pass && t.headroom >= .3) };
};

export const compactCapacityBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as FullCapacityBenchmark;
  const verification = full.verdict === "pass" ? verifyCapacityBenchmark(full)
    : full.verdict === "controls-pass-not-qualified" ? verifyCapacityControls(full) : { verdict: "not-qualified" };
  const { samples, serverWork, warmControlSamples, ...metadata } = full;
  delete metadata.storageRoot; delete metadata.publication;
  return { ...metadata, fullRecord: { path, sha256: capacityHashBytes(bytes), byteSize: bytes.length },
    objectStore: { objectKey: "audits/" + capacityHashBytes(bytes), sha256: capacityHashBytes(bytes), byteSize: bytes.length },
    verification, samples: samples.map(sample => {
      const projected: Record<string, unknown> = { ...sample, queries: sample.queries?.map(q => q.kind) };
      delete projected.serialized; delete projected.stderr; return projected;
    }), serverWork: serverWork?.map(probe => ({ n: probe.n, profiles: probe.profiles, rightsCalls: probe.rightsCalls })),
    warmControlSamples: warmControlSamples?.map(sample => ({ pid: sample.pid, verdict: sample.verdict,
      status: JSON.parse(sample.serialized!).status, reason: JSON.parse(sample.serialized!).reason ?? null, work: sample.work })) };
};
// Bytes are hashed before parsing by the common evidence auditor.
import { createHash } from "node:crypto";
const capacityHashBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
