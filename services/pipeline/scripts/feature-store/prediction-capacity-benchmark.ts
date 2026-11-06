import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, platform, release, totalmem, cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client } from "pg";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";
import { checkConnectedTarget } from "@dfs-ev/db-tooling/migrations/core";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EXPECTED_COHORT, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { modelPublicationCodeIdentity } from "./model-publication-identity.ts";
import { CAPACITY_ORDER, capacityTrial, compactCapacityBenchmark, type FullCapacityBenchmark } from "./prediction-capacity-evidence.ts";
import { capacityHash, discoverCapacityRequests, selectCapacityManifest } from "./prediction-capacity-workload.ts";
import { createCapacityProcess } from "./prediction-capacity-process.ts";
import { resolveModelContext } from "../../src/featureStore/modelContext.ts";
import { readModelArtifacts } from "../../src/featureStore/modelArtifacts.ts";
import { publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import { deleteDatasets } from "../../src/featureStore/governance.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";
import { assertCompositeWork, installCompositeWorkOracle, measureCompositeWork,
  observeRightsCalls, unionProfiles } from "../../tests/feature-store/composite-read-work.ts";

const identity = async (requireCommitted: boolean) => {
  const [base, input] = await Promise.all([modelPublicationCodeIdentity(), evaluationCodeIdentity()]);
  const directory = "services/pipeline/scripts/feature-store/";
  const extra = ["compose.test.yml", "packages/db/proposals/166_artifact_governance.sql",
    "packages/db/proposals/229_mandatory_recovery.sql", "packages/db/proposals/231_composite_authorization.sql",
    "services/pipeline/tests/feature-store/composite-read-work.ts", "services/pipeline/tests/feature-store/artifact-read-work.ts",
    ...((await readdir(new URL(directory, EVALUATION_ROOT))).filter(n => n.startsWith("prediction-") && /\.(ts|mjs)$/.test(n)).map(n => directory + n)),
    directory + "artifact-governance-evidence.ts", directory + "evidence-bundle.ts"];
  const paths = [...new Set([...Object.keys(base.codeHashes), ...Object.keys(input.codeHashes), ...extra])].sort();
  const codeHashes: Record<string, string> = {}, codeBlobIds: Record<string, string> = {};
  for (const path of paths) {
    const bytes = await readFile(new URL(path, EVALUATION_ROOT)); codeHashes[path] = sha256(bytes);
    codeBlobIds[path] = execFileSync("git", ["hash-object", "--stdin"], { input: bytes, encoding: "utf8" }).trim();
    if (requireCommitted) assert.equal(execFileSync("git", ["rev-parse", `HEAD:${path}`], { encoding: "utf8" }).trim(), codeBlobIds[path],
      `capacity-requires-final-committed-source:${path}`);
  }
  return { code: { gitSha: base.code.gitSha, contentSha256: capacityHash(codeHashes) }, codeHashes, codeBlobIds };
};

export const runPredictionCapacity = async (controlsOnly = false) => {
  assert.equal(Number(process.versions.node.split(".")[0]), 24, "capacity-requires-node24");
  assertNoApplicationCredentials(process.env);
  assert(!process.env.NODE_OPTIONS && !process.env.NODE_COMPILE_CACHE, "capacity-loader-options-refused");
  const source = await identity(!controlsOnly), inputSource = await evaluationCodeIdentity();
  const directory = resolve(process.env.FS168_BENCHMARK_DIRECTORY ?? "codex-briefs/168-final");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(directory, controlsOnly ? "controls-" : "qualification-")), storageRoot = join(root, "objects");
  await mkdir(storageRoot, { mode: 0o700 }); const store = await openLocalObjectStore(storageRoot);
  const full = { kind: "prediction-capacity-benchmark", schemaVersion: 1, issue: 168, step: controlsOnly ? 1 : 2, verdict: "running",
    startedAt: new Date().toISOString(), ...source, inputGeneration: inputSource, samples: [], trials: [], warmSetup: {},
    runtime: process.version, loader: "Node 24 native type stripping", controlsOnly,
    machine: { arch: arch(), platform: platform(), release: release(), memoryBytes: totalmem(), cpu: cpus()[0].model },
    cache: { os: "unflushed; fixture preparation warms file cache", postgres: "running; unflushed and warmed by fixture preparation",
      application: "fresh process per cold sample; one dedicated process/connection per warm trial; no forecasts/artifacts/rights cached" },
    fixtureConfig: { postgresTmpfsBytes: 512 * 1024 * 1024, sharedMemoryBytes: 128 * 1024 * 1024 },
    method: { order: CAPACITY_ORDER, samplesPerTrial: 100, percentile: "nearest-rank ceil(0.95*N)-1",
      boundary: "parent before spawn/send through complete serialized IPC receipt; cleanup outside timing",
      deadlineMs: 300, p95Ms: 210, loader: "Node 24 native type stripping",
      phases: "spawn event overlaps bootstrap; bootstrap + import + store + connect is startup; handler includes math/serialization; residual includes IPC and observers",
      stop: "first refusal/error/work mismatch/deadline/startup threat, or first completed trial p95 miss; no replacement or pooled gate" },
    qualification: "LOCAL FIXTURE ONLY; fresh application process, not cold disk/database; no hosted/concurrency-throughput claim",
    storageRoot: relative(process.cwd(), storageRoot), manifestPinnedBeforeTiming: false,
  } as unknown as FullCapacityBenchmark;
  const path = join(root, "full-samples.json"), save = () => writeFile(path, JSON.stringify(full, null, 2) + "\n");
  await save();
  const leaseConfig = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL), lease = new Client(leaseConfig);
  const interrupted = new AbortController();
  lease.on("error", () => interrupted.abort());
  try {
    await lease.connect(); await checkConnectedTarget(lease, leaseConfig);
    assert((await lease.query(`SELECT pg_try_advisory_lock(153045::integer,
      (SELECT oid::integer FROM pg_database WHERE datname=current_database())) AS acquired`)).rows[0].acquired, "feature-store-suite-lease-busy");
    await withFeatureStoreDatabase(async database => {
      full.database = (await database.admin.query("SELECT version() AS version")).rows[0].version;
      const fixture = await prepareEvaluationFixture(database, store, inputSource.code, event => console.log(JSON.stringify(event)));
      const retro = fixture.prepared.find(p => p.mode === "retrospective-reconstruction-v1")!;
      const strict = fixture.prepared.find(p => p.mode === "strict-point-in-time-v1")!;
      assert.equal(retro.dataset.rowCount, EXPECTED_COHORT.examples); assert.equal(retro.dataset.contentSha256, EXPECTED_COHORT.contentSha256);
      assert.equal(strict.dataset.rowCount, 0); assert.equal(fixture.pins.inputs.length, 16);
      full.fixture = { wireFiles: fixture.pins.inputs.length, rowCount: retro.dataset.rowCount,
        contentSha256: retro.dataset.contentSha256, strictRows: strict.dataset.rowCount, inputs: fixture.pins.inputs };
      for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "229_mandatory_recovery.sql", "231_composite_authorization.sql"])
        await database.admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
      const publication = await publishQbModelRun(database.writer, store, fixture.inputPinsArtifact, { code: source.code });
      full.publication = publication;
      const known = (await database.admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at;
      const candidates = await discoverCapacityRequests(database.admin, publication.runId, known);
      full.manifest = selectCapacityManifest(candidates); full.manifestSha256 = capacityHash(full.manifest);
      full.candidateCount = candidates.length;
      // Immutable pin precedes even the first controls/timed request.
      await writeFile(join(root, "request-list.json"), JSON.stringify(full.manifest), { flag: "wx" });
      full.manifestPinnedBeforeTiming = true; await save();
      const config = { ...await database.createReaderConfig(), statement_timeout: 300, query_timeout: 300 };
      await database.admin.query(`REVOKE fs138_reader FROM ${config.user}`);
      await database.admin.query(`GRANT fs231_model_reader TO ${config.user} WITH INHERIT TRUE, SET FALSE`);
      const reader = new Client(config); await reader.connect();
      try {
        let sql = 0, gets = 0;
        await readModelArtifacts({ query: (...args: unknown[]) => { sql++; return Reflect.apply(database.reader.query, database.reader, args); } } as Pick<Client, "query">,
          { get: async key => { gets++; return store.get(key); } }, { runId: publication.runId, slots: ["descriptor"] });
        full.modelOnly = { sql, gets }; assert.deepEqual(full.modelOnly, { sql: 2, gets: 1 });
        const restore = await installCompositeWorkOracle(database.admin), calls = observeRightsCalls(reader);
        full.serverWork = [];
        try {
          for (const n of full.manifest.rules.n) {
            const request = full.manifest.requests.find(r => r.n === n)!;
            const context = await resolveModelContext(reader, request.request); assert.equal(context.feature.featureId, request.featureId);
            const profiles = await unionProfiles(database.admin, publication.runId, request.featureId); calls.reset();
            const q1 = await measureCompositeWork(reader, publication.runId, context, true);
            const q2 = await measureCompositeWork(reader, publication.runId, context, false);
            assertCompositeWork(q1); assertCompositeWork(q2); assert.equal(calls.profiles.length, 2 * profiles.length);
            for (const p of profiles) assert.equal(calls.profiles.filter(s => s === p).length, 2);
            full.serverWork.push({ n, profiles, rightsCalls: calls.profiles.length, q1, q2 });
          }
        } finally { calls.close(); await restore(); }
      } finally { await reader.end(); }
      await save();
      for (const name of controlsOnly ? ["C1", "W1"] : CAPACITY_ORDER) {
        const temperature = name.startsWith("C") ? "cold" : "warm", trial = Number(name[1]);
        const options = { config, storageRoot, signal: interrupted.signal };
        const warm = temperature === "warm" ? createCapacityProcess(options) : undefined;
        const current = [];
        try {
          if (warm) {
            const setup = await warm.prepare(); full.warmSetup![name] = setup;
            assert.equal(setup.kind, "ready", JSON.stringify(setup)); await save();
          }
          for (const [index, request] of full.manifest.requests.entries()) {
            if (controlsOnly && index > 0) break;
            const worker = warm ?? createCapacityProcess(options);
            try {
              const sample = await worker.measure(request, temperature, trial, index);
              full.samples.push(sample); current.push(sample); await save();
              assert.equal(sample.verdict, "pass", `capacity-sample-failed; retained: ${sample.error}`);
              assert(sample.totalMs <= 300 && sample.startupMs <= 210, "capacity-deadline-or-startup-target-missed");
            } finally { if (!warm) await worker.close(); }
          }
          if (!controlsOnly) {
            const summary = capacityTrial(current, name); full.trials.push(summary); await save();
            console.log(JSON.stringify({ stage: "trial", ...summary })); assert(summary.pass, "capacity-trial-missed; stop without relaxation");
          }
        } finally { await warm?.close(); }
      }
      // A separate existing process/connection must see fresh rights and legal
      // status. These deliberate refusals are never latency successes.
      const worker = createCapacityProcess({ config, storageRoot, signal: interrupted.signal });
      try {
        assert.equal((await worker.prepare()).kind, "ready");
        const request = full.manifest.requests[0], before = await worker.measure(request, "warm", 0, 0);
        assert.equal(before.verdict, "pass");
        const profile = (await unionProfiles(database.admin, publication.runId, request.featureId))[0];
        await database.admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,valid_until,rationale)
          VALUES($1,'{}','2020-01-01',NULL,'#168 warm rights control')`, [profile]);
        const denied = await worker.measure(request, "warm", 0, 1);
        assert.deepEqual(JSON.parse(denied.serialized!), { status: "unavailable", reason: "model-current-rights-refused" });
        await deleteDatasets(database.writer, [retro.dataset.datasetId], "#168 warm legal-status control", 300);
        const deleted = await worker.measure(request, "warm", 0, 2);
        assert.deepEqual(JSON.parse(deleted.serialized!), { status: "unavailable", reason: "model-read-status-refused" });
        assert.equal(before.pid, denied.pid); assert.equal(before.pid, deleted.pid);
        full.warmControls = { rightsRefusal: true, deletionRefusal: true, sameProcess: true };
        full.warmControlSamples = [before, denied, deleted];
      } finally { await worker.close(); }
    });
    full.verdict = controlsOnly ? "controls-pass-not-qualified" : "pass";
  } catch (error) { full.verdict = "fail"; full.error = String(error); process.exitCode = 1; }
  finally {
    await lease.end().catch(() => {});
    try { assert.deepEqual(await identity(!controlsOnly), source); full.sourceUnchanged = true; }
    catch (error) { full.verdict = "fail"; full.sourceError = String(error); process.exitCode = 1; }
    full.finishedAt = new Date().toISOString(); await save();
    const bytes = await readFile(path), key = objectKey("audits", bytes);
    await store.putIfAbsent(key, bytes); assert.deepEqual(await store.get(key), bytes);
    await writeFile(join(root, "receipt.json"), JSON.stringify(compactCapacityBenchmark(bytes, relative(process.cwd(), path)), null, 2) + "\n");
  }
  console.log(JSON.stringify({ verdict: full.verdict, fullPath: relative(process.cwd(), path), error: full.error }));
};
