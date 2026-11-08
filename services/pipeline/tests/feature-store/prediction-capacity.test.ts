import { describe, expect, it } from "vitest";
import { CAPACITY_RULES, capacityHash, selectCapacityManifest, validateCapacityManifest,
  type CapacityManifest, type CapacityRequest } from "../../scripts/feature-store/prediction-capacity-workload.ts";
import { CAPACITY_ORDER, CAPACITY_STARTUP_GATE, capacitySampleDeadlineError, capacityTrial, compactCapacityBenchmark, verifyCapacityBenchmark, verifyCapacityControls,
  type FullCapacityBenchmark } from "../../scripts/feature-store/prediction-capacity-evidence.ts";
import { verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import type { CapacitySample } from "../../scripts/feature-store/prediction-capacity-process.ts";

const candidates = (): CapacityRequest[] => Array.from({ length: 100 }, (_, i) => ({ featureId: `feature-${i}`,
  cutoff: "2026-01-01T00:00:00Z", season: 2021 + Math.floor(i / 20), team: `team-${i % 32}`, n: 2 + i % 15,
  request: { playerId: `player-${i}`, gameId: `game-${i}`, runId: "run", knownAsOf: "2026-02-01T00:00:00Z",
    modelVersion: "empirical-integer-v1", scoringPolicy: "qb-empirical-evaluation-v1", featureVersion: FEATURE_VERSION,
    historyPolicy: HISTORY_POLICY, evidenceMode: "retrospective-reconstruction-v1", line: 225.5 } }));
// Use actual constants through the selector's policy contract.
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
const manifest = () => selectCapacityManifest(candidates());
const fullRecord = (): FullCapacityBenchmark => {
  const requests = manifest(), samples: CapacitySample[] = [], warmSetup: NonNullable<FullCapacityBenchmark["warmSetup"]> = {};
  for (const [t, name] of CAPACITY_ORDER.entries()) {
    const cold = name.startsWith("C"); if (!cold) warmSetup[name] = { pid: 10000 + t, setupMs: 50 };
    for (const [i, request] of requests.requests.entries()) {
      const serialized = JSON.stringify({ status: "available", context: { feature: { featureId: request.featureId } }, forecast: { sampleCount: request.n } });
      samples.push({ temperature: cold ? "cold" : "warm", trial: Number(name[1]), index: i, featureId: request.featureId, n: request.n,
        verdict: "pass", totalMs: cold ? 100 : 5, pid: cold ? t * 100 + i + 1 : 10000 + t,
        spawnMs: cold ? 1 : 0, bootstrapMs: cold ? 20 : 0, importMs: cold ? 40 : 0, storeMs: cold ? 2 : 0,
        connectMs: cold ? 8 : 0, handlerMs: 3, startupMs: cold ? 70 : 0, residualMs: cold ? 27 : 2,
        work: { sql: 3, checks: 2, gets: 1, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 },
        serialized, outputBytes: Buffer.byteLength(serialized), stderr: "", queries: ["context", "check", "check"].map(kind => ({ kind, elapsedMs: .5 })) });
    }
  }
  const paths = ["predict.ts", "predictionOwner.ts", "predictionClock.ts", "modelArtifacts.ts", "modelContext.ts", "predictionHelpers.ts"]
    .map(p => `services/pipeline/src/featureStore/${p}`).concat(["prediction-benchmark.ts", "prediction-capacity-benchmark.ts",
      "prediction-capacity-bootstrap.mjs", "prediction-capacity-worker.ts", "prediction-capacity-process.ts", "prediction-capacity-workload.ts",
      "prediction-capacity-evidence.ts", "artifact-governance-evidence.ts"].map(p => `services/pipeline/scripts/feature-store/${p}`));
  const codeHashes = Object.fromEntries(paths.map(p => [p, "a".repeat(64)]));
  return { kind: "prediction-capacity-benchmark", schemaVersion: 1, issue: 168, step: 2, verdict: "pass", sourceUnchanged: true,
    manifest: requests, manifestSha256: capacityHash(requests), manifestPinnedBeforeTiming: true,
    code: { gitSha: "b".repeat(40), contentSha256: capacityHash(codeHashes) }, codeHashes,
    codeBlobIds: Object.fromEntries(paths.map(p => [p, "c".repeat(40)])), samples,
    trials: CAPACITY_ORDER.map((name, i) => capacityTrial(samples.slice(i * 100, (i + 1) * 100), name)), warmSetup,
    fixture: { wireFiles: 16, rowCount: 2504, strictRows: 0, contentSha256: "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d" },
    modelOnly: { sql: 2, gets: 1 }, warmControls: { rightsRefusal: true, deletionRefusal: true, sameProcess: true },
    warmControlSamples: [samples[100], { ...samples[100], verdict: "fail", serialized: '{"status":"unavailable","reason":"model-current-rights-refused"}' },
      { ...samples[100], verdict: "fail", serialized: '{"status":"unavailable","reason":"model-read-status-refused"}' }],
    serverWork: CAPACITY_RULES.n.map(n => ({ n, profiles: Array.from({ length: 1 + n % 3 }, (_, i) => `p${i}`),
      rightsCalls: 2 * (1 + n % 3), q1: [{ table: "feature_values", seq_scan: 0, seq_tup_read: 0, idx_scan: 1,
        idx_tup_fetch: 1, inserted: 0, updated: 0, deleted: 0 }], q2: [{ table: "feature_values", seq_scan: 0,
        seq_tup_read: 0, idx_scan: 1, idx_tup_fetch: 1, inserted: 0, updated: 0, deleted: 0 }] })) };
};
const currentRecord = (): FullCapacityBenchmark => {
  const old = fullRecord(), codeHashes = { ...old.codeHashes, "packages/db/proposals/241_job_visibility.sql": "a".repeat(64) };
  return { ...old, issue: 242, schemaVersion: 2, startupGate: CAPACITY_STARTUP_GATE, codeHashes,
    code: { ...old.code, contentSha256: capacityHash(codeHashes) },
    codeBlobIds: { ...old.codeBlobIds, "packages/db/proposals/241_job_visibility.sql": "c".repeat(40) },
    trials: CAPACITY_ORDER.map((name, i) => capacityTrial(old.samples.slice(i * 100, (i + 1) * 100), name, "trial-p95-v2")) };
};
const setStartup = (sample: CapacitySample, startupMs: number) => {
  sample.importMs += startupMs - sample.startupMs; sample.startupMs = startupMs;
  // Keep phase accounting consistent, including the exact inclusive deadline.
  sample.handlerMs = Math.min(3, Math.max(0, 300 - startupMs)); sample.residualMs = 0;
  sample.totalMs = startupMs + sample.handlerMs;
};
const refreshTrials = (full: FullCapacityBenchmark) => {
  full.trials = CAPACITY_ORDER.map((name, i) => capacityTrial(full.samples.slice(i * 100, (i + 1) * 100), name,
    full.schemaVersion === 1 ? "sample-max-v1" : "trial-p95-v2"));
};

describe("#168 pinned workload", () => {
  it("is deterministic under input permutation and independently satisfies every coverage rule", () => {
    const m = manifest(), reversed = [...candidates()].reverse();
    expect(selectCapacityManifest(reversed)).toEqual(m);
    expect(Object.keys(validateCapacityManifest(m).players)).toHaveLength(100);
    expect(capacityHash(m)).toHaveLength(64);
  });
  it.each(["player-cap", "teams", "cell", "exact-n", "coordinate", "weakened-rules", "policy"])("refuses invalid %s", key => {
    const m: CapacityManifest = structuredClone(manifest());
    if (key === "player-cap") for (const r of m.requests.slice(0, 6)) r.request = { ...r.request, playerId: "same" };
    if (key === "teams") for (const r of m.requests) r.team = "same";
    if (key === "cell") for (const r of m.requests) r.season = 2021;
    if (key === "exact-n") for (const r of m.requests) if (r.n === 16) r.n = 15;
    if (key === "coordinate") m.requests[1] = m.requests[0];
    if (key === "weakened-rules") Object.assign(m.rules, { minimumPlayers: 1 });
    if (key === "policy") m.requests[0].request = { ...m.requests[0].request, evidenceMode: "strict-point-in-time-v1" };
    expect(() => validateCapacityManifest(m)).toThrow();
  });
});
describe("#168 hash-first capacity audit", () => {
  it("labels Step 1 controls explicitly and refuses to qualify their two samples as a six-trial benchmark", () => {
    const f = fullRecord(); f.step = 1; f.verdict = "controls-pass-not-qualified"; f.controlsOnly = true;
    f.samples = [f.samples[0], f.samples[100]]; f.trials = [];
    expect(verifyCapacityControls(f).speedQualified).toBe(false);
    const bytes = Buffer.from(JSON.stringify(f)); verifyEvidenceReceipt(compactCapacityBenchmark(bytes, "x.tar.gz#full.json"), bytes);
    expect(() => verifyCapacityBenchmark(f)).toThrow();
    f.serverWork![0].rightsCalls++; expect(() => verifyCapacityControls(f)).toThrow();
  });
  it("recomputes every independent trial and dynamic 2P budget from raw records", () => {
    const full = fullRecord(), bytes = Buffer.from(JSON.stringify(full));
    expect(verifyCapacityBenchmark(full, false).samples).toBe(600);
    const receipt = compactCapacityBenchmark(bytes, "records.tar.gz#full.json");
    verifyEvidenceReceipt(receipt, bytes);
    expect(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")]))).toThrow(/sha256/);
  });
  it.each(["manifest-hash", "cold-pid", "cold-definition", "schedule", "refusal", "checks", "hash-work", "rights",
    "hidden-row", "source", "model-only", "warm-status", "partial", "summary"])("detects %s tampering", kind => {
    const f = fullRecord();
    if (kind === "manifest-hash") f.manifest.requests.reverse();
    if (kind === "cold-pid") f.samples[1].pid = f.samples[0].pid;
    if (kind === "cold-definition") f.samples[0].importMs = 0;
    if (kind === "schedule") f.samples[0].index++;
    if (kind === "refusal") f.samples[0].verdict = "fail";
    if (kind === "checks") f.samples[0].work!.checks++;
    if (kind === "hash-work") f.samples[0].work!.hashes++;
    if (kind === "rights") f.serverWork![0].rightsCalls++;
    if (kind === "hidden-row") f.serverWork![0].q1[0] = { ...f.serverWork![0].q1[0], table: "norm_identity" };
    if (kind === "source") delete f.codeHashes[Object.keys(f.codeHashes)[0]];
    if (kind === "model-only") f.modelOnly!.sql++;
    if (kind === "warm-status") f.warmControls!.deletionRefusal = false;
    if (kind === "partial") f.samples[0].serialized = '{}';
    if (kind === "summary") f.trials[0].p95Ms++;
    expect(() => verifyCapacityBenchmark(f, false)).toThrow();
  });
  it("does not pool cohorts or replace refusals when enforcing synthetic speed gates", () => {
    const f = fullRecord();
    for (const s of f.samples.slice(0, 100)) { s.totalMs = 211; s.residualMs += 111; }
    f.trials[0] = capacityTrial(f.samples.slice(0, 100), "C1");
    expect(() => verifyCapacityBenchmark(f)).toThrow(/per-trial-headroom/);
    expect(verifyCapacityBenchmark(f, false).allTrialsAtLeast30PercentHeadroom).toBe(false);
    expect(() => compactCapacityBenchmark(Buffer.from(JSON.stringify(f)), "x.tar.gz#full.json")).toThrow();
  });
});

describe("#242 trial startup contract and historical compatibility", () => {
  it.each([1, 5])("accepts %i startups between 210 and 300 in one otherwise passing trial", count => {
    const f = currentRecord(); for (const s of f.samples.slice(0, count)) setStartup(s, 240);
    refreshTrials(f);
    expect(f.trials[0]).toMatchObject({ pass: true, startupP95Ms: 70, startupMaximumMs: 240 });
    expect(f.trials[0].startupTail).toHaveLength(5);
    expect(verifyCapacityBenchmark(f).allTrialsAtLeast30PercentHeadroom).toBe(true);
    const bytes = Buffer.from(JSON.stringify(f)); verifyEvidenceReceipt(compactCapacityBenchmark(bytes, "new.tar.gz#full.json"), bytes);
  });
  it("refuses a cold trial with six slow startups, without pooling other trials", () => {
    const f = currentRecord(); for (const s of f.samples.slice(0, 6)) setStartup(s, 211);
    refreshTrials(f); expect(f.trials[0]).toMatchObject({ startupP95Ms: 211, pass: false });
    expect(() => verifyCapacityBenchmark(f)).toThrow(/per-trial-headroom/);
    expect(verifyCapacityBenchmark(f, false).allTrialsAtLeast30PercentHeadroom).toBe(false);
  });
  it("accepts startup and full-path p95 exactly 210", () => {
    const f = currentRecord();
    for (const s of f.samples.slice(0, 100)) { setStartup(s, 210); s.handlerMs = 0; s.totalMs = 210; }
    refreshTrials(f); expect(f.trials[0]).toMatchObject({ startupP95Ms: 210, p95Ms: 210, pass: true });
    expect(verifyCapacityBenchmark(f).allTrialsAtLeast30PercentHeadroom).toBe(true);
  });
  it.each([300, 300.001])("checks the inclusive sample startup deadline at %s ms", startupMs => {
    const f = currentRecord(); setStartup(f.samples[0], startupMs); refreshTrials(f);
    expect(capacitySampleDeadlineError(f.samples[0])).toBe(startupMs === 300 ? undefined : "capacity-startup-deadline-exceeded");
    if (startupMs === 300) expect(verifyCapacityBenchmark(f).allTrialsAtLeast30PercentHeadroom).toBe(true);
    else expect(() => verifyCapacityBenchmark(f)).toThrow(/per-trial-headroom/);
  });
  it("independently refuses a full-path deadline miss", () => {
    const f = currentRecord(); f.samples[0].totalMs = 300.001; f.samples[0].residualMs = 227.001; refreshTrials(f);
    expect(capacitySampleDeadlineError(f.samples[0])).toBe("capacity-parent-deadline-exceeded");
    expect(() => verifyCapacityBenchmark(f)).toThrow(/per-trial-headroom/);
  });
  it.each(["maximum", "tail-duration", "tail-index", "tail-order"])("detects %s diagnostic tampering", kind => {
    const f = currentRecord(), trial = f.trials[0];
    if (kind === "maximum") trial.startupMaximumMs!++;
    if (kind === "tail-duration") trial.startupTail![0].startupMs++;
    if (kind === "tail-index") trial.startupTail![0].index++;
    if (kind === "tail-order") trial.startupTail!.reverse();
    expect(() => verifyCapacityBenchmark(f, false)).toThrow(/trial-recomputation/);
  });
  it("keeps the original per-sample 210 rule and exact summary shape for #168", () => {
    const f = fullRecord(); expect(f.trials[0]).not.toHaveProperty("startupTail");
    expect(f.trials[0]).not.toHaveProperty("startupMaximumMs");
    expect(verifyCapacityBenchmark(f).samples).toBe(600);
    setStartup(f.samples[0], 240); refreshTrials(f);
    expect(f.trials[0]).toMatchObject({ startupP95Ms: 70, pass: false });
    expect(() => verifyCapacityBenchmark(f)).toThrow(/per-trial-headroom/);
  });
  it.each(["issue", "version", "legacy-version", "rule", "limit", "tail-count", "legacy-rule"])("rejects unsupported %s", kind => {
    const f = currentRecord();
    if (kind === "issue") Object.assign(f, { issue: 168 });
    if (kind === "version") Object.assign(f, { schemaVersion: 3 });
    if (kind === "legacy-version") Object.assign(f, { schemaVersion: 1 });
    if (kind === "rule") Object.assign(f, { startupGate: { ...CAPACITY_STARTUP_GATE, rule: "sample-max" } });
    if (kind === "limit") Object.assign(f, { startupGate: { ...CAPACITY_STARTUP_GATE, p95Ms: 211 } });
    if (kind === "tail-count") Object.assign(f, { startupGate: { ...CAPACITY_STARTUP_GATE, tailSamples: 1 } });
    if (kind === "legacy-rule") Object.assign(f, { schemaVersion: 1, issue: 168 });
    expect(() => verifyCapacityBenchmark(f)).toThrow();
    f.verdict = "fail";
    expect(() => compactCapacityBenchmark(Buffer.from(JSON.stringify(f)), "x.tar.gz#full.json")).toThrow();
  });
  it("requires the loaded #241 SQL in the new source inventory", () => {
    const f = currentRecord(); delete f.codeHashes["packages/db/proposals/241_job_visibility.sql"];
    delete f.codeBlobIds["packages/db/proposals/241_job_visibility.sql"]; f.code.contentSha256 = capacityHash(f.codeHashes);
    expect(() => verifyCapacityBenchmark(f, false)).toThrow(/missing-visibility-source/);
  });
});
