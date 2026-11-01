import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../../src/featureStore/objectStore.ts";

type Sample = { phase: string; shape: string; arm: string; block: number; position: number; read: number;
  q1Ms: number; q2Ms: number; sumMs: number; endToEndMs: number; verdict: string;
  workPass: boolean; work: Record<string, number>; queries: { kind: string; elapsedMs: number }[] };
export type FullBenchmark = { verdict: string; samples: Sample[]; shapes: { name: string; slots: string[] }[];
  blocks: { shape: string; block: number; candidateP95Ms: number; baselineP95Ms: number; headroom: number;
    baselineSamples: number; candidateSamples: number; endToEndP95Ms: number; pass: boolean }[];
  summary: { totalSamples: number; interleavedSamples: number; candidateSamples: number; candidateBlocks: number;
    worstCandidateBlockP95Ms: number; minimumHeadroom: number; failedBlocks: number; failedSamples: number };
  baselineFirst: { mode: string; rowCount: number; p95Ms: number }[];
  [key: string]: unknown };
const p95 = (values: number[]) => {
  assert(values.length && values.every(value => Number.isFinite(value) && value >= 0), "invalid-timing-sample");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
};
const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-9, "recomputed-statistic-mismatch");

// Recompute from individual Q1/Q2 durations, not stored block summaries. This
// offline verifier performs no SQL and is not a machine-speed assertion in CI.
export const verifyBenchmarkSamples = (full: FullBenchmark) => {
  const { samples, blocks, shapes } = full;
  assert.equal(samples.length, 3650); assert.equal(shapes.length, 6); assert.equal(blocks.length, 36);
  assert.equal(new Set(shapes.map(s => s.name)).size, 6);
  const groups = new Map<string, Sample[]>(), coordinates = new Set<string>();
  for (const sample of samples) {
    assert.equal(sample.verdict, "pass"); assert.equal(sample.workPass, true);
    const candidate = sample.arm === "candidate", shape = shapes.find(s => s.name === sample.shape);
    assert(["baseline", "candidate"].includes(sample.arm));
    assert(["baseline-first", "interleaved"].includes(sample.phase));
    const expected = { sql: candidate ? 2 : 3, rights: 2, gets: candidate ? shape!.slots.length : 1,
      heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0, calculations: 1 };
    assert.deepEqual(sample.work, expected, "sample-work-budget-mismatch");
    const rights = sample.queries.filter(q => q.kind === "rights"); assert.equal(rights.length, 2);
    near(sample.q1Ms, rights[0].elapsedMs); near(sample.q2Ms, rights[1].elapsedMs);
    near(sample.sumMs, sample.q1Ms + sample.q2Ms); p95([sample.sumMs, sample.q1Ms, sample.q2Ms, sample.endToEndMs]);
    const key = JSON.stringify([sample.phase, sample.shape, sample.block, sample.position, sample.read]);
    assert(!coordinates.has(key), "duplicate-sample-coordinate"); coordinates.add(key);
    assert(Number.isInteger(sample.read) && sample.read >= 1 && sample.read <= 25);
    if (sample.phase === "baseline-first") {
      assert(!candidate && sample.block === 0 && sample.position === 0);
      assert(full.baselineFirst.some(b => b.mode === sample.shape));
    } else {
      assert(shape && sample.block >= 1 && sample.block <= 6 && Number.isInteger(sample.block));
      assert.equal(sample.arm, ["baseline", "candidate", "candidate", "baseline"][sample.position]);
      const group = JSON.stringify([sample.shape, sample.block, sample.position]);
      groups.set(group, [...groups.get(group) ?? [], sample]);
    }
  }
  assert.equal(groups.size, 144); assert([...groups.values()].every(group => group.length === 25));
  const blockKeys = new Set<string>();
  for (const block of blocks) {
    const key = JSON.stringify([block.shape, block.block]); assert(!blockKeys.has(key)); blockKeys.add(key);
    assert(shapes.some(s => s.name === block.shape) && block.block >= 1 && block.block <= 6);
    const selected = samples.filter(s => s.phase === "interleaved" && s.shape === block.shape && s.block === block.block);
    const candidate = selected.filter(s => s.arm === "candidate"), baseline = selected.filter(s => s.arm === "baseline");
    assert.equal(candidate.length, 50); assert.equal(baseline.length, 50);
    assert.equal(block.candidateSamples, 50); assert.equal(block.baselineSamples, 50);
    const measured = p95(candidate.map(s => s.q1Ms + s.q2Ms));
    near(measured, block.candidateP95Ms); near(p95(baseline.map(s => s.q1Ms + s.q2Ms)), block.baselineP95Ms);
    near(p95(candidate.map(s => s.endToEndMs)), block.endToEndP95Ms); near(1 - measured / 30, block.headroom);
    assert(measured <= 21 && block.headroom >= .30 && block.pass, "local-block-headroom-gate-failed");
  }
  assert.equal(full.baselineFirst.length, 2);
  for (const baseline of full.baselineFirst) {
    const selected = samples.filter(s => s.phase === "baseline-first" && s.shape === baseline.mode);
    assert.equal(selected.length, 25); near(p95(selected.map(s => s.q1Ms + s.q2Ms)), baseline.p95Ms);
  }
  assert.deepEqual(full.summary, { totalSamples: 3650, interleavedSamples: 3600, candidateSamples: 1800, candidateBlocks: 36,
    worstCandidateBlockP95Ms: Math.max(...blocks.map(b => b.candidateP95Ms)),
    minimumHeadroom: Math.min(...blocks.map(b => b.headroom)), failedBlocks: 0, failedSamples: 0 });
  assert.equal(full.verdict, "pass");
  return { samples: 3650, candidateBlocks: 36, workBudgetsVerified: true, allBlocksAtLeast30PercentHeadroom: true };
};

