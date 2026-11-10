import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "./harness.ts";
import { compactBehavior } from "./artifact-governance-evidence.ts";
import { visibilityCohorts, visibilityP95, visibilityProjection, type VisibilityBenchmark, type VisibilitySample } from "./job-visibility-evidence.ts";
import { loadJobVisibilityWorkFixture } from "../../tests/feature-store/job-visibility-work-fixture.ts";
import { buildDataset, DATASET_JOIN_SQL, readDataset } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, HISTORY_POLICY, runDerivedJob } from "../../src/featureStore/derived.ts";
import { createEmpiricalAdapter } from "../../src/featureStore/empiricalAdapter.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

// Absolute final-source qualification. Only dataset selection and #163 compare
// the old read SQL; the producer baseline's retained resource exception is final.
const baselineCommit = "dc0050a6a9f071c149098047d1428757245829cd";
const old = (path: string) => execFileSync("git", ["show", baselineCommit + ":" + path], { encoding: "utf8" });
const baselineDataset = /export const DATASET_JOIN_SQL = `([\s\S]*?)`;/.exec(old("services/pipeline/src/featureStore/datasets.ts"))![1];
const authorizePath = "packages/db/proposals/163_empirical_authorize.sql";
const baselineAuthorize = old(authorizePath), candidateAuthorize = await readFile(authorizePath, "utf8");
const directory = process.env.FEATURE_STORE_241_SPEED_DIRECTORY;
assert(directory && process.env.FEATURE_STORE_241_SPEED === "1", "explicit local speed opt-in and new output directory required");
await mkdir(directory, { recursive: false });
const df = () => {
  const raw = execFileSync("docker", ["exec", "dfs-ev-demo-test-postgres-1", "df", "-Pk", "/var/lib/postgresql"], { encoding: "utf8" });
  const fields = raw.trim().split("\n").at(-1)!.trim().split(/\s+/);
  return { mountBytes: Number(fields[1]) * 1024, usedBytes: Number(fields[2]) * 1024, availableBytes: Number(fields[3]) * 1024 };
};
assert.equal(df().mountBytes, 2_147_483_648, "use only the existing 2 GiB override");
const paths = ["packages/db/proposals/138_feature_store.sql", "packages/db/proposals/138_dataset_governance.sql", "packages/db/proposals/241_job_visibility.sql",
  authorizePath, "packages/db/proposals/163_empirical_history.sql", "packages/db/proposals/163_empirical_reader.sql", "packages/db/proposals/163_effective_rights.sql",
  "services/pipeline/src/featureStore/asOf.ts", "services/pipeline/src/featureStore/derived.ts", "services/pipeline/src/featureStore/datasets.ts",
  "services/pipeline/src/featureStore/empiricalAdapter.ts", "services/pipeline/src/featureStore/jobs.ts", "services/pipeline/src/featureStore/localObjectStore.ts",
  "services/pipeline/src/featureStore/objectStore.ts", "services/pipeline/scripts/feature-store/harness.ts",
  "services/pipeline/scripts/feature-store/job-visibility-benchmark.ts", "services/pipeline/scripts/feature-store/job-visibility-evidence.ts",
  "services/pipeline/scripts/feature-store/artifact-governance-evidence.ts", "services/pipeline/tests/feature-store/job-visibility-work-fixture.ts",
  "services/pipeline/tests/feature-store/fixtures/job-visibility-ci-slice-v1.json", "services/pipeline/tests/feature-store/fixtures/job-visibility-work-v1.manifest.json",
  "services/pipeline/tests/feature-store/fixtures/job-visibility-work-v1.json.gz", "packages/domain/src/projection/empirical.ts",
  "packages/domain/src/projection/baseline.ts", "compose.test.yml", "compose.feature-store-spike.yml", "package-lock.json"];
