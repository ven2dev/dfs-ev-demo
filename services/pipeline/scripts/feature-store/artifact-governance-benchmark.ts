import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { arch, platform, release } from "node:os";
import type { Client } from "pg";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EXPECTED_COHORT, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { modelPublicationCodeIdentity } from "./model-publication-identity.ts";
import { withDatasetRead } from "../../src/featureStore/datasets.ts";
import { withModelArtifacts, type ModelArtifactSlot } from "../../src/featureStore/modelArtifacts.ts";
import { publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";

type Database = Pick<Client, "query">;
type Arm = "baseline" | "candidate";
type Shape = { name: string; runId: string; datasetId: string; slots: ModelArtifactSlot[] };
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const codeIdentity = async () => {
  const publication = await modelPublicationCodeIdentity();
  const extra = ["packages/db/proposals/166_artifact_governance.sql", "compose.test.yml",
    "services/pipeline/scripts/feature-store/artifact-governance-benchmark.ts"];
  const hashes = Object.fromEntries(await Promise.all(extra.map(async path =>
    [path, sha256(await readFile(new URL(path, EVALUATION_ROOT)))])));
  const codeHashes = Object.fromEntries(Object.entries({ ...publication.codeHashes, ...hashes }).sort(([a], [b]) => a.localeCompare(b)));
  return { code: { gitSha: publication.code.gitSha, contentSha256: sha256(Buffer.from(JSON.stringify(codeHashes))) }, codeHashes };
};

// Observe the actual APIs, with no observer SQL or server-work wrappers inside
// timing. Keep failed samples as well as successes. CI measures internal work
// separately; this opt-in executable alone enforces elapsed-time gates.
const measure = async (client: Database, store: ObjectStore, arm: Arm, datasetId: string, shape?: Shape) => {
  const queries: { kind: "metadata" | "rights"; elapsedMs: number }[] = [];
  const work = { sql: 0, rights: 0, gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0, calculations: 0 };
  let getMs = 0, calculationMs = 0, failure: string | undefined;
  const originalHash = crypto.createHash;
  crypto.createHash = ((...args: Parameters<typeof originalHash>) => { work.hashes++; return originalHash(...args); }) as typeof originalHash;
  syncBuiltinESMExports();
  const observed = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      const kind = sql.includes(arm === "baseline" ? "fs138.effective_rights(" : "fs138.authorize_model_read(") ? "rights" : "metadata";
      work.sql++; if (kind === "rights") work.rights++;
      const started = performance.now();
      try { return await Reflect.apply(target.query, target, args); }
      finally { queries.push({ kind, elapsedMs: performance.now() - started }); }
    };
  } });
  const objects: ObjectStore = { ...store,
    get: async key => {
      work.gets++; const started = performance.now();
      try { return await store.get(key); } finally { getMs += performance.now() - started; }
    },
    head: async key => { work.heads++; return store.head(key); },
    putIfAbsent: async (key, bytes) => { work.puts++; return store.putIfAbsent(key, bytes); },
    delete: async key => { work.deletes++; return store.delete(key); },
    list: async namespace => { work.lists++; return store.list(namespace); },
  };
  // A trivial trusted calculation touches byte lengths only. It is not #167's
  // future context lookup, parsing, projection or end-to-end serving benchmark.
  const calculate = (sizes: number[]) => {
    const started = performance.now(); work.calculations++;
    const size = sizes.reduce((sum, n) => sum + n, 0);
    calculationMs += performance.now() - started;
    return size;
  };
  const started = performance.now();
  try {
    if (arm === "baseline") await withDatasetRead(observed, objects, datasetId, bytes => calculate([bytes.byteLength]));
    else {
      assert(shape);
      const result = await withModelArtifacts(observed, objects, shape,
        input => calculate(input.files.map(file => file.bytes.byteLength)));
      assert.equal(result.authorization.decisions.length, result.delivery.decisions.length);
    }
  } catch (error) { failure = String(error); }
  finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
  const endToEndMs = performance.now() - started;
  const rights = queries.filter(q => q.kind === "rights");
  const expected = { sql: arm === "baseline" ? 3 : 2, rights: 2, gets: arm === "baseline" ? 1 : shape!.slots.length,
    heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0, calculations: 1 };
  const workPass = Object.entries(expected).every(([key, value]) => work[key as keyof typeof work] === value);
  return { verdict: !failure && workPass ? "pass" : "fail", ...(failure ? { error: failure } : {}),
    q1Ms: rights[0]?.elapsedMs ?? null, q2Ms: rights[1]?.elapsedMs ?? null,
    sumMs: rights.length === 2 ? rights[0].elapsedMs + rights[1].elapsedMs : null,
    endToEndMs, getMs, calculationMs, queries, work, workPass };
};