const fullRecord = (bytes: Buffer, path: string) => ({ path: resolve(path), sha256: sha256(bytes), byteSize: bytes.byteLength,
  retention: "Full record retained outside Git; obtain these exact bytes to audit the historical result. A rerun creates a new sample hash." });
export const compactBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as FullBenchmark;
  const verification = full.verdict === "pass" ? verifyBenchmarkSamples(full) : { verdict: "not-qualified" };
  const { samples, ...metadata } = full;
  delete metadata.publications; delete metadata.fixture; delete metadata.inputGeneration;
  const workCounts = [...new Set(samples.map(s => JSON.stringify(s.work)))].map(work => ({
    work: JSON.parse(work), samples: samples.filter(s => JSON.stringify(s.work) === work).length }));
  const input = full.inputGeneration as { code: unknown; codeHashes: unknown };
  const config = full.fixture as { wireFiles: number; modes: { mode: string; rowCount: number; contentSha256: string }[] } | undefined;
  return { ...metadata, schemaVersion: 2, fullRecord: fullRecord(bytes, path), verification, workCounts,
    inputGeneration: input,
    fixture: config && { wireFiles: config.wireFiles, modes: config.modes.map(({ mode, rowCount, contentSha256 }) => ({ mode, rowCount, contentSha256 })) } };
};

// Preserve deterministic totals and negative-control results without repeating
// every zero-valued table row. The digest binds the original counters/details.
const compactCounters = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    if (value.length && value.every(row => row && typeof row.table === "string" && "seq_scan" in row && "inserted" in row)) {
      const totals = (rows: Record<string, number>[]) => Object.fromEntries(
        ["seq_scan", "seq_tup_read", "idx_scan", "idx_tup_fetch", "inserted", "updated", "deleted"]
          .map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
      return { tablesMeasured: value.length, allTables: totals(value),
        exampleTables: totals(value.filter(row => /^(dataset_members|feature_values|feature_inputs|outcome_labels|label_inputs|norm_)/.test(row.table))),
        queue: totals(value.filter(row => row.table === "object_removals")),
        nonQueue: totals(value.filter(row => row.table !== "object_removals")) };
    }
    return value.map(compactCounters);
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compactCounters(child)]));
  return value;
};
export const compactBehavior = (bytes: Buffer, path: string): Record<string, unknown> & { schemaVersion: number; fullRecord: ReturnType<typeof fullRecord> } => ({
  ...compactCounters(JSON.parse(bytes.toString())) as Record<string, unknown>, schemaVersion: 2, fullRecord: fullRecord(bytes, path) });

export const verifyEvidenceReceipt = (receipt: ReturnType<typeof compactBenchmark> | ReturnType<typeof compactBehavior>, bytes: Buffer) => {
  assert.equal(sha256(bytes), receipt.fullRecord.sha256, "full-record-sha256-mismatch");
  const expected = "samples" in JSON.parse(bytes.toString()) ? compactBenchmark(bytes, receipt.fullRecord.path) : compactBehavior(bytes, receipt.fullRecord.path);
  assert.deepEqual(receipt, expected, "compact-receipt-mismatch");
};

// CLI: full samples are a separate durable local artifact. Hash first, then
// recompute every percentile/work count and compare the entire compact receipt.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, receiptPath, fullPath] = process.argv.slice(2);
  assert(receiptPath && fullPath && ["benchmark", "behavior", "verify"].includes(operation),
    "usage: artifact-governance-evidence.ts benchmark|behavior|verify RECEIPT FULL_RECORD");
  const bytes = await readFile(fullPath);
  if (operation === "verify") {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    verifyEvidenceReceipt(receipt, bytes);
    console.log(JSON.stringify({ verdict: "pass", sha256: sha256(bytes), ...receipt.verification }));
  } else await writeFile(receiptPath, JSON.stringify(operation === "benchmark" ? compactBenchmark(bytes, fullPath) : compactBehavior(bytes, fullPath), null, 2) + "\n");
}