const identity = async () => {
  const hashes = Object.fromEntries(await Promise.all(paths.map(async p => [p, sha256(await readFile(p))])));
  const blobs = Object.fromEntries(paths.map(p => [p, execFileSync("git", ["hash-object", "--", p], { encoding: "utf8" }).trim()]));
  return { hashes, blobs };
};
const source = await identity();
const samples: VisibilitySample[] = [], disk: unknown[] = [], deliveries: unknown[] = [];
const full: VisibilityBenchmark = { issue: 241, step: 4, kind: "point-in-time-completion-benchmark", verdict: "running", samples, cohorts: [],
  runtime: process.version, recordedAt: new Date().toISOString(), sourceHashes: source.hashes, sourceBlobIds: source.blobs, sourceUnchanged: false,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baselineCommit, baselineSqlHashes: { dataset: sha256(Buffer.from(baselineDataset)), authorize: sha256(Buffer.from(baselineAuthorize)) },
  fixture: { naturalKeys: 9381, retrospectiveRows: 2504, strictRows: 0, contentSha256: "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d", wireFiles: 16 },
  requests: { values: [], sha256: "" }, disk, deliveries,
  machine: { arch: arch(), platform: platform(), release: release() }, actualMountBytes: df().mountBytes,
  targets: { producerMs: 84_000, datasetMs: 21_000, readerP95Ms: 210 }, deadlines: { producerMs: 120_000, datasetMs: 30_000, readerMs: 300 },
  baselinePolicy: "Producer fixed version only, four samples. Dataset baseline substitutes main's selection SQL in the unchanged outer builder; #163 baseline substitutes main's authorization SQL in the unchanged adapter. No baseline producer execution.",
  boundary: "Producer through COMMIT; dataset through pre-delivery check; #163 through completed serialized response, including connect for cold and excluding teardown. Setup and observer boundary queries excluded; in-flight observer cost included.",
  cacheState: "Same Node process, no result cache; warm checks current rights/status twice per call. Cold means a fresh connection, not process. OS and PostgreSQL caches unflushed. Fresh scratch DB per gate; no hosted claim.",
  limitations: ["668.225666 ms spike query remains unexplained and retained by owner decision.", "The producer comparison-side 53100 is retained, never rerun or counted as success.", "finished_at precedes COMMIT: same knownAsOf may change across that accepted visibility gap.", "Disk sampled each second and gate boundaries; not exact allocation peaks."] };
