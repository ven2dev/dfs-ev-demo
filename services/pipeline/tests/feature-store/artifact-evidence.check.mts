import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compactBenchmark, compactBehavior, verifyBenchmarkSamples, verifyEvidenceReceipt,
  verifyEvidenceBundle, type FullBenchmark } from "../../scripts/feature-store/artifact-governance-evidence.ts";

test("every committed evidence reference resolves to a checksum-matching bundled member without a cache or database", async () => {
  const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-166/", import.meta.url));
  // Hashes/byte sizes/relative membership only: no recorded or live timing gate.
  const verdicts = await verifyEvidenceBundle(directory, false);
  assert.equal(verdicts.length, 8);
  assert(verdicts.every(result => result.verdict === "pass"));
});

// Deterministic arithmetic controls only: no clock measurement or speed gate
// executes in CI. The offline verifier must reject incomplete/tampered proof.
const fixture = (): FullBenchmark => {
  const shapes = Array.from({ length: 6 }, (_, n) => ({ name: `shape-${n}`, slots: Array(n % 3 + 1).fill("file") }));
  const sample = (arm: string, shape: string, phase = "interleaved", block = 1, position = 0, read = 1) => ({
    arm, shape, phase, block, position, read, q1Ms: 1, q2Ms: 2, sumMs: 3, endToEndMs: 4, verdict: "pass", workPass: true,
    queries: [{ kind: "rights", elapsedMs: 1 }, { kind: "rights", elapsedMs: 2 }],
    work: { sql: arm === "candidate" ? 2 : 3, rights: 2, gets: arm === "candidate" ? shapes.find(s => s.name === shape)!.slots.length : 1,
      heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0, calculations: 1 } });
  const samples = ["zero", "full"].flatMap(mode => Array.from({ length: 25 }, (_, n) => sample("baseline", mode, "baseline-first", 0, 0, n + 1)));
  for (const shape of shapes) for (let block = 1; block <= 6; block++)
    for (const [position, arm] of ["baseline", "candidate", "candidate", "baseline"].entries())
      for (let read = 1; read <= 25; read++) samples.push(sample(arm, shape.name, "interleaved", block, position, read));
  return { verdict: "pass", shapes, samples,
    blocks: shapes.flatMap(shape => Array.from({ length: 6 }, (_, n) => ({ shape: shape.name, block: n + 1,
      candidateSamples: 50, baselineSamples: 50, candidateP95Ms: 3, baselineP95Ms: 3, headroom: .9, endToEndP95Ms: 4, pass: true }))),
    baselineFirst: [{ mode: "zero", rowCount: 0, p95Ms: 3 }, { mode: "full", rowCount: 2504, p95Ms: 3 }],
    summary: { totalSamples: 3650, interleavedSamples: 3600, candidateSamples: 1800, candidateBlocks: 36,
      worstCandidateBlockP95Ms: 3, minimumHeadroom: .9, failedBlocks: 0, failedSamples: 0 },
    inputGeneration: { code: {}, codeHashes: {} } };
};
test("compact receipt binds full sample bytes and reproduces every block's headroom", () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  const receipt = compactBenchmark(bytes, "/local/full-samples.json");
  assert(!("samples" in receipt)); assert.equal(receipt.fullRecord.byteSize, bytes.byteLength);
  verifyEvidenceReceipt(receipt, bytes);
  assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /full-record-sha256-mismatch/);
  receipt.blocks[0].candidateP95Ms = 1;
  assert.throws(() => verifyEvidenceReceipt(receipt, bytes), /compact-receipt-mismatch/);
});
test("sample verifier rejects hidden work, duplicated coordinates and false percentile sums", () => {
  for (const mutate of [
    (full: FullBenchmark) => { full.samples[0].work.hashes = 1; },
    (full: FullBenchmark) => { full.samples[1] = full.samples[0]; },
    (full: FullBenchmark) => { full.samples[0].sumMs = 1; },
    (full: FullBenchmark) => { full.blocks[0].candidateP95Ms = 1; },
  ]) { const full = fixture(); mutate(full); assert.throws(() => verifyBenchmarkSamples(full)); }
});
test("sample verifier rejects slow Q1+Q2 despite a forged passing block summary", () => {
  const full = fixture();
  for (const sample of full.samples.filter(s => s.arm === "candidate" && s.shape === "shape-0" && s.block === 1)) {
    sample.q2Ms = 22; sample.queries[1].elapsedMs = 22; sample.sumMs = 23;
  }
  assert.throws(() => verifyBenchmarkSamples(full));
});
test("compact server counters retain hidden scan and DML negative controls", () => {
  const row = { table: "feature_values", seq_scan: 1, seq_tup_read: 2504, idx_scan: 0, idx_tup_fetch: 0, inserted: 1, updated: 0, deleted: 0 };
  const bytes = Buffer.from(JSON.stringify({ verdict: "pass", counter: [row] }));
  const receipt = compactBehavior(bytes, "/local/full-behavior.json");
  const counter = receipt.counter as { exampleTables: typeof row; nonQueue: typeof row };
  assert.equal(counter.exampleTables.seq_tup_read, 2504); assert.equal(counter.nonQueue.inserted, 1);
  verifyEvidenceReceipt(receipt, bytes);
});
