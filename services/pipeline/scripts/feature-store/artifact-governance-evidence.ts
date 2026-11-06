import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import type { CompositeCase, CompositeSample } from "./composite-authorization-measure.ts";
import type { ReadCounters } from "../../tests/feature-store/artifact-read-work.ts";
import type { PredictionRequest } from "@dfs-ev/pipeline/feature-store/predict";

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

export const compositeCohortSummary = (samples: CompositeSample[], temperature: "cold" | "warm", cohort: number) => {
  const candidate = samples.filter(s => s.arm === "candidate"), reference = samples.filter(s => s.arm === "baseline");
  const candidateP95Ms = p95(candidate.map(s => s.totalMs));
  return { temperature, cohort, candidateSamples: candidate.length, referenceSamples: reference.length,
    candidateP95Ms, referenceP95Ms: p95(reference.map(s => s.totalMs)), headroom: 1 - candidateP95Ms / 300,
    candidateSetupP95Ms: p95(candidate.map(s => s.setupMs)), candidateWarmPathP95Ms: p95(candidate.map(s => s.warmPathMs)),
    candidateMeanSetupShare: candidate.reduce((sum, s) => sum + s.setupShare, 0) / candidate.length,
    candidateAggregateSetupShare: candidate.reduce((sum, s) => sum + s.setupMs, 0) / candidate.reduce((sum, s) => sum + s.totalMs, 0),
    n: [...new Set(candidate.map(s => s.n))].sort((a, b) => a - b),
    pass: candidate.length === 100 && reference.length === 100 && samples.every(s => s.verdict === "pass") && candidateP95Ms <= 210 };
};
type ScheduledBenchmark = Record<string, unknown> & {
  kind: "composite-authorization-benchmark" | "local-prediction-benchmark"; issue: number; verdict: string; schemaVersion: number;
  samples: CompositeSample[]; cohorts: ReturnType<typeof compositeCohortSummary>[];
  baselineFirstP95Ms?: number;
  requests?: { cases: CompositeCase[]; sha256: string; selection: string };
  modelOnly?: { sql: number; descriptorGets: number; verdict: string };
  fixture?: { wireFiles: number; modes: { mode: string; rowCount: number; contentSha256: string }[]; [key: string]: unknown };
  serverWork?: { n: number; featureId: string; profiles: string[]; rightsCalls: number; q1: ReadCounters; q2: ReadCounters; verdict: string }[];
};
export type FullCompositeBenchmark = ScheduledBenchmark & { kind: "composite-authorization-benchmark" };
export type FullPredictionBenchmark = ScheduledBenchmark & { kind: "local-prediction-benchmark";
  handlerRequests?: { values: PredictionRequest[]; sha256: string };
  code: { gitSha: string; contentSha256: string }; codeHashes: Record<string, string>; codeBlobIds: Record<string, string> };
