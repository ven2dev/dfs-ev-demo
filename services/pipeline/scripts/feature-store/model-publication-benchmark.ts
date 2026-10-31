import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { arch, platform, release } from "node:os";
import { promisify } from "node:util";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION } from "@dfs-ev/domain/qb-evaluation";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EXPECTED_COHORT, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { buildDataset } from "../../src/featureStore/datasets.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { MODEL_PREREGISTRATION, publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";

type Database = Pick<Client, "query">;
type Arm = "baseline" | "retained-transport" | "full-publisher";
type Trial = { arm: Arm; phase: "baseline-first" | "interleaved"; block: number; position: number;
  transactionMs: number; lockResponseToCommitMs: number; endToEndMs: number;
  work: ReturnType<typeof summarizeWork>; artifacts?: { slot: string; objectKey: string; fileSha256: string; byteSize: number }[] };
type Event = { operation: string; transaction: boolean };
const baselineCommit = "71cdd90e11cbee7ec6b0eb1961322d40c49a20e9";
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summarizeWork = (events: Event[]) => {
  const count = (operation: string, transaction?: boolean) => events.filter(e => e.operation === operation &&
    (transaction === undefined || e.transaction === transaction)).length;
  return { statements: events.filter(e => e.operation.startsWith("sql:")).length,
    preparationStatements: count("sql:prepare"), publicationStatements: events.filter(e =>
      e.operation.startsWith("sql:") && e.operation !== "sql:prepare").length,
    transactionStatements: events.filter(e => e.operation.startsWith("sql:") && e.transaction).length,
    preflightHeads: count("head", false), transactionHeads: count("head", true),
    uploads: count("put"), transactionUploads: count("put", true),
    objectReads: count("get"), transactionObjectReads: count("get", true),
    hashes: count("hash"), transactionHashes: count("hash", true) };
};
const measure = async <T>(client: Database, store: ObjectStore, run: (database: Database, objects: ObjectStore) => Promise<T>) => {
  const events: Event[] = [];
  let transaction = false, begin = 0, lockResponse = 0, transactionMs = 0, lockResponseToCommitMs = 0;
  const event = (operation: string) => events.push({ operation, transaction });
  const originalHash = crypto.createHash;
  crypto.createHash = ((...args: Parameters<typeof originalHash>) => { event("hash"); return originalHash(...args); }) as typeof originalHash;
  syncBuiltinESMExports();
  const observed = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      if (sql === "BEGIN") { transaction = true; begin = performance.now(); }
      const name = ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ? sql : sql.includes("enroll_model_objects") ? "enroll" :
        sql.includes("guard_model_publication") ? "guard" : sql.includes("publish_model_run") ? "publish" : transaction ? "dataset" : "prepare";
      event(`sql:${name}`);
      const result = await Reflect.apply(target.query, target, args);
      if (sql.includes("lock_object_for_publication") || sql.includes("guard_model_publication")) lockResponse = performance.now();
      if (sql === "COMMIT") {
        const end = performance.now(); transactionMs = end - begin; lockResponseToCommitMs = end - lockResponse;
        transaction = false;
      }
      if (sql === "ROLLBACK") transaction = false;
      return result;
    };
  } });
  const objects: ObjectStore = { ...store,
    get: async key => { event("get"); return store.get(key); },
    head: async key => { event("head"); return store.head(key); },
    putIfAbsent: async (key, bytes) => { event("put"); return store.putIfAbsent(key, bytes); },
  };
  const started = performance.now();
  try {
    const result = await run(observed, objects);
    assert(transactionMs > 0 && lockResponse > begin, "incomplete-transaction-measurement");
    return { result, transactionMs, lockResponseToCommitMs, endToEndMs: performance.now() - started, work: summarizeWork(events) };
  } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
};

