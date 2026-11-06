import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EXPECTED_COHORT, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { modelPublicationCodeIdentity } from "./model-publication-identity.ts";
import { compactPredictionBenchmark, compositeCohortSummary, type FullPredictionBenchmark } from "./artifact-governance-evidence.ts";
import type { CompositeCase, CompositeSample } from "./composite-authorization-measure.ts";
import { createPredictionMeasurement, predictionRequest } from "./prediction-measure.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { resolveModelContext } from "../../src/featureStore/modelContext.ts";
import { readModelArtifacts } from "../../src/featureStore/modelArtifacts.ts";
import { publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { assertCompositeWork, installCompositeWorkOracle, measureCompositeWork,
  observeRightsCalls, unionProfiles } from "../../tests/feature-store/composite-read-work.ts";

const sourceIdentity = async () => {
  const base = await modelPublicationCodeIdentity();
  const paths = ["packages/db/proposals/166_artifact_governance.sql", "packages/db/proposals/231_composite_authorization.sql",
    "packages/db/proposals/229_mandatory_recovery.sql", "compose.test.yml",
    "services/pipeline/scripts/feature-store/prediction-benchmark.ts",
    "services/pipeline/scripts/feature-store/prediction-measure.ts",
    "services/pipeline/src/featureStore/predict.ts", "services/pipeline/src/featureStore/predictionHelpers.ts",
    "services/pipeline/scripts/feature-store/composite-authorization-benchmark.ts",
    "services/pipeline/scripts/feature-store/composite-authorization-measure.ts",
    "services/pipeline/scripts/feature-store/artifact-governance-evidence.ts",
    "services/pipeline/tests/feature-store/composite-read-work.ts", "services/pipeline/tests/feature-store/artifact-read-work.ts"];
  const extra = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL(path, EVALUATION_ROOT)))])));
  const codeHashes = Object.fromEntries(Object.entries({ ...base.codeHashes, ...extra })
    .sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
  const codeBlobIds = Object.fromEntries(await Promise.all(Object.keys(codeHashes).map(async path =>
    [path, execFileSync("git", ["hash-object", "--stdin"], { input: await readFile(new URL(path, EVALUATION_ROOT)), encoding: "utf8" }).trim()])));
  return { code: { gitSha: base.code.gitSha, contentSha256: sha256(Buffer.from(JSON.stringify(codeHashes))) }, codeHashes, codeBlobIds };
};
const directory = resolve(process.env.FS167_BENCHMARK_DIRECTORY ?? "codex-briefs/167-final");
await mkdir(directory, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(directory, "benchmark-"));
await mkdir(join(root, "objects"), { mode: 0o700 });
const store = await openLocalObjectStore(join(root, "objects"));
const source = await sourceIdentity(), inputSource = await evaluationCodeIdentity();
const samples: CompositeSample[] = [];
const full: FullPredictionBenchmark = { kind: "local-prediction-benchmark", schemaVersion: 1, issue: 167, step: 3, verdict: "running",
  startedAt: new Date().toISOString(), runtime: process.version, machine: { arch: arch(), platform: platform(), release: release() },
  ...source, inputGeneration: inputSource, storageRoot: relative(process.cwd(), join(root, "objects")), samples, cohorts: [],
  fixtureConfig: { postgresTmpfsBytes: 512 * 1024 * 1024, sharedMemoryBytes: 128 * 1024 * 1024 },
  method: { baselineFirstRequests: 45, temperatures: ["cold", "warm"], cohortsPerTemperature: 3,
    order: ["baseline", "candidate", "candidate", "baseline"], requestsPerPosition: 50,
    candidateRequestsPerCohort: 100, referenceRequestsPerCohort: 100,
    gate: "Every candidate cohort nearest-rank full-path p95 <=210 ms, >=30% headroom under 300 ms; failures stop and are retained.",
    composition: "Public predictQbModel: request validation -> resolver -> composite Q1 -> descriptor GET/parse/compatibility -> pure forecast -> Q2 -> response/serialization -> final delivery/deadline check.",
    reference: "Unchanged #163 createEmpiricalAdapter; measured first before #231 SQL installation; target-independent requests selected from feature metadata.",
    cold: "Fresh restricted PostgreSQL connection in a running Node process; setup included in total and reported separately. Close outside timing.",
    warm: "Existing dedicated idle READ COMMITTED connection; setup zero. Cold/warm are connection states, not cache states.",
    observation: "SQL/ObjectStore/hash observers on both arms; authentication hashes are setup, not artifact rehashing. Server counters/rights instrumentation removed before timing. Candidate computeMs/serializationMs are zero (not separately instrumented); both remain inside totalMs. Observer validation overhead is included. Cold deadline starts before connect." },
  qualification: "LOCAL-FIXTURE ONLY. OS/DB/file caches unflushed; no hosted RTT/wake/region (#220), cold-cache or fresh-process claim.",
  limitations: ["Strict historical eligibility remains zero; all real requests are retrospective and retain real producer knowledge clocks.",
    "Reference authorizes the feature only and performs its unchanged per-row qualification; candidate authorizes model plus feature and trusts producer-qualified materialization. Ratios are informational.",
    "Synthetic PIT/correction/race/independent-lineage controls live in the behavior receipts; no synthetic histories qualify this real-fixture speed result.",
    "Internal math and serialization are deliberately not instrumented; only the public handler and its full serialized output qualify the candidate."] };