const allN = Array.from({ length: 15 }, (_, i) => i + 2);
const verifyCompositeCounters = (rows: ReadCounters) => {
  assert(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.inserted + row.updated + row.deleted, 0, "composite-reader-DML");
    if (/^(dataset_members|outcome_labels|label_inputs|norm_)/.test(row.table))
      assert(Object.entries(row).every(([key, value]) => key === "table" || value === 0), "composite-hidden-example-work");
  }
};
const verifyScheduledBenchmark = (full: ScheduledBenchmark, enforceSpeed = true) => {
  assert.equal(full.verdict, "pass");
  assert.equal(full.sourceUnchanged, true);
  assert.equal(full.samples.length, 1245); assert.equal(full.cohorts.length, 6);
  assert(full.requests && full.fixture && full.serverWork);
  assert.deepEqual(full.requests.cases.map(c => c.n), allN);
  assert.equal(sha256(Buffer.from(JSON.stringify(full.requests.cases))), full.requests.sha256, "request-selection-hash-mismatch");
  assert.equal(full.fixture.wireFiles, 16);
  assert.equal(full.fixture.modes.find(m => m.mode === "strict-point-in-time-v1")!.rowCount, 0);
  const retrospective = full.fixture.modes.find(m => m.mode === "retrospective-reconstruction-v1")!;
  assert.equal(retrospective.rowCount, 2504);
  assert.equal(retrospective.contentSha256, "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d");
  assert.deepEqual(full.modelOnly, { sql: 2, descriptorGets: 1, verdict: "pass" });
  assert.deepEqual(full.serverWork.map(w => w.n), allN);
  for (const probe of full.serverWork) {
    assert.equal(probe.verdict, "pass"); assert(probe.profiles.length > 0);
    assert.equal(new Set(probe.profiles).size, probe.profiles.length);
    assert.equal(probe.rightsCalls, 2 * probe.profiles.length);
    verifyCompositeCounters(probe.q1); verifyCompositeCounters(probe.q2);
  }
  const coordinates = new Set<string>(), groups = new Map<string, CompositeSample[]>();
  for (const sample of full.samples) {
    const { arm, phase, temperature, cohort, position, read, work } = sample;
    assert.equal(sample.verdict, "pass"); assert(["baseline", "candidate"].includes(arm));
    assert(["cold", "warm"].includes(temperature)); assert(allN.includes(sample.n));
    assert(full.requests.cases.some(c => c.featureId === sample.featureId && c.n === sample.n));
    const key = JSON.stringify([phase, temperature, cohort, position, read]);
    assert(!coordinates.has(key), "duplicate-composite-sample-coordinate"); coordinates.add(key);
    assert.deepEqual(work, { sql: 3, checks: 2, gets: arm === "candidate" ? 1 : 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 });
    assert.deepEqual(sample.queries.map(q => q.kind), arm === "candidate" ? ["context", "check", "check"] : ["check", "history", "check"]);
    p95([sample.totalMs, sample.setupMs, sample.warmPathMs, sample.getMs, sample.computeMs, sample.serializationMs,
      ...sample.queries.map(q => q.elapsedMs)]);
    assert(sample.totalMs > 0 && sample.outputBytes > 0);
    near(sample.totalMs, sample.setupMs + sample.warmPathMs); near(sample.setupShare, sample.setupMs / sample.totalMs);
    assert(sample.setupShare >= 0 && sample.setupShare < 1);
    if (temperature === "warm") assert.equal(sample.setupMs, 0); else assert(sample.setupMs > 0);
    assert(sample.queries.reduce((sum, q) => sum + q.elapsedMs, 0) + sample.getMs + sample.computeMs + sample.serializationMs <= sample.warmPathMs + 1e-6,
      "overlapping-or-fabricated-composite-stage-times");
    assert(Number.isInteger(read));
    if (phase === "baseline-first") assert(arm === "baseline" && temperature === "warm" && cohort === 0 && position === 0 && read >= 1 && read <= 45);
    else {
      assert.equal(phase, "interleaved"); assert(Number.isInteger(cohort) && cohort >= 1 && cohort <= 3);
      assert.equal(arm, ["baseline", "candidate", "candidate", "baseline"][position]); assert(read >= 1 && read <= 50);
      const group = JSON.stringify([temperature, cohort, position]); groups.set(group, [...groups.get(group) ?? [], sample]);
    }
  }
  assert.equal(groups.size, 24); assert([...groups.values()].every(g => g.length === 50));
  const baselineFirst = full.samples.filter(s => s.phase === "baseline-first"); assert.equal(baselineFirst.length, 45);
  near(p95(baselineFirst.map(s => s.totalMs)), full.baselineFirstP95Ms!);
  const cohortKeys = new Set<string>();
  for (const result of full.cohorts) {
    const key = JSON.stringify([result.temperature, result.cohort]); assert(!cohortKeys.has(key)); cohortKeys.add(key);
    const selected = full.samples.filter(s => s.phase === "interleaved" && s.temperature === result.temperature && s.cohort === result.cohort);
    const expected = compositeCohortSummary(selected, result.temperature, result.cohort);
    assert.deepEqual(result, expected, "composite-cohort-recomputation-mismatch");
    assert.deepEqual(result.n, allN);
    if (enforceSpeed) assert(result.pass && result.headroom >= .3, "composite-full-path-headroom-gate-failed");
    // Each arm uses the same request schedule within each cohort.
    for (const input of full.requests.cases)
      assert.equal(selected.filter(s => s.arm === "baseline" && s.featureId === input.featureId).length,
        selected.filter(s => s.arm === "candidate" && s.featureId === input.featureId).length);
  }
  return { samples: 1245, candidateSamples: 600, candidateCohorts: 6, rightsBudget: "2 * independently derived union profile count",
    workBudgetsVerified: true, allCohortsAtLeast30PercentHeadroom: full.cohorts.every(c => c.pass && c.headroom >= .3),
    worstCandidateP95Ms: Math.max(...full.cohorts.map(c => c.candidateP95Ms)), minimumHeadroom: Math.min(...full.cohorts.map(c => c.headroom)) };
};
export const verifyCompositeBenchmark = (full: FullCompositeBenchmark) => {
  assert.equal(full.kind, "composite-authorization-benchmark"); assert.equal(full.issue, 231);
  return verifyScheduledBenchmark(full);
};
export const verifyPredictionBenchmark = (full: FullPredictionBenchmark, enforceSpeed = true) => {
  assert.equal(full.kind, "local-prediction-benchmark"); assert.equal(full.issue, 167); assert.equal(full.step, 3);
  assert.equal(full.schemaVersion, 1);
  const verification = verifyScheduledBenchmark(full, enforceSpeed);
  assert(full.handlerRequests && full.requests);
  assert.equal(sha256(Buffer.from(JSON.stringify(full.handlerRequests.values))), full.handlerRequests.sha256,
    "handler-request-hash-mismatch");
  assert.equal(full.handlerRequests.values.length, 15);
  const runIds = new Set(full.handlerRequests.values.map(r => r.runId)); assert.equal(runIds.size, 1);
  for (const [i, request] of full.handlerRequests.values.entries()) {
    assert.deepEqual(request, { ...full.requests.cases[i].request, runId: request.runId,
      modelVersion: "empirical-integer-v1", scoringPolicy: "qb-empirical-evaluation-v1", line: 225.5 });
  }
  assert.equal(full.code.contentSha256, sha256(Buffer.from(JSON.stringify(full.codeHashes))), "benchmark-source-hash-mismatch");
  assert.deepEqual(Object.keys(full.codeHashes), Object.keys(full.codeBlobIds));
  for (const path of ["services/pipeline/src/featureStore/predict.ts", "services/pipeline/src/featureStore/predictionHelpers.ts",
    "services/pipeline/src/featureStore/modelArtifacts.ts", "services/pipeline/src/featureStore/modelContext.ts",
    "services/pipeline/scripts/feature-store/prediction-benchmark.ts", "services/pipeline/scripts/feature-store/prediction-measure.ts",
    "packages/db/proposals/231_composite_authorization.sql"]) assert(path in full.codeHashes, "missing-measured-source");
  for (const path of Object.keys(full.codeHashes)) {
    assert(/^[a-f0-9]{64}$/.test(full.codeHashes[path])); assert(/^[a-f0-9]{40}$/.test(full.codeBlobIds[path]));
  }
  return verification;
};
export const compactCompositeBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as FullCompositeBenchmark;
  const verification = full.verdict === "pass" ? verifyCompositeBenchmark(full) : { verdict: "not-qualified" };
  const { samples, serverWork, ...metadata } = full;
  delete metadata.storageRoot; delete metadata.publication;
  return { ...metadata, fullRecord: fullRecord(bytes, path), verification,
    workCounts: ["baseline", "candidate"].map(arm => ({ arm, samples: samples.filter(s => s.arm === arm).length,
      work: [...new Set(samples.filter(s => s.arm === arm).map(s => JSON.stringify(s.work)))].map(w => JSON.parse(w)) })),
    serverWork: serverWork?.map(({ q1, q2, profiles, ...probe }) => ({ ...probe, unionProfiles: profiles.length,
      q1: compactCounters(q1), q2: compactCounters(q2) })) };
};
export const compactPredictionBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as FullPredictionBenchmark;
  const verification = full.verdict === "pass" ? verifyPredictionBenchmark(full) : { verdict: "not-qualified" };
  const { samples, serverWork, ...metadata } = full;
  delete metadata.storageRoot; delete metadata.publication;
  return { ...metadata, fullRecord: fullRecord(bytes, path), verification,
    workCounts: ["baseline", "candidate"].map(arm => ({ arm, samples: samples.filter(s => s.arm === arm).length,
      work: [...new Set(samples.filter(s => s.arm === arm).map(s => JSON.stringify(s.work)))].map(w => JSON.parse(w)) })),
    serverWork: serverWork?.map(({ q1, q2, profiles, ...probe }) => ({ ...probe, unionProfiles: profiles.length,
      q1: compactCounters(q1), q2: compactCounters(q2) })) };
};

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
type CompositeBehavior = {
  issue: number; step: number; fixture: string; verdict: string; sourceHashes: Record<string, string>;
  kind?: "composite-authorization-behavior";
  relabelledFrom?: { issue: number; step: number; receipt: string; fullRecord: RecordReference };
  probes: { name: string; verdict: string; details: unknown }[];
  budgets?: { unionProfiles: string[]; rightsCalls: number; rightsBatches: number; work: Record<string, number> }[];
};
const compositeBehaviorProjection = (full: CompositeBehavior) => {
  const carriedStep0 = full.issue === 167 && full.step === 0 && full.kind === "composite-authorization-behavior";
  assert(full.issue === 231 || carriedStep0, "unexpected-composite-behavior-label");
  assert.equal(full.verdict, "pass"); assert(full.probes.every(p => p.verdict === "pass"));
  const probes = full.probes.map(({ name, verdict, details }) => ({ name, verdict, detailsSha256: sha256(Buffer.from(JSON.stringify(details))) }));
  if (full.step === 1) {
    assert.equal(probes.length, 6);
    const first = full.probes[0].details as { counts: { n: number; statements: number; rightsChecks: number; historyReads: number }[] };
    assert.deepEqual(first.counts, allN.map(n => ({ n, statements: 1, rightsChecks: 0, historyReads: 0 })));
    return { issue: full.issue, step: full.step, fixture: full.fixture, verdict: full.verdict, sourceHashes: full.sourceHashes,
      probes, work: first.counts };
  }
  assert(full.step === 2 || carriedStep0, "unexpected-composite-behavior-step");
  assert.equal(probes.length, 15); assert(full.budgets && full.budgets.length === 79);
  for (const budget of full.budgets) {
    assert(budget.unionProfiles.length > 0); assert.equal(new Set(budget.unionProfiles).size, budget.unionProfiles.length);
    assert([0, 1, 2].includes(budget.rightsBatches)); assert.equal(budget.rightsCalls, budget.rightsBatches * budget.unionProfiles.length);
    assert.equal(budget.work.hashes + budget.work.heads + budget.work.puts + budget.work.deletes + budget.work.lists, 0);
    assert(budget.work.statements <= 3 && budget.work.checks <= 2 && budget.work.gets <= 1);
  }
  const allNProbes = full.probes[0].details as { n: number; overlap: boolean; budget: NonNullable<CompositeBehavior["budgets"]>[number] }[];
  assert.equal(allNProbes.length, 30);
  for (const n of allN) for (const overlap of [false, true]) {
    const selected = allNProbes.filter(p => p.n === n && p.overlap === overlap); assert.equal(selected.length, 1);
    const budget = selected[0].budget; assert.equal(budget.rightsBatches, 2);
    assert.deepEqual(budget.work, { statements: 3, checks: 2, gets: 1, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 });
  }
  const matched = full.probes.find(p => p.name.startsWith("database work is identical"))!.details as {
    matched: { n: number; q1: ReadCounters; q2: ReadCounters; profiles: string[]; rightsCalls: number }[];
    negativeControls: { scanDetected: boolean; writeDetected: boolean }; historyExpansion: number };
  assert.deepEqual(matched.matched.map(m => m.n), [2, 16]);
  assert.deepEqual(matched.matched[0].q1, matched.matched[1].q1); assert.deepEqual(matched.matched[0].q2, matched.matched[1].q2);
  for (const m of matched.matched) { verifyCompositeCounters(m.q1); verifyCompositeCounters(m.q2); assert.equal(m.rightsCalls, 2 * m.profiles.length); }
  assert.deepEqual(matched.negativeControls, { scanDetected: true, writeDetected: true }); assert.equal(matched.historyExpansion, 0);
  return { issue: full.issue, step: full.step,
    ...(carriedStep0 ? { kind: full.kind, relabelledFrom: full.relabelledFrom } : {}),
    fixture: full.fixture, verdict: full.verdict, sourceHashes: full.sourceHashes, probes,
    work: { probes: full.budgets.length, successfulAllNProbes: 30, n: allN, sql: 3, checks: 2, descriptorGets: 1,
      rightsCallBudget: "completed batches * independently derived union profile count; exactly 2P on success",
      matchedRelationalWork: true, readerDml: 0, hiddenExampleReads: 0, ...matched.negativeControls } };
};
type PredictionBehavior = {
  issue: number; step: number; kind: string; verdict: string; fixture: string; sourceHashes: Record<string, string>;
  probes: { name: string; verdict: string; details: unknown }[];
  budgets: { profiles: string[]; rightsCalls: number; available: boolean; trace: string[];
    expected: { sql: number; checks: number; gets: number; batches: number }; work: Record<string, number> }[];
};
const predictionBehaviorProjection = (full: PredictionBehavior) => {
  assert.equal(full.issue, 167); assert.equal(full.step, 2); assert.equal(full.verdict, "pass");
  assert.equal(full.probes.length, 16); assert(full.probes.every(p => p.verdict === "pass"));
  for (const b of full.budgets) {
    assert(b.profiles.length > 0); assert.equal(new Set(b.profiles).size, b.profiles.length);
    assert.deepEqual([b.work.sql, b.work.checks, b.work.gets], [b.expected.sql, b.expected.checks, b.expected.gets]);
    assert.equal(b.rightsCalls, b.expected.batches * b.profiles.length);
    assert(b.work.sql <= 3 && b.work.checks <= 2 && b.work.gets <= 1 && b.expected.batches <= b.work.checks);
    assert.equal(b.work.heads + b.work.puts + b.work.deletes + b.work.lists + b.work.hashes, 0);
    assert.deepEqual(b.trace, ["context", "Q1", "GET:descriptor", "Q2"].slice(0, b.work.sql + b.work.gets));
    if (b.available) assert.deepEqual([b.work.sql, b.work.checks, b.work.gets, b.expected.batches], [3, 2, 1, 2]);
  }
  const all = full.probes[0].details as { n: number; overlap: boolean; budget: PredictionBehavior["budgets"][number] }[];
  assert.equal(all.length, 30);
  for (const n of allN) for (const overlap of [false, true]) {
    const controls = all.filter(p => p.n === n && p.overlap === overlap); assert.equal(controls.length, 1);
    assert(controls[0].budget.available); assert(full.budgets.some(b => isSame(b, controls[0].budget)));
  }
  const measured = full.probes.find(p => p.name.startsWith("actual handler Q1/Q2 database work"))!.details as {
    matched: { n: number; q1: ReadCounters; q2: ReadCounters }[]; negativeControls: { scanDetected: boolean; writeDetected: boolean } };
  assert.deepEqual(measured.matched.map(m => m.n), [2, 16]);
  assert.deepEqual(measured.matched[0].q1, measured.matched[1].q1); assert.deepEqual(measured.matched[0].q2, measured.matched[1].q2);
  for (const m of measured.matched) { verifyCompositeCounters(m.q1); verifyCompositeCounters(m.q2); }
  assert.deepEqual(measured.negativeControls, { scanDetected: true, writeDetected: true });
  const modelOnly = full.probes.find(p => p.name.startsWith("real narrow LOGIN"))!.details as { modelOnlySql: number };
  assert.equal(modelOnly.modelOnlySql, 2);
  return { issue: full.issue, step: full.step, kind: full.kind, verdict: full.verdict, fixture: full.fixture,
    sourceHashes: full.sourceHashes, probes: full.probes.map(({ name, verdict, details }) => ({ name, verdict,
      detailsSha256: sha256(Buffer.from(JSON.stringify(details))) })),
    work: { measuredProbes: full.budgets.length, allNSuccessControls: 30, n: allN,
      sql: 3, combinedChecks: 2, descriptorGets: 1, rightsCalls: "2 × independently derived union profile count per success; exact stage budgets on refusal",
      matchedDatabaseWork: true, readerDml: 0, hiddenExampleReads: 0, modelOnlySql: 2 } };
};
const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const compactBehavior = (bytes: Buffer, path: string): Record<string, unknown> & { schemaVersion: number; fullRecord: ReturnType<typeof fullRecord> } => {
  const full = JSON.parse(bytes.toString());
  const projection = full.issue === 231 || full.kind === "composite-authorization-behavior"
    ? compositeBehaviorProjection(full) : full.kind === "local-prediction-behavior" ? predictionBehaviorProjection(full)
      : compactCounters(full) as Record<string, unknown>;
  return { ...projection, schemaVersion: 2, fullRecord: fullRecord(bytes, path) };
};