const directory = new URL("node_modules/.cache/feature-store-166/", EVALUATION_ROOT);
await mkdir(directory, { recursive: true });
const root = await realpath(await mkdtemp(new URL("final-benchmark-", directory).pathname));
const store = await openLocalObjectStore(root), source = await codeIdentity(), inputSource = await evaluationCodeIdentity();
type Sample = Awaited<ReturnType<typeof measure>> & {
  arm: Arm; phase: "baseline-first" | "interleaved"; shape: string; block: number; position: number; read: number;
};
const samples: Sample[] = [];
const receipt: Record<string, unknown> = { schemaVersion: 1, issue: 166, step: 4, verdict: "running",
  startedAt: new Date().toISOString(), runtime: process.version, machine: { arch: arch(), platform: platform(), release: release() },
  ...source, inputGeneration: inputSource, storageRoot: root, samples,
  fixtureConfig: { postgresTmpfsBytes: 512 * 1024 * 1024, sharedMemoryBytes: 128 * 1024 * 1024 },
  method: { baselineFirstReadsPerMode: 25, shapes: 6, blocksPerShape: 6, order: ["baseline", "candidate", "candidate", "baseline"],
    readsPerPosition: 25, interleavedSamples: 3600, candidateSamples: 1800,
    gate: "Every shape/block: nearest-rank p95 of each candidate read's Q1+Q2 <=21 ms under 30 ms (>=30% headroom). Baseline ratios are informative only.",
    queryBoundary: "Client query dispatch to resolved response, including local loopback and pg JSON decoding; excludes metadata-only baseline query, GET and calculation.",
    baseline: "Unmodified withDatasetRead, three SQL calls; time only its two effective_rights calls. Baseline-first precedes candidate SQL installation.",
    candidate: "Actual withModelArtifacts, two authorize_model_read calls; freshly published matching SQL/envelope pins, no prototype orchestration.",
    cache: "Warm/unflushed OS, file and database caches, existing restricted LOGIN; no cold-cache claim." },
  qualification: "LOCAL-FIXTURE ONLY. Hosted RTT/Neon wake/region (#220) unmeasured; no #167 serving or #168 capacity claim.",
  limitations: ["Full read time and trivial byte-length calculation are informational; no parsing/context/projection workload is claimed.",
    "Query/crypto observation adds instrumentation overhead to both arms. Server work/locks are qualified separately by CI behavior receipts, outside this timing loop.",
    "All samples, including failures and slow blocks, are retained; failed gates are never silently filtered or relaxed."] };