// Opt-in benchmark: never imported by CI. Keep every sample, including misses.
const directory = new URL("codex-briefs/node_modules/", EVALUATION_ROOT);
await mkdir(directory, { recursive: true });
const root = await realpath(await mkdtemp(new URL("165-benchmark-", directory).pathname));
const store = await openLocalObjectStore(root), source = await evaluationCodeIdentity();
const paths = ["services/pipeline/scripts/feature-store/model-publication-benchmark.ts", "compose.test.yml"];
const benchmarkHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, sha256(await readFile(new URL(path, EVALUATION_ROOT)))])));
const trials: Trial[] = [];
const receipt: Record<string, unknown> = { schemaVersion: 1, issue: 165, step: 4, startedAt: new Date().toISOString(),
  runtime: process.version, machine: { arch: arch(), platform: platform(), release: release() },
  ...source, benchmarkHashes, storageRoot: root, trials, baselineCommit, verdict: "running",
  fixtureConfig: { postgresTmpfsBytes: 512 * 1024 * 1024, sharedMemoryBytes: 128 * 1024 * 1024 },
  boundary: "BEGIN dispatch to COMMIT response; conservative upper bound on address-lock hold. Lock-response-to-COMMIT is a client lower bound only.",
  method: "Six baseline-only samples first, then six ABBA blocks per candidate (twelve samples per arm per series). Nearest-rank p95 and every block max(candidate)/min(baseline) <=0.70.",
  cacheState: "Warm/unflushed OS, database and file caches; existing restricted connection; immutable object reuse after first publication; no cold/hosted claim.",
  endToEnd: "Informational only. Full publisher includes input validation, reads, scoring, hashing, serialization, preflight, enrollment, uploads and publication. Retained transport excludes report preparation.",
  limitations: ["Retained transport uses the final proposal SQL, actual ObjectStore and the same protocol, but its copied SQL orchestration is not the runtime publisher. Archived envelope IDs do not match the scratch DB; no semantic provenance pass is claimed for that arm.",
    "The separate full-publisher series exercises the actual runtime with freshly scored envelopes whose pins match SQL. Fresh report sizes/hashes are recorded; they need not equal the archived byte-volume fixtures.",
    "The unchanged dataset baseline inserts 2504 memberships and hashes its bytes twice inside the transaction; the model registry inserts a fixed publication set. This expected work difference is preserved.",
    "Crypto and query observation add local instrumentation overhead to both arms; no observer SQL runs inside timing."] };