const save = () => writeFile(directory + "/full.json", JSON.stringify(full, null, 2) + "\n");
const code = { gitSha: full.baseCommit as string, contentSha256: sha256(Buffer.from(JSON.stringify(source.hashes))) };
const storage = await realpath(await mkdtemp("/private/tmp/dfs241-final-")), store = await openLocalObjectStore(storage);
const snapshot = async (client: Client, gate: string) => {
  const row = { gate, ...(await client.query(`SELECT clock_timestamp()::text AS at,(SELECT sum(size) FROM pg_ls_waldir()) AS wal_bytes,
    (SELECT coalesce(jsonb_agg(t),'[]') FROM pg_ls_tmpdir() t) AS temp_files,
    (SELECT jsonb_agg(jsonb_build_object('name',datname,'bytes',pg_database_size(oid))) FROM pg_database) AS databases,
    current_setting('max_wal_size') AS max_wal_size,current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem`)).rows[0], ...df() };
  disk.push(row); await appendFile(directory + "/disk.jsonl", JSON.stringify(row) + "\n");
};
const monitor = async <T>(admin: Client, gate: string, run: () => Promise<T>) => {
  await snapshot(admin, gate + ":before"); let pending = Promise.resolve(), busy = false, failure: unknown;
  const timer = setInterval(() => { if (busy) return; busy = true; pending = snapshot(admin, gate + ":in-flight").catch(e => { failure = e; }).finally(() => { busy = false; }); }, 1000);
  try { const result = await run(); if (failure) throw failure; return result; }
  finally { clearInterval(timer); await pending; await snapshot(admin, gate + ":after"); }
};
const tracked = (client: Client, arm: string, gate: string) => {
  const queries: string[] = [];
  const proxy = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return (...args: unknown[]) => {
      const first = args[0], text = typeof first === "string" ? first : (first as { text: string }).text;
      queries.push(text);
      const replaced = arm === "baseline" ? gate === "dataset" && text === DATASET_JOIN_SQL ? baselineDataset
        : gate === "reader" && text === candidateAuthorize ? baselineAuthorize : text : text;
      full.lastQuery = { gate, arm, text: replaced, values: typeof first === "string" ? args[1] : (first as { values?: unknown }).values };
      return Reflect.apply(target.query, target, [typeof first === "string" ? replaced : { ...first as object, text: replaced }, ...args.slice(1)]);
    };
  } });
  return { proxy, queries, counts: () => ({ sql: queries.length, checks: queries.filter(q => q.includes("fs138.effective_rights(")).length }) };
};
const persistSample = async (sample: VisibilitySample) => {
  samples.push(sample); await save(); console.log(JSON.stringify(sample));
  assert.equal(sample.verdict, "pass", "gate miss: stopped with original samples");
};
try {
  await withFeatureStoreDatabase(async db => {
    await monitor(db.admin, "producer-preparation", () => loadJobVisibilityWorkFixture(db));
    for (let position = 0; position < 4; position++) {
      full.startedSample = { gate: "producer", position, at: new Date().toISOString() }; await save();
      await monitor(db.admin, "producer-" + position, async () => {
        const work = tracked(db.writer, "candidate", "producer"), started = performance.now();
        const result = await runDerivedJob(work.proxy, "features", { season: 2025, mode: "retrospective-reconstruction-v1" }, code);
        const elapsedMs = performance.now() - started;
        await persistSample({ gate: "producer", arm: "candidate", block: 1, position, elapsedMs, setupMs: 0,
          ...work.counts(), gets: 0, status: result.status === "succeeded" ? "available" : result.status,
          rowCount: result.status === "succeeded" ? result.counts.rows : 0,
          verdict: result.status === "succeeded" && result.counts.rows === 1948 && work.queries.length === 8 && elapsedMs <= 84_000 ? "pass" : "fail" });
      });
    }
  });
  await withFeatureStoreDatabase(async db => {
    const loaded = await monitor(db.admin, "dataset-preparation", () => loadJobVisibilityWorkFixture(db));
    await db.writer.query("INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale) SELECT profile_id,ARRAY['research'],clock_timestamp(),'#241 local final qualification' FROM fs138.source_profiles");
    for (const block of [1, 2, 3]) for (const [position, arm] of ["baseline", "candidate", "candidate", "baseline"].entries()) {
      full.startedSample = { gate: "dataset", block, position, arm, at: new Date().toISOString() }; await save();
      const work = tracked(db.writer, arm, "dataset"), started = performance.now();
      const result = await buildDataset(work.proxy, store, loaded.spec, code), elapsedMs = performance.now() - started;
      const counts = work.counts();
      await persistSample({ gate: "dataset", arm: arm as "baseline" | "candidate", block, position, elapsedMs, setupMs: 0,
        ...counts, gets: 0, status: "available", rowCount: result.rowCount, contentSha256: result.contentSha256,
        verdict: elapsedMs <= 21_000 && counts.sql === 8 && counts.checks === 2 && result.rowCount === 2504 && result.contentSha256 === full.fixture.contentSha256 ? "pass" : "fail" });
      const read = tracked(db.reader, arm, "delivery"); let gets = 0;
      const bytes = await readDataset(read.proxy, { ...store, get: async key => { gets++; return store.get(key); } }, result.datasetId);
      assert.equal(sha256(bytes), result.fileSha256); assert.deepEqual(read.counts(), { sql: 3, checks: 2 }); assert.equal(gets, 1);
      deliveries.push({ block, position, arm, ...read.counts(), gets, fileSha256: result.fileSha256 });
      await snapshot(db.admin, "dataset-sample"); await save();
    }
  });
  await withFeatureStoreDatabase(async db => {
    const loaded = await monitor(db.admin, "reader-preparation", () => loadJobVisibilityWorkFixture(db));
    await db.writer.query("INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale) SELECT profile_id,ARRAY['research'],clock_timestamp(),'#241 local final qualification' FROM fs138.source_profiles");
    await db.admin.query(await readFile("packages/db/proposals/163_empirical_reader.sql", "utf8"));
    const config = await db.createWriterConfig();
    await db.admin.query(`REVOKE fs138_pipeline_writer FROM ${config.user}`); await db.admin.query(`GRANT fs163_research_reader TO ${config.user}`);
    const pins = (await db.reader.query(`SELECT DISTINCT ON(sample_size) feature_id AS "featureId",sample_size AS n FROM fs138.feature_values
      WHERE state='usable' AND evidence_mode='retrospective-reconstruction-v1' AND sample_size BETWEEN 2 AND 16 ORDER BY sample_size,player_id,game_id`)).rows as { featureId: string; n: number }[];
    assert.deepEqual(pins.map(p => p.n), Array.from({ length: 15 }, (_, i) => i + 2));
    full.requests = { values: pins, sha256: sha256(Buffer.from(JSON.stringify(pins))) }; await writeFile(directory + "/requests.json", JSON.stringify(full.requests, null, 2), { flag: "wx" });
    const predict = await createEmpiricalAdapter(), warm = new Client(config); await warm.connect();
    try {
      for (const block of [1, 2, 3]) for (const temperature of ["cold", "warm"] as const) {
        const positions = { baseline: 0, candidate: 0 };
        for (const arm of ["baseline", "candidate", "candidate", "baseline"] as const) for (let read = 0; read < 50; read++) {
          const position = positions[arm]++, pin = pins[position % pins.length];
          full.startedSample = { gate: "reader", block, temperature, position, arm }; // persisted by previous sample; start journal survives interruption
          await appendFile(directory + "/started.jsonl", JSON.stringify(full.startedSample) + "\n");
          const started = performance.now(); let setupMs = 0;
          const client = temperature === "cold" ? new Client(config) : warm;
          if (temperature === "cold") { await client.connect(); setupMs = performance.now() - started; }
          try {
            const work = tracked(client, arm, "reader");
            const result = await predict(work.proxy, { featureId: pin.featureId, knownAsOf: loaded.spec.featuresAsOf, line: 225.5,
              featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: "retrospective-reconstruction-v1" });
            const elapsedMs = performance.now() - started, counts = work.counts();
            assert.deepEqual(JSON.parse(result.serialized), result.response);
            await persistSample({ gate: "reader", arm, block, position, temperature, ...pin, elapsedMs, setupMs,
              ...counts, gets: 0, status: result.response.status,
              verdict: result.response.status === "available" && result.response.sampleSize === pin.n && counts.sql === 3 && counts.checks === 2 ? "pass" : "fail" });
          } finally { if (temperature === "cold") await client.end(); }
        }
        const cohort = samples.filter(s => s.gate === "reader" && s.arm === "candidate" && s.block === block && s.temperature === temperature);
        assert.equal(cohort.length, 100); assert(visibilityP95(cohort.map(s => s.elapsedMs)) <= 210, "reader cohort gate miss; stop");
        await snapshot(db.admin, "reader-cohort");
      }
    } finally { await warm.end(); }
  });
  full.cohorts = visibilityCohorts(samples); full.sourceUnchanged = JSON.stringify((await identity()).hashes) === JSON.stringify(source.hashes);
  full.verdict = "pass"; visibilityProjection(full);
} catch (error) {
  full.verdict = "fail"; full.error = { message: String(error), code: (error as { code?: string }).code ?? null };
  process.exitCode = 1;
} finally {
  await save();
  if (full.verdict === "pass") await writeFile(directory + "/receipt-local.json", JSON.stringify(compactBehavior(Buffer.from(JSON.stringify(full, null, 2) + "\n"), "full.json"), null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ verdict: full.verdict, cohorts: full.cohorts, samples: samples.length, output: directory }));
}