const receiptPath = process.env.FS166_BENCHMARK_EVIDENCE ?? new URL("166-benchmark.json", directory);
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
await save();
try {
  await withFeatureStoreDatabase(async context => {
    receipt.database = (await context.admin.query("SELECT version() AS version")).rows[0].version;
    const fixture = await prepareEvaluationFixture(context, store, inputSource.code, event => console.log(JSON.stringify(event)));
    const strict = fixture.prepared.find(p => p.mode === "strict-point-in-time-v1")!;
    const retro = fixture.prepared.find(p => p.mode === "retrospective-reconstruction-v1")!;
    assert.equal(strict.dataset.rowCount, 0); assert.equal(retro.dataset.rowCount, EXPECTED_COHORT.examples);
    receipt.fixture = { inputPinsArtifact: fixture.inputPinsArtifact, wireFiles: fixture.pins.inputs.length,
      inputs: fixture.pins.inputs, modes: fixture.prepared.map(p => ({ mode: p.mode, ...p.dataset, spec: p.spec })) };
    for (const prepared of [strict, retro]) for (let read = 1; read <= 25; read++)
      samples.push({ arm: "baseline", phase: "baseline-first", shape: prepared.mode, block: 0, position: 0, read,
        ...await measure(context.reader, store, "baseline", prepared.dataset.datasetId) });
    receipt.baselineFirst = [strict, retro].map(p => ({ mode: p.mode, rowCount: p.dataset.rowCount,
      p95Ms: p95(samples.filter(s => s.shape === p.mode).map(s => s.sumMs!)) }));
    await save();
    for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql"])
      await context.admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
    const runs = [];
    for (const modes of [[strict.mode], [retro.mode], [strict.mode, retro.mode]]) {
      const run = await publishQbModelRun(context.writer, store, fixture.inputPinsArtifact, { code: source.code, modes });
      const descriptorBytes = await store.get(run.descriptor.objectKey), descriptor = JSON.parse(descriptorBytes.toString());
      assert.equal(sha256(descriptorBytes), run.descriptor.fileSha256); assert.deepEqual(descriptor.identity, run.identity);
      const reports = [];
      for (const pin of run.reports) {
        const bytes = await store.get(pin.objectKey), envelope = JSON.parse(bytes.toString());
        const prepared = fixture.prepared.find(p => p.mode === pin.slot)!;
        assert.equal(sha256(bytes), pin.fileSha256); assert.equal(bytes.byteLength, pin.byteSize);
        assert.deepEqual(envelope.dataset, prepared.dataset); assert.deepEqual(envelope.code, source.code);
        assert.equal(envelope.report.folds.length, prepared.dataset.rowCount);
        assert.equal(envelope.logicalSha256, sha256(Buffer.from(JSON.stringify(envelope.report))));
        assert.deepEqual(descriptor.reports.find((p: { mode: string }) => p.mode === pin.slot), {
          mode: pin.slot, datasetId: pin.datasetId, objectKey: pin.objectKey, sha256: pin.fileSha256,
          byteSize: pin.byteSize, logicalSha256: envelope.logicalSha256 });
        reports.push({ ...pin, logicalSha256: envelope.logicalSha256, examples: envelope.report.folds.length });
      }
      const sqlPins = (await context.writer.query(`SELECT dataset_id,evidence_mode,file_sha256,content_sha256,row_count
        FROM fs138.model_run_datasets WHERE run_id=$1 ORDER BY evidence_mode`, [run.runId])).rows;
      assert.deepEqual(sqlPins, fixture.prepared.filter(p => modes.includes(p.mode)).map(p => ({
        dataset_id: p.dataset.datasetId, evidence_mode: p.mode, file_sha256: p.dataset.fileSha256,
        content_sha256: p.dataset.contentSha256, row_count: p.dataset.rowCount })).sort((a, b) => a.evidence_mode.localeCompare(b.evidence_mode)));
      runs.push({ ...run, verifiedReports: reports, sqlPins });
    }
    receipt.publications = runs;
    const shapes: Shape[] = runs.flatMap((run, i) => {
      const name = ["strict", "retrospective", "both"][i];
      const datasetId = i === 0 ? strict.dataset.datasetId : retro.dataset.datasetId;
      return [ { name: `${name}/descriptor`, runId: run.runId, datasetId, slots: ["descriptor"] },
        { name: `${name}/all`, runId: run.runId, datasetId, slots: ["descriptor", ...run.reports.map(r => r.slot)] } ];
    });
    receipt.shapes = shapes;
    for (const shape of shapes) for (let block = 1; block <= 6; block++) {
      for (const [position, arm] of (["baseline", "candidate", "candidate", "baseline"] as const).entries())
        for (let read = 1; read <= 25; read++) samples.push({ arm, phase: "interleaved", shape: shape.name, block, position, read,
          ...await measure(context.reader, store, arm, shape.datasetId, shape) });
      await save(); console.log(JSON.stringify({ stage: "block", shape: shape.name, block, samples: samples.length }));
    }
    const blocks = shapes.flatMap(shape => Array.from({ length: 6 }, (_, n) => {
      const selected = samples.filter(s => s.phase === "interleaved" && s.shape === shape.name && s.block === n + 1);
      const baseline = selected.filter(s => s.arm === "baseline"), candidate = selected.filter(s => s.arm === "candidate");
      const baselineP95Ms = p95(baseline.map(s => s.sumMs!)), candidateP95Ms = p95(candidate.map(s => s.sumMs!));
      return { shape: shape.name, block: n + 1, baselineSamples: baseline.length, candidateSamples: candidate.length,
        baselineP95Ms, candidateP95Ms, headroom: 1 - candidateP95Ms / 30,
        endToEndP95Ms: p95(candidate.map(s => s.endToEndMs)),
        pass: baseline.length === 50 && candidate.length === 50 && selected.every(s => s.verdict === "pass") && candidateP95Ms <= 21 };
    }));
    receipt.blocks = blocks;
    receipt.summary = { totalSamples: samples.length, interleavedSamples: samples.filter(s => s.phase === "interleaved").length,
      candidateSamples: samples.filter(s => s.arm === "candidate").length, candidateBlocks: blocks.length,
      worstCandidateBlockP95Ms: Math.max(...blocks.map(b => b.candidateP95Ms)),
      minimumHeadroom: Math.min(...blocks.map(b => b.headroom)), failedBlocks: blocks.filter(b => !b.pass).length,
      failedSamples: samples.filter(s => s.verdict !== "pass").length };
    assert.equal(samples.length, 3650); assert(blocks.every(b => b.pass), "per-block-local-speed-or-work-gate-failed");
    assert(samples.every(s => s.verdict === "pass"), "failed-samples-retained");
  });
  receipt.verdict = "pass";
} catch (error) { receipt.verdict = "fail"; receipt.error = String(error); process.exitCode = 1; }
finally {
  try {
    assert.deepEqual(await codeIdentity(), source, "source-changed-during-benchmark");
    assert.deepEqual(await evaluationCodeIdentity(), inputSource, "fixture-source-changed-during-benchmark");
    receipt.sourceUnchanged = true;
  } catch (error) { receipt.verdict = "fail"; receipt.sourceError = String(error); process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ verdict: receipt.verdict, summary: receipt.summary, error: receipt.error }));