const receiptPath = process.env.FS165_BENCHMARK_EVIDENCE ?? new URL("codex-briefs/165-step-4-benchmark.json", EVALUATION_ROOT);
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
await save();
try {
  // Prove the baseline implementation body was not repaired during #165.
  const baselineSource = (await promisify(execFile)("git", ["show", `${baselineCommit}:services/pipeline/src/featureStore/datasets.ts`],
    { cwd: EVALUATION_ROOT })).stdout;
  const currentSource = await readFile(new URL("services/pipeline/src/featureStore/datasets.ts", EVALUATION_ROOT), "utf8");
  const body = (text: string) => text.slice(text.indexOf("export const buildDataset ="), text.indexOf("// Trusted pipeline callback:"));
  assert.equal(body(currentSource), body(baselineSource), "dataset-baseline-changed");
  receipt.baselineFunctionSha256 = sha256(Buffer.from(body(currentSource)));
  await withFeatureStoreDatabase(async context => {
    receipt.database = (await context.admin.query("SELECT version() AS version")).rows[0].version;
    const fixture = await prepareEvaluationFixture(context, store, source.code, event => console.log(JSON.stringify(event)));
    const retrospective = fixture.prepared.find(p => p.mode === "retrospective-reconstruction-v1")!;
    const strict = fixture.prepared.find(p => p.mode === "strict-point-in-time-v1")!;
    assert.equal(retrospective.dataset.rowCount, EXPECTED_COHORT.examples); assert.equal(strict.dataset.rowCount, 0);
    receipt.fixture = { wireFiles: fixture.pins.inputs.length, snapshots: fixture.pins.snapshots.length,
      inputPinsArtifact: fixture.inputPinsArtifact, modes: fixture.prepared.map(p => ({ mode: p.mode, ...p.dataset, spec: p.spec })) };
    const baseline = async () => {
      const measured = await measure(context.writer, store, (database, objects) => buildDataset(database, objects, retrospective.spec, source.code));
      assert.equal(measured.result.rowCount, 2504); assert.equal(measured.result.contentSha256, EXPECTED_COHORT.contentSha256);
      assert.equal(measured.work.statements, 8); assert.equal(measured.work.transactionStatements, 5);
      assert.equal(measured.work.transactionHashes, 2); assert.equal(measured.work.transactionHeads, 1);
      assert.equal(measured.work.transactionUploads, 0); assert.equal(measured.work.transactionObjectReads, 0);
      return measured;
    };
    const record = async (arm: Arm, phase: Trial["phase"], block: number, position: number, run: () => Promise<Omit<Trial, "arm" | "phase" | "block" | "position">>) => {
      const trial = { arm, phase, block, position, ...await run() };
      trials.push(trial); await save(); console.log(JSON.stringify(trial));
    };
    const baselineTrial = async () => {
      const { result, ...measurement } = await baseline();
      assert(result.datasetId); return measurement;
    };
    for (let i = 0; i < 6; i++) await record("baseline", "baseline-first", 0, i, baselineTrial);
    receipt.baselineFirstP95Ms = percentile(trials.map(t => t.transactionMs), .95);
    await save();
    // Initial dataset baseline precedes installation of the candidate proposal.
    await context.admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/165_model_manifests.sql")), "utf8"));
    const identity = { format: "qb-model-run-v1", designation: "uncalibrated-interim-hit-rate", modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
      scoringPolicy: QB_EVALUATOR_VERSION, adapter: EMPIRICAL_ADAPTER, preregistration: MODEL_PREREGISTRATION, code: source.code };
    const retained = [
      { slot: retrospective.mode, datasetId: retrospective.dataset.datasetId, hash: "07ede5c2d95897479d9033a98722dd569f6fa46f8b30a7bf124da1ab99366ddf", size: 9290168 },
      { slot: strict.mode, datasetId: strict.dataset.datasetId, hash: "40d29a3533d1534915703d6739a84eb279f62771f6ae78ff3b7c6ae0e7679b1d", size: 306544 },
    ];
    const reportRoot = process.env.FS165_RETAINED_ROOT ?? "/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-164-data/objects/";
    const reportBytes = await Promise.all(retained.map(r => readFile(new URL(`audits/${r.hash}`, new URL(reportRoot.endsWith("/") ? reportRoot : reportRoot + "/", "file://")))));
    reportBytes.forEach((bytes, i) => { assert.equal(bytes.byteLength, retained[i].size); assert.equal(sha256(bytes), retained[i].hash); });
    const reportPins = retained.map(r => ({ slot: r.slot, datasetId: r.datasetId, objectKey: `audits/${r.hash}`, fileSha256: r.hash, byteSize: r.size }));
    const descriptorBytes = Buffer.from(JSON.stringify({ format: "dfs165-retained-transport-benchmark-v1", identity, reportPins,
      limitation: "Archived envelopes are exact byte-volume fixtures, not matching report provenance for this scratch database." }) + "\n");
    const descriptorHash = sha256(descriptorBytes);
    const pins = [{ slot: "descriptor", datasetId: null, objectKey: `models/${descriptorHash}`, fileSha256: descriptorHash, byteSize: descriptorBytes.byteLength }, ...reportPins];
    const payloads = [descriptorBytes, ...reportBytes], ids = reportPins.map(r => r.datasetId).sort(), addresses = pins.map(p => p.objectKey).sort();
    receipt.retainedPayloads = pins;
    const transport = async () => {
      const parameters = [JSON.stringify(identity), JSON.stringify(pins)];
      const measured = await measure(context.writer, store, async (database, objects) => {
        const absent: string[] = [];
        for (const pin of pins) if (!await objects.head(pin.objectKey)) absent.push(pin.objectKey);
        await database.query("SELECT fs138.enroll_model_objects($1::text[])", [absent]);
        for (const [i, pin] of pins.entries()) await objects.putIfAbsent(pin.objectKey, payloads[i]);
        await database.query("BEGIN");
        try {
          await database.query("SELECT fs138.guard_model_publication($1::uuid[],$2::text[])", [ids, addresses]);
          for (const pin of pins) {
            const object = await objects.head(pin.objectKey);
            assert(object && object.key === pin.objectKey && object.sha256 === pin.fileSha256 && object.byteSize === pin.byteSize);
          }
          const published = await database.query("SELECT * FROM fs138.publish_model_run($1::jsonb,$2::jsonb)", parameters);
          await database.query("COMMIT");
          return published.rows[0].run_id as string;
        } catch (error) { await database.query("ROLLBACK"); throw error; }
      });
      const { result, ...measurement } = measured;
      assert(result);
      return { ...measurement, artifacts: pins };
    };
    const full = async () => {
      const measured = await measure(context.writer, store, (database, objects) => publishQbModelRun(database, objects, fixture.inputPinsArtifact, { code: source.code }));
      const { result, ...measurement } = measured;
      return { ...measurement, artifacts: [result.descriptor, ...result.reports] };
    };
    const series = [];
    for (const [index, arm] of (["retained-transport", "full-publisher"] as const).entries()) {
      for (let round = 1; round <= 6; round++) {
        const block = index * 6 + round;
        for (const [position, selected] of (["baseline", arm, arm, "baseline"] as const).entries())
          await record(selected, "interleaved", block, position, selected === "baseline" ? baselineTrial : arm === "retained-transport" ? transport : full);
      }
      const selected = trials.filter(t => t.phase === "interleaved" && t.block > index * 6 && t.block <= (index + 1) * 6);
      const baselineP95Ms = percentile(selected.filter(t => t.arm === "baseline").map(t => t.transactionMs), .95);
      const candidateP95Ms = percentile(selected.filter(t => t.arm === arm).map(t => t.transactionMs), .95);
      const blocks = Array.from({ length: 6 }, (_, n) => {
        const block = index * 6 + n + 1, values = selected.filter(t => t.block === block);
        const fastestBaselineMs = Math.min(...values.filter(t => t.arm === "baseline").map(t => t.transactionMs));
        const slowestCandidateMs = Math.max(...values.filter(t => t.arm === arm).map(t => t.transactionMs));
        return { block, fastestBaselineMs, slowestCandidateMs, headroom: 1 - slowestCandidateMs / fastestBaselineMs,
          pass: slowestCandidateMs <= .7 * fastestBaselineMs };
      });
      series.push({ arm, baselineP95Ms, candidateP95Ms, headroom: 1 - candidateP95Ms / baselineP95Ms, blocks,
        pass: candidateP95Ms <= .7 * baselineP95Ms && blocks.every(b => b.pass) });
    }
    for (const trial of trials.filter(t => t.arm !== "baseline")) {
      const w = trial.work;
      assert.equal(w.preflightHeads, 3); assert.equal(w.transactionHeads, 3);
      assert.equal(w.publicationStatements, 5); assert.equal(w.transactionStatements, 4);
      assert.equal(w.uploads, 3); assert.equal(w.transactionHashes, 0);
      assert.equal(w.transactionObjectReads, 0); assert.equal(w.transactionUploads, 0);
      if (trial.arm === "full-publisher") { assert.equal(w.preparationStatements, 6); assert.equal(w.objectReads, 6); }
    }
    receipt.series = series; receipt.verdict = series.every(s => s.pass) ? "pass" : "fail";
  });
} catch (error) { receipt.verdict = "fail"; receipt.failure = String(error); }
finally {
  assert.deepEqual(await evaluationCodeIdentity(), source, "source-changed-during-benchmark");
  for (const [path, digest] of Object.entries(benchmarkHashes)) assert.equal(sha256(await readFile(new URL(path, EVALUATION_ROOT))), digest);
  receipt.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ verdict: receipt.verdict, baselineFirstP95Ms: receipt.baselineFirstP95Ms, series: receipt.series }));
if (receipt.verdict !== "pass") process.exitCode = 1;
