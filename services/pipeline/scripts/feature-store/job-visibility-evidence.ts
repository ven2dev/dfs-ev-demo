import assert from "node:assert/strict";
import { sha256 } from "../../src/featureStore/objectStore.ts";

export type VisibilitySample = { gate: "producer" | "dataset" | "reader"; arm: "baseline" | "candidate";
  block: number; position: number; temperature?: "cold" | "warm"; n?: number; featureId?: string;
  elapsedMs: number; setupMs: number; sql: number; checks: number; gets: number; status: string;
  contentSha256?: string; rowCount?: number; verdict: string };
export const visibilityP95 = (values: number[]) => {
  assert(values.length && values.every(n => Number.isFinite(n) && n >= 0), "invalid visibility samples");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
};
export const visibilityCohorts = (samples: VisibilitySample[]) => [1, 2, 3].flatMap(block =>
  (["cold", "warm"] as const).map(temperature => {
    const rows = samples.filter(s => s.gate === "reader" && s.block === block && s.temperature === temperature);
    const candidate = rows.filter(s => s.arm === "candidate"), baseline = rows.filter(s => s.arm === "baseline");
    const p95Ms = visibilityP95(candidate.map(s => s.elapsedMs));
    return { block, temperature, samples: candidate.length, baselineSamples: baseline.length, p95Ms,
      baselineP95Ms: visibilityP95(baseline.map(s => s.elapsedMs)), headroom: 1 - p95Ms / 300,
      setupP95Ms: visibilityP95(candidate.map(s => s.setupMs)),
      aggregateSetupShare: candidate.reduce((sum, s) => sum + s.setupMs, 0) / candidate.reduce((sum, s) => sum + s.elapsedMs, 0) };
  }));
export type VisibilityBenchmark = { issue: 241; step: 4; kind: "point-in-time-completion-benchmark";
  verdict: string; samples: VisibilitySample[]; cohorts: ReturnType<typeof visibilityCohorts>;
  requests: { values: { featureId: string; n: number }[]; sha256: string };
  fixture: { naturalKeys: number; retrospectiveRows: number; strictRows: number; contentSha256: string; wireFiles: number };
  sourceHashes: Record<string, string>; sourceBlobIds: Record<string, string>; sourceUnchanged: boolean;
  [key: string]: unknown };

// Called only after the containing auditor has checked the uncompressed hash.
// Reconstruct from individual raw observations, not the runner's verdicts.
export const visibilityProjection = (full: VisibilityBenchmark) => {
  assert.equal(full.verdict, "pass"); assert.equal(full.sourceUnchanged, true);
  assert.deepEqual(Object.keys(full.sourceHashes).sort(), Object.keys(full.sourceBlobIds).sort());
  assert(Object.keys(full.sourceHashes).length > 0);
  assert.equal(full.fixture.wireFiles, 16); assert.equal(full.fixture.naturalKeys, 9381);
  assert.equal(full.fixture.retrospectiveRows, 2504); assert.equal(full.fixture.strictRows, 0);
  assert.equal(full.fixture.contentSha256, "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d");
  assert.equal(sha256(Buffer.from(JSON.stringify(full.requests.values))), full.requests.sha256);
  assert.deepEqual(full.requests.values.map(r => r.n), Array.from({ length: 15 }, (_, i) => i + 2));
  const seen = new Set<string>();
  for (const s of full.samples) {
    const id = JSON.stringify([s.gate, s.arm, s.block, s.temperature, s.position]);
    assert(!seen.has(id), "duplicate visibility sample"); seen.add(id);
    assert.equal(s.verdict, "pass"); assert.equal(s.status, "available");
    assert(Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0 && s.setupMs >= 0 && s.setupMs <= s.elapsedMs);
    assert(["baseline", "candidate"].includes(s.arm));
    assert.equal(s.sql, s.gate === "reader" ? 3 : 8);
    assert.equal(s.checks, s.gate === "producer" ? 0 : 2);
    assert.equal(s.gets, 0);
    if (s.gate === "reader") {
      assert([1, 2, 3].includes(s.block)); assert(["cold", "warm"].includes(s.temperature!));
      assert(s.position >= 0 && s.position < 100);
      const pin = full.requests.values[s.position % 15];
      assert.equal(s.n, pin.n); assert.equal(s.featureId, pin.featureId);
    } else {
      assert(s.elapsedMs <= (s.gate === "producer" ? 84_000 : 21_000), "absolute visibility gate");
      assert.equal(s.rowCount, s.gate === "producer" ? 1948 : 2504);
      if (s.gate === "dataset") assert.equal(s.contentSha256, full.fixture.contentSha256);
    }
  }
  const producer = full.samples.filter(s => s.gate === "producer");
  assert.equal(producer.length, 4); assert(producer.every(s => s.arm === "candidate"));
  assert.deepEqual(producer.map(s => s.position), [0, 1, 2, 3]);
  const dataset = full.samples.filter(s => s.gate === "dataset"); assert.equal(dataset.length, 12);
  for (const block of [1, 2, 3]) assert.deepEqual(dataset.filter(s => s.block === block).map(s => s.arm), ["baseline", "candidate", "candidate", "baseline"]);
  assert.equal(full.samples.length, 1216);
  const cohorts = visibilityCohorts(full.samples); assert.deepEqual(full.cohorts, cohorts);
  for (const c of cohorts) {
    assert.equal(c.samples, 100); assert.equal(c.baselineSamples, 100); assert(c.p95Ms <= 210);
    for (const arm of ["baseline", "candidate"]) assert.deepEqual([...new Set(full.samples.filter(s => s.gate === "reader" && s.block === c.block && s.temperature === c.temperature && s.arm === arm).map(s => s.n))].sort((a, b) => a! - b!), full.requests.values.map(r => r.n));
  }
  return { ...Object.fromEntries(Object.entries(full).filter(([key]) => key !== "samples")), sampleCount: full.samples.length, cohorts,
    producer: producer.map(s => ({ ms: s.elapsedMs, sql: s.sql, headroom: 1 - s.elapsedMs / 120_000 })),
    dataset: dataset.map(s => ({ block: s.block, arm: s.arm, ms: s.elapsedMs, sql: s.sql, checks: s.checks })) };
};
