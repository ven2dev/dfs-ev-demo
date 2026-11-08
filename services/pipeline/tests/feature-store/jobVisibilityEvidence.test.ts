import { describe, expect, it } from "vitest";
import { visibilityCohorts, visibilityProjection, type VisibilityBenchmark, type VisibilitySample } from "../../scripts/feature-store/job-visibility-evidence.ts";
import { compactBehavior, verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

const record = (): VisibilityBenchmark => {
  const values = Array.from({ length: 15 }, (_, i) => ({ featureId: "feature-" + i, n: i + 2 }));
  const samples: VisibilitySample[] = [];
  const contentSha256 = "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d";
  for (let position = 0; position < 4; position++) samples.push({ gate: "producer", arm: "candidate", block: 1, position,
    elapsedMs: 100, setupMs: 0, sql: 8, checks: 0, gets: 0, status: "available", rowCount: 1948, verdict: "pass" });
  for (const block of [1, 2, 3]) {
    for (const [position, arm] of ["baseline", "candidate", "candidate", "baseline"].entries()) samples.push({ gate: "dataset",
      arm: arm as "baseline" | "candidate", block, position, elapsedMs: 100, setupMs: 0, sql: 8, checks: 2, gets: 0,
      status: "available", rowCount: 2504, contentSha256, verdict: "pass" });
    for (const temperature of ["cold", "warm"] as const) for (const arm of ["baseline", "candidate"] as const)
      for (let position = 0; position < 100; position++) samples.push({ gate: "reader", arm, block, temperature, position,
        ...values[position % 15], elapsedMs: position + 1, setupMs: temperature === "cold" ? 1 : 0,
        sql: 3, checks: 2, gets: 0, status: "available", verdict: "pass" });
  }
  return { issue: 241, step: 4, kind: "point-in-time-completion-benchmark", verdict: "pass", samples,
    cohorts: visibilityCohorts(samples), requests: { values, sha256: sha256(Buffer.from(JSON.stringify(values))) },
    fixture: { wireFiles: 16, naturalKeys: 9381, retrospectiveRows: 2504, strictRows: 0, contentSha256 },
    sourceHashes: { "example.ts": "a".repeat(64) }, sourceBlobIds: { "example.ts": "b".repeat(40) }, sourceUnchanged: true };
};
describe("#241 independent final evidence reconstruction", () => {
  it("checks every retained #241 bundle member without database, cache or timing assertions", async () => {
    const records = await verifyEvidenceBundle(new URL("../../../../docs/evidence/feature-store-241/", import.meta.url).pathname, false);
    expect(records.length).toBeGreaterThan(74); expect(records.every(r => r.verdict === "pass")).toBe(true);
  });
  it("reconstructs six separate p95s and setup shares from raw observations", () => {
    const r = record(), projection = visibilityProjection(r);
    expect(projection.sampleCount).toBe(1216);
    expect(projection.cohorts.map(c => c.p95Ms)).toEqual(Array(6).fill(95));
    expect(projection.cohorts[0].aggregateSetupShare).toBeCloseTo(1 / 50.5);
  });
  it("checks the member hash before parsing and refuses a forged compact percentile", () => {
    const bytes = Buffer.from(JSON.stringify(record())), receipt = compactBehavior(bytes, "records.tar.gz#full.json");
    expect(() => verifyEvidenceReceipt(receipt, Buffer.from("not JSON"))).toThrow(/sha256/);
    const forged = structuredClone(receipt) as typeof receipt & { cohorts: { p95Ms: number }[] };
    forged.cohorts[0].p95Ms = 1;
    expect(() => verifyEvidenceReceipt(forged, bytes)).toThrow(/compact-receipt-mismatch/);
    expect(() => verifyEvidenceReceipt(receipt, bytes)).not.toThrow();
  });
  it("refuses partial cohorts, duplicate observations and changed request pins", () => {
    for (const change of [(r: VisibilityBenchmark) => { r.samples.pop(); },
      (r: VisibilityBenchmark) => { r.samples[30] = r.samples[29]; },
      (r: VisibilityBenchmark) => { r.requests.values[0].n = 16; }]) {
      const r = record(); change(r); expect(() => visibilityProjection(r)).toThrow();
    }
  });
  it("cannot count refusals, extra SQL or relaxed latency as success", () => {
    for (const change of [(s: VisibilitySample) => { s.status = "unavailable"; },
      (s: VisibilitySample) => { s.sql = 4; }, (s: VisibilitySample) => { s.checks = 4; }]) {
      const r = record(); change(r.samples[20]); expect(() => visibilityProjection(r)).toThrow();
    }
    const r = record(); r.samples.filter(s => s.gate === "reader" && s.arm === "candidate" && s.block === 1 && s.temperature === "cold").forEach(s => { s.elapsedMs = 211; });
    r.cohorts = visibilityCohorts(r.samples); expect(() => visibilityProjection(r)).toThrow();
  });
});
