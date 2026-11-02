import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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

const fullRecord = (bytes: Buffer, path: string) => ({ path: isAbsolute(path) ? relative(process.cwd(), path) : path,
  sha256: sha256(bytes), byteSize: bytes.byteLength,
  retention: path.includes("#") ? "Uncompressed record retained in the committed full-records.tar.gz bundle. A rerun creates a new sample hash."
    : "Full record staged locally; bundle it before committing the receipt. A rerun creates a new sample hash." });
export const compactBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as FullBenchmark;
  const verification = full.verdict === "pass" ? verifyBenchmarkSamples(full) : { verdict: "not-qualified" };
  const { samples, ...metadata } = full;
  delete metadata.publications; delete metadata.fixture; delete metadata.inputGeneration; delete metadata.storageRoot;
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

type RecordReference = { path: string; sha256: string; byteSize?: number };
const verifyRecordBytes = (record: RecordReference, bytes: Buffer) => {
  assert.equal(sha256(bytes), record.sha256, "full-record-sha256-mismatch");
  if (record.byteSize !== undefined) assert.equal(bytes.byteLength, record.byteSize, "full-record-byte-size-mismatch");
};
export const verifyEvidenceReceipt = (receipt: ReturnType<typeof compactBenchmark> | ReturnType<typeof compactBehavior>, bytes: Buffer) => {
  verifyRecordBytes(receipt.fullRecord, bytes);
  // The disposable prototype used a different sample shape. Preserve its
  // original summary/probe projection rather than claiming final qualification.
  if ("phase" in receipt && receipt.phase === "disposable-local-spike") {
    const full = JSON.parse(bytes.toString());
    const { schemaVersion, sampleCount, probes, baselineFirst, fullRecord: record, supplementalRecords, ...metadata } = receipt;
    assert.equal(schemaVersion, 2); assert.equal(sampleCount, full.samples.length);
    assert.deepEqual(probes, full.probes.map(({ name, verdict }: { name: string; verdict: string }) => ({ name, verdict })));
    assert.deepEqual(baselineFirst, { byRows: full.baselineFirst.byRows });
    assert(record && supplementalRecords);
    assert.deepEqual(metadata, Object.fromEntries(Object.keys(metadata).map(key => [key, full[key]])), "compact-receipt-mismatch");
    return;
  }
  const expected = "samples" in JSON.parse(bytes.toString()) ? compactBenchmark(bytes, receipt.fullRecord.path) : compactBehavior(bytes, receipt.fullRecord.path);
  assert.deepEqual(receipt, expected, "compact-receipt-mismatch");
};

const recordReferences = (value: unknown): RecordReference[] => {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.sha256 === "string") return [object as RecordReference];
  return Object.values(object).flatMap(recordReferences);
};

// Read just the named member to stdout; never extract files or follow archive
// paths on disk. Validate membership and relative paths before invoking tar.
export const verifyEvidenceBundle = async (directory: string, recompute = true) => {
  const bundle = resolve(directory, "full-records.tar.gz");
  const members = execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" }).trim().split("\n");
  assert.equal(new Set(members).size, members.length, "duplicate-bundle-member");
  const receipts = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".json"))
    .sort().map(async name => ({ name, receipt: JSON.parse(await readFile(resolve(directory, name), "utf8")) })));
  const records = new Map<string, Buffer>();
  const verdicts = [];
  for (const { name, receipt } of receipts) {
    for (const record of recordReferences(receipt)) {
      assert(!isAbsolute(record.path), "absolute-full-record-path");
      const [archive, member, extra] = record.path.split("#");
      assert.equal(archive, "full-records.tar.gz", "unexpected-full-record-bundle");
      assert(member && !extra && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(member) &&
        member.split("/").every(part => part && part !== "." && part !== ".."), "unsafe-full-record-member");
      assert(members.includes(member), "missing-full-record-member");
      const bytes = records.get(member) ?? execFileSync("tar", ["-xOzf", bundle, member], { maxBuffer: 16 * 1024 * 1024 });
      // SHA-256 precedes JSON parsing or any percentile/counter recomputation.
      verifyRecordBytes(record, bytes);
      if (!records.has(member)) verdicts.push({ record: member, verdict: "pass", sha256: sha256(bytes), byteSize: bytes.byteLength });
      records.set(member, bytes);
    }
    if (recompute && receipt.fullRecord) {
      const bytes = records.get(receipt.fullRecord.path.split("#")[1])!;
      verifyEvidenceReceipt(receipt, bytes);
    }
    assert(recordReferences(receipt).length, `receipt-without-full-record:${name}`);
  }
  assert.deepEqual([...records.keys()].sort(), [...members].sort(), "unreferenced-bundle-member");
  return verdicts;
};

// Hash first, then recompute. `audit` needs only tracked files, Node and tar;
// its hash-only mode is suitable for CI without measuring or gating timing.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, receiptPath, fullPath] = process.argv.slice(2);
  if (operation === "audit") {
    assert(receiptPath && !fullPath, "usage: artifact-governance-evidence.ts audit EVIDENCE_DIRECTORY");
    for (const verdict of await verifyEvidenceBundle(receiptPath)) console.log(JSON.stringify(verdict));
  } else {
    assert(receiptPath && fullPath && ["benchmark", "behavior", "verify"].includes(operation),
      "usage: artifact-governance-evidence.ts benchmark|behavior|verify RECEIPT FULL_RECORD");
    const bytes = await readFile(fullPath);
    if (operation === "verify") {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      verifyEvidenceReceipt(receipt, bytes);
      console.log(JSON.stringify({ verdict: "pass", sha256: sha256(bytes), ...receipt.verification }));
    } else await writeFile(receiptPath, JSON.stringify(operation === "benchmark" ? compactBenchmark(bytes, fullPath) : compactBehavior(bytes, fullPath), null, 2) + "\n");
  }
}