type RecordReference = { path: string; sha256: string; byteSize?: number };
const verifyRecordBytes = (record: RecordReference, bytes: Buffer) => {
  assert.equal(sha256(bytes), record.sha256, "full-record-sha256-mismatch");
  if (record.byteSize !== undefined) assert.equal(bytes.byteLength, record.byteSize, "full-record-byte-size-mismatch");
};
export const verifyEvidenceReceipt = (receipt: ReturnType<typeof compactBenchmark> | ReturnType<typeof compactBehavior>
  | ReturnType<typeof compactCompositeBenchmark> | ReturnType<typeof compactPredictionBenchmark>, bytes: Buffer) => {
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
  const full = JSON.parse(bytes.toString());
  const expected = full.kind === "local-prediction-benchmark" ? compactPredictionBenchmark(bytes, receipt.fullRecord.path)
    : full.kind === "composite-authorization-benchmark" ? compactCompositeBenchmark(bytes, receipt.fullRecord.path)
    : "samples" in full ? compactBenchmark(bytes, receipt.fullRecord.path) : compactBehavior(bytes, receipt.fullRecord.path);
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
  const receipts = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".json"))
    .sort().map(async name => ({ name, receipt: JSON.parse(await readFile(resolve(directory, name), "utf8")) })));
  // Append-only evidence can retain several uniquely named bundles. Each name
  // stays a plain relative filename; validate every archive's exact membership.
  const archives = new Map<string, string[]>();
  const records = new Map<string, Buffer>();
  const verdicts = [];
  for (const { name, receipt } of receipts) {
    for (const record of recordReferences(receipt)) {
      assert(!isAbsolute(record.path), "absolute-full-record-path");
      const [archive, member, extra] = record.path.split("#");
      assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tar\.gz$/.test(archive), "unexpected-full-record-bundle");
      assert(member && !extra && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(member) &&
        member.split("/").every(part => part && part !== "." && part !== ".."), "unsafe-full-record-member");
      const bundle = resolve(directory, archive);
      let members = archives.get(archive);
      if (!members) {
        members = execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" }).trim().split("\n");
        assert.equal(new Set(members).size, members.length, "duplicate-bundle-member");
        archives.set(archive, members);
      }
      assert(members.includes(member), "missing-full-record-member");
      const bytes = records.get(record.path) ?? execFileSync("tar", ["-xOzf", bundle, member], { maxBuffer: 16 * 1024 * 1024 });
      // SHA-256 precedes JSON parsing or any percentile/counter recomputation.
      verifyRecordBytes(record, bytes);
      if (!records.has(record.path)) verdicts.push({ record: archive === "full-records.tar.gz" ? member : record.path,
        verdict: "pass", sha256: sha256(bytes), byteSize: bytes.byteLength });
      records.set(record.path, bytes);
    }
    if (recompute && receipt.fullRecord) {
      const bytes = records.get(receipt.fullRecord.path)!;
      verifyEvidenceReceipt(receipt, bytes);
    }
    assert(recordReferences(receipt).length, `receipt-without-full-record:${name}`);
  }
  for (const [archive, members] of archives)
    assert.deepEqual([...records.keys()].filter(path => path.startsWith(archive + "#")).sort(),
      members.map(member => archive + "#" + member).sort(), "unreferenced-bundle-member");
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
    assert(receiptPath && fullPath && ["benchmark", "composite", "prediction", "behavior", "verify"].includes(operation),
      "usage: artifact-governance-evidence.ts benchmark|composite|prediction|behavior|verify RECEIPT FULL_RECORD");
    const bytes = await readFile(fullPath);
    if (operation === "verify") {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      verifyEvidenceReceipt(receipt, bytes);
      console.log(JSON.stringify({ verdict: "pass", sha256: sha256(bytes), ...receipt.verification }));
    } else await writeFile(receiptPath, JSON.stringify(operation === "benchmark" ? compactBenchmark(bytes, fullPath)
      : operation === "composite" ? compactCompositeBenchmark(bytes, fullPath)
        : operation === "prediction" ? compactPredictionBenchmark(bytes, fullPath) : compactBehavior(bytes, fullPath), null, 2) + "\n");
  }
}