const fullPath = join(root, "full-samples.json");
const save = () => writeFile(fullPath, JSON.stringify(full, null, 2) + "\n");
await save();
try {
  await withFeatureStoreDatabase(async database => {
    full.database = (await database.admin.query("SELECT version() AS version")).rows[0].version;
    const fixture = await prepareEvaluationFixture(database, store, inputSource.code, event => console.log(JSON.stringify(event)));
    const retro = fixture.prepared.find(p => p.mode === "retrospective-reconstruction-v1")!;
    assert.equal(fixture.prepared.find(p => p.mode === "strict-point-in-time-v1")!.dataset.rowCount, 0);
    assert.equal(retro.dataset.rowCount, EXPECTED_COHORT.examples); assert.equal(retro.dataset.contentSha256, EXPECTED_COHORT.contentSha256);
    full.fixture = { wireFiles: fixture.pins.inputs.length, inputs: fixture.pins.inputs,
      modes: fixture.prepared.map(p => ({ mode: p.mode, rowCount: p.dataset.rowCount, contentSha256: p.dataset.contentSha256 })),
      inputPinsArtifact: fixture.inputPinsArtifact };
    const knownAsOf = (await database.admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at as string;
    // No labels or dataset membership participate in request selection.
    const cases: CompositeCase[] = (await database.admin.query(`SELECT DISTINCT ON(f.sample_size)
      f.feature_id,f.player_id,f.game_id,f.sample_size FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
      WHERE f.state='usable' AND f.sample_size BETWEEN 2 AND 16 AND f.cutoff IS NOT NULL
      AND f.feature_version=$1 AND f.history_policy=$2 AND f.evidence_mode='retrospective-reconstruction-v1'
      AND f.computed_at<=$3 AND f.checkpoint<=$3 AND j.status='succeeded' AND j.finished_at<=$3
      ORDER BY f.sample_size,f.player_id,f.game_id,f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC`,
    [FEATURE_VERSION, HISTORY_POLICY, knownAsOf])).rows.map(row => ({ featureId: row.feature_id, n: row.sample_size,
      request: { playerId: row.player_id, gameId: row.game_id, knownAsOf, featureVersion: FEATURE_VERSION,
        historyPolicy: HISTORY_POLICY, evidenceMode: "retrospective-reconstruction-v1" } }));
    assert.deepEqual(cases.map(c => c.n), Array.from({ length: 15 }, (_, i) => i + 2));
    full.requests = { cases, sha256: sha256(Buffer.from(JSON.stringify(cases))), selection: "Feature metadata only; one real request at every n=2..16; no label/membership gate." };
    const referenceMeasure = await createPredictionMeasurement(store, "not-used-by-reference");
    for (let read = 1; read <= 45; read++) {
      const sample = { phase: "baseline-first" as const, cohort: 0, position: 0, read,
        ...await referenceMeasure({ arm: "baseline", temperature: "warm", input: cases[(read - 1) % cases.length], connection: database.reader }) };
      samples.push(sample); await save(); assert.equal(sample.verdict, "pass", "baseline-first-failed");
    }
    full.baselineFirstP95Ms = [...samples].map(s => s.totalMs).sort((a, b) => a - b)[Math.ceil(45 * .95) - 1];
    for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "229_mandatory_recovery.sql", "231_composite_authorization.sql"])
      await database.admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
    const publication = await publishQbModelRun(database.writer, store, fixture.inputPinsArtifact, { code: source.code });
    const descriptor = await store.get(publication.descriptor.objectKey);
    assert.equal(sha256(descriptor), publication.descriptor.fileSha256);
    assert.deepEqual(JSON.parse(descriptor.toString()).identity, publication.identity);
    full.publication = publication;
    const handlerRequests = cases.map(input => predictionRequest(publication.runId, input));
    full.handlerRequests = { values: handlerRequests, sha256: sha256(Buffer.from(JSON.stringify(handlerRequests))) };
    const restricted = await database.createReaderConfig(), referenceConfig = await database.createReaderConfig();
    await database.admin.query(`REVOKE fs138_reader FROM ${restricted.user}`);
    await database.admin.query(`GRANT fs231_model_reader TO ${restricted.user} WITH INHERIT TRUE, SET FALSE`);
    const client = new Client(restricted); await client.connect();
    try {
      let modelOnlySql = 0;
      const only = await readModelArtifacts({ query: async (...args: unknown[]) => {
        modelOnlySql++; return Reflect.apply(database.reader.query, database.reader, args);
      } } as Pick<Client, "query">, store, { runId: publication.runId, slots: ["descriptor"] });
      assert.equal(modelOnlySql, 2); assert.equal(only.value.files.length, 1);
      full.modelOnly = { sql: modelOnlySql, descriptorGets: only.value.files.length, verdict: "pass" };
      // Database work is measured on the actual real requests, outside latency.
      const restore = await installCompositeWorkOracle(database.admin), calls = observeRightsCalls(client), serverWork = [];
      try {
        for (const input of cases) {
          const context = await resolveModelContext(client, input.request);
          assert.equal(context.feature.featureId, input.featureId);
          const profiles = await unionProfiles(database.admin, publication.runId, input.featureId); calls.reset();
          const q1 = await measureCompositeWork(client, publication.runId, context, true);
          const q2 = await measureCompositeWork(client, publication.runId, context, false);
          assertCompositeWork(q1); assertCompositeWork(q2);
          assert.equal(calls.profiles.length, 2 * profiles.length);
          for (const profile of profiles) assert.equal(calls.profiles.filter(p => p === profile).length, 2);
          serverWork.push({ n: input.n, featureId: input.featureId, profiles, rightsCalls: calls.profiles.length, q1, q2, verdict: "pass" });
        }
      } finally { calls.close(); await restore(); }
      full.serverWork = serverWork;
      const measure = await createPredictionMeasurement(store, publication.runId);
      for (const temperature of ["cold", "warm"] as const) for (let cohort = 1; cohort <= 3; cohort++) {
        const current: CompositeSample[] = [];
        for (const [position, arm] of (["baseline", "candidate", "candidate", "baseline"] as const).entries()) {
          for (let read = 1; read <= 50; read++) {
            const input = cases[((position < 2 ? 0 : 50) + read - 1) % cases.length];
            const connection = temperature === "cold" ? arm === "candidate" ? restricted : referenceConfig
              : arm === "candidate" ? client : database.reader;
            const sample = { phase: "interleaved" as const, cohort, position, read, ...await measure({ arm, temperature, input, connection }) };
            samples.push(sample); current.push(sample);
            if (sample.verdict !== "pass") { await save(); assert.fail("full-path-work-or-read-target-missed; failed sample retained"); }
          }
        }
        const summary = compositeCohortSummary(current, temperature, cohort); full.cohorts.push(summary);
        await save(); console.log(JSON.stringify({ stage: "cohort", ...summary }));
        assert(summary.pass, "full-path-cohort-210ms-target-missed; stop without relaxing");
      }
    } finally { await client.end(); }
  });
  full.verdict = "pass";
} catch (error) { full.verdict = "fail"; full.error = String(error); process.exitCode = 1; }
finally {
  try { assert.deepEqual(await sourceIdentity(), source); assert.deepEqual(await evaluationCodeIdentity(), inputSource); full.sourceUnchanged = true; }
  catch (error) { full.verdict = "fail"; full.sourceError = String(error); process.exitCode = 1; }
  full.finishedAt = new Date().toISOString(); await save();
  await writeFile(join(root, "receipt.json"), JSON.stringify(compactPredictionBenchmark(await readFile(fullPath), relative(process.cwd(), fullPath)), null, 2) + "\n");
}
console.log(JSON.stringify({ verdict: full.verdict, fullPath: relative(process.cwd(), fullPath), error: full.error }));
