import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { readFile, mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, type ClientConfig } from "pg";
import { withFeatureStoreDatabase } from "./harness.ts";
import { loadProbeSql, prototypePrediction, type ProbeRequest, type ProbeTiming } from "./empirical-prototype.ts";
import { openLocalObjectStore } from "../../src/lib/featureStore/localObjectStore.ts";
import { sha256, objectKey } from "../../src/lib/featureStore/objectStore.ts";
import { ingestSource } from "../../src/lib/featureStore/ingest.ts";
import { runDerivedJob } from "../../src/lib/featureStore/derived.ts";
import type { SourceAsset } from "../../src/lib/featureStore/source.ts";

type Trial = { round: number; mode: "cold" | "warm"; ordinal: number; season: number; sampleSize: number;
  timing?: ProbeTiming; statements: number; rightsChecks: number; serializedBytes?: number; failure?: string };
const root = new URL("../../", import.meta.url);
const reportPath = new URL("docs/evidence/feature-store-163/step-2-hot-path.json", root);
const storageRoot = await realpath(await mkdtemp(join(tmpdir(), "dfs163-spike-")));
const store = await openLocalObjectStore(storageRoot);
const sql = await loadProbeSql();
const files = ["db/proposals/163_empirical_reader.sql", "db/proposals/163_empirical_authorize.sql", "db/proposals/163_empirical_history.sql",
  "scripts/feature-store/empirical-prototype.ts", "scripts/feature-store/empirical-startup.ts", "scripts/feature-store/empirical-spike.ts",
  "scripts/feature-store/harness.ts", "src/lib/projection/empirical.ts", "src/lib/projection/baseline.ts",
  "src/lib/featureStore/derived.ts", "src/lib/featureStore/ingest.ts", "src/lib/featureStore/normalize.ts", "src/lib/featureStore/source.ts",
  "db/proposals/138_feature_store.sql", "db/proposals/138_dataset_governance.sql", "package-lock.json"];
const codeHashes = Object.fromEntries(await Promise.all(files.map(async path => [path, sha256(await readFile(new URL(path, root)))])));
const code = { gitSha: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
  contentSha256: sha256(Buffer.from(JSON.stringify(codeHashes))) };
const trials: Trial[] = [];
const startups: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
  schemaVersion: 1, issue: 163, step: 2, recordedAt: new Date().toISOString(), code, codeHashes, runtime: process.version,
  machine: { platform: platform(), arch: arch(), cpus: cpus().length, memoryBytes: totalmem() }, storageRoot,
  boundary: { warm: "existing restricted connection through response JSON serialization",
    cold: "already-running process: new restricted connection through response JSON serialization",
    processStartup: "separate fresh-process probes; not gated; parent observes first complete response line, excluding teardown",
    deadlineMs: 300, p95TargetMs: 210, percentile: "nearest rank", requestsPerModePerRound: 100, rounds: 3 },
  cacheState: "No prediction result cache or prepared statement names; OS and PostgreSQL buffers are unflushed; setup SQL/artifacts loaded before request timing",
  limitations: ["Local PostgreSQL only; no Vercel function boot or Neon scale-to-zero wake measurement",
    "Retrospective reconstruction using current corrected files; historical availability unverified",
    "Prototype proof only; complete adapter version/refusal/cancellation contract and race probes remain steps 3–4",
    "Revocations after the final SQL snapshot and before response bytes leave the process may not be observed"],
  verdict: "running",
};
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return sorted.length ? { n: sorted.length, p50: rank(.5), p95: rank(.95), max: sorted.at(-1)! } : null;
};
const summarize = (rows: Trial[]) => {
  const complete = rows.filter(row => row.timing && !row.failure);
  const stages = ["connection", "authorization", "history", "calculation", "recheck", "serialization", "request"] as const;
  const timeMs = Object.fromEntries(stages.map(stage => [stage, distribution(complete.map(row => row.timing![stage]))]));
  const misses = rows.filter(row => row.failure || row.statements !== 3 || row.rightsChecks !== 2 || row.timing!.request > 210);
  const verdict = rows.length >= 100 && complete.length === rows.length && complete.every(row => row.statements === 3 && row.rightsChecks === 2)
    && timeMs.request!.p95 <= 210 ? "pass" : "fail";
  return { requests: rows.length, completed: complete.length, timeMs, over210Ms: misses.length, misses,
    statementCounts: [...new Set(rows.map(row => row.statements))], rightsCheckCounts: [...new Set(rows.map(row => row.rightsChecks))], verdict };
};
const save = async () => {
  const full = Buffer.from(JSON.stringify({ report, trials, startups }) + "\n");
  const key = objectKey("audits", full);
  await store.putIfAbsent(key, full);
  report.fullDiagnostics = { objectKey: key, sha256: sha256(full), byteSize: full.byteLength };
  await mkdir(new URL("docs/evidence/feature-store-163/", root), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
};
const startup = async (config: ClientConfig, request: ProbeRequest) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const started = performance.now();
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(new URL("empirical-startup.ts", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  let result: Record<string, unknown> | undefined;
  child.stdout.on("data", chunk => {
    stdout += String(chunk);
    if (stdout.length > 128 * 1024) { child.kill(); reject(new Error("startup-output-limit")); }
    if (!result && stdout.includes("\n")) {
      try { result = { ...JSON.parse(stdout.slice(0, stdout.indexOf("\n"))), parentObservedTotalMs: performance.now() - started }; }
      catch (error) { reject(error); }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  child.on("error", reject);
  child.on("close", code => code === 0 && result ? resolve(result) : reject(new Error(`startup-failed:${code}:${stderr}`)));
  child.stdin.end(JSON.stringify({ config, request }));
});

try {
  await withFeatureStoreDatabase(async ({ admin, writer, createWriterConfig }) => {
    report.database = (await admin.query("SELECT version() AS version")).rows[0].version;
    await admin.query(await readFile(new URL("db/proposals/163_empirical_reader.sql", root), "utf8"));
    const config = { ...await createWriterConfig(), application_name: "dfs-ev-163-probe", connectionTimeoutMillis: 300,
      statement_timeout: 300, query_timeout: 300 };
    // Harness owns cleanup of this temporary login. Remove its writer membership
    // before opening any connection; it inherits only the dedicated research role.
    assert.match(String(config.user), /^fs138_job_[a-f0-9]{16}$/);
    await admin.query(`REVOKE fs138_pipeline_writer FROM ${config.user}`);
    await admin.query(`GRANT fs163_research_reader TO ${config.user}`);
    const sourceBytes = await readFile(new URL("docs/evidence/feature-store-138/step-3-source-manifest.json", root));
    const manifest = JSON.parse(sourceBytes.toString()) as { assets: { asset: SourceAsset }[] };
    const previous = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json", root), "utf8")) as {
      storageRoot: string; results: { name: string; objectKey: string; wireSha256: string }[] };
    const originals = await openLocalObjectStore(previous.storageRoot);
    const inputs = [];
    for (const { asset } of manifest.assets) {
      const prior = previous.results.find(row => row.name === asset.name); assert(prior);
      const bytes = await originals.get(prior.objectKey); assert.equal(sha256(bytes), prior.wireSha256);
      const result = await ingestSource(writer, store, asset, code,
        { download: async () => ({ bytes, capturedAt: new Date().toISOString(), requests: 0 }) });
      assert.equal(result.status, "ingested");
      inputs.push({ name: asset.name, sha256: prior.wireSha256, rows: result.normalizedRows });
      console.log(JSON.stringify({ setup: asset.name, rows: result.normalizedRows }));
    }
    assert.equal(inputs.length, 16);
    await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
      SELECT profile_id,ARRAY['research'],clock_timestamp(),'owner-approved #163 local research; no serving clearance'
      FROM fs138.source_profiles`);
    const derived = [];
    for (const season of [2022, 2023, 2024, 2025]) {
      const result = await runDerivedJob(writer, "features", { season, mode: "retrospective-reconstruction-v1" }, code);
      assert.equal(result.status, "succeeded"); derived.push({ season, rows: result.counts?.rows, usable: result.counts?.usable });
      console.log(JSON.stringify({ derived: season, rows: result.counts?.rows }));
    }
    const knownAsOf = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock as string;
    const cases = (await admin.query<{ feature_id: string; season: number; sample_size: number }>(`WITH ranked AS(
      SELECT feature_id,season,sample_size,row_number() OVER(PARTITION BY season,sample_size ORDER BY game_id,player_id) AS ordinal
      FROM fs138.feature_values WHERE state='usable' AND sample_size IN(2,8,16)
    ) SELECT feature_id,season,sample_size FROM ranked WHERE ordinal=1 ORDER BY season,sample_size`)).rows;
    assert.equal(cases.length, 12);
    const content = (await admin.query(`SELECT player_id,game_id,season,cutoff::text,state,reasons,flags,sample_size,history
      FROM fs138.feature_values ORDER BY season,game_id,player_id`)).rows;
    report.fixture = { sourceManifestSha256: sha256(sourceBytes), inputs, derived, featureContentSha256: sha256(Buffer.from(JSON.stringify(content))),
      mode: "retrospective-reconstruction-v1", historicalAvailability: "unverified", labelsMaterialized: 0,
      examples: cases.map(({ season, sample_size }) => ({ season, sampleSize: sample_size })), knownAsOf };
    const connection = new Client(config); await connection.connect();
    const plans: Record<string, unknown> = {};
    const permittedRelations = new Set(["feature_values", "feature_inputs", "source_snapshots", "job_runs", "rights_decisions"]);
    const relations = new Set<string>();
    try {
      const denied: string[] = [];
      for (const table of ["outcome_labels", "label_inputs", "norm_schedule", "norm_player_game_stats", "norm_identity", "norm_participation", "normalized_evidence"]) {
        await assert.rejects(connection.query(`SELECT * FROM fs138.${table} LIMIT 0`), { code: "42501" }); denied.push(table);
      }
      await assert.rejects(connection.query("SELECT source_manifest FROM fs138.source_snapshots LIMIT 0"), { code: "42501" });
      await assert.rejects(connection.query("INSERT INTO fs138.feature_values DEFAULT VALUES"), { code: "42501" });
      for (const [name, text, values] of [
        ["authorize", sql.authorize, [cases[0].feature_id, knownAsOf, "qb-passing-yards-feature-v1", "prior-eligible-reg-max16-min2-cutoff1h-v1", "retrospective-reconstruction-v1", null]],
        ["history", sql.history, [cases[0].feature_id]],
      ] as const) {
        const plan = (await connection.query("EXPLAIN (FORMAT JSON, VERBOSE) " + text, [...values])).rows;
        plans[name] = plan;
        const visit = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          if ("Relation Name" in node) relations.add(String(node["Relation Name"]));
          for (const child of Object.values(node)) visit(child);
        }; visit(plan);
      }
      assert([...relations].every(name => permittedRelations.has(name)));
      report.workProof = { actualPlanRelations: [...relations].sort(), deniedReads: denied,
        rawManifestReadDenied: true, derivedWriteDenied: true, measuredQuerySequence: ["authorize", "history", "authorize"],
        noRawEvidenceOrPerRowValidationReads: "Restricted permissions and EXPLAIN relation inventory; every measured SQL text matches the two recorded proposal hashes" };
      // No feature-value warm-up requests are discarded. The first measured
      // request for each mode remains in its cohort; permission/EXPLAIN setup is disclosed.
      for (let round = 1; round <= 3; round++) {
        const order = round % 2 === 1 ? ["cold", "warm"] as const : ["warm", "cold"] as const;
        for (const mode of order) {
          for (let ordinal = 0; ordinal < 100; ordinal++) {
            const selected: { feature_id: string; season: number; sample_size: number } = cases[(ordinal + (round - 1) * 4) % cases.length];
            const request = { featureId: selected.feature_id, knownAsOf, line: 224.5 };
            const trial: Trial = { round, mode, ordinal, season: selected.season, sampleSize: selected.sample_size, statements: 0, rightsChecks: 0 };
            const fresh = mode === "cold" ? new Client(config) : null;
            const client = fresh ?? connection;
            const seen: string[] = [];
            const measured = new Proxy(client, { get(target, property) {
              if (property !== "query") return Reflect.get(target, property, target);
              return (...args: unknown[]) => {
                const text = (args[0] as { text: string }).text;
                assert(text === sql.authorize || text === sql.history, "unexpected hot-path statement");
                seen.push(text === sql.authorize ? "authorize" : "history"); trial.statements++;
                if (text === sql.authorize) trial.rightsChecks++;
                return Reflect.apply(target.query, target, args);
              };
            } });
            try {
              const started = performance.now();
              if (fresh) await fresh.connect();
              const connectionMs = fresh ? performance.now() - started : 0;
              const result = await prototypePrediction(measured, sql, request, started, connectionMs);
              assert.deepEqual(seen, ["authorize", "history", "authorize"]);
              assert.equal(result.work.statements, trial.statements); assert.equal(result.work.rightsChecks, trial.rightsChecks);
              const output = JSON.parse(result.serialized);
              assert.equal(output.sampleSize, selected.sample_size); assert.equal(output.rightsScope, "research");
              assert(output.feature.flags.includes("historical-availability-unverified"));
              trial.timing = result.timing; trial.serializedBytes = Buffer.byteLength(result.serialized);
            } catch (error) { trial.failure = String(error); }
            finally { await fresh?.end(); trials.push(trial); }
            // A refused request is a failed spike, never silently replaced.
            if (trial.failure) throw new Error(`hot-path-refusal:${trial.failure}`);
          }
          const summary = summarize(trials.filter(row => row.round === round && row.mode === mode));
          console.log(JSON.stringify({ round, mode, p95: summary.timeMs.request?.p95, verdict: summary.verdict }));
          if (summary.verdict !== "pass") throw new Error("hot-path-p95-target-missed");
        }
      }
      for (let i = 0; i < 3; i++) startups.push(await startup(config, { featureId: cases[i * 4].feature_id, knownAsOf, line: 224.5 }));
      report.processStartup = { probes: startups.map(row => ({ processReadyMs: row.processReadyMs,
        parentObservedTotalMs: row.parentObservedTotalMs, request: (row.result as { timing: ProbeTiming }).timing })),
        measuredOnly: true, n: startups.length };
    } finally { await connection.end(); }
    const planBytes = Buffer.from(JSON.stringify(plans)); const key = objectKey("audits", planBytes);
    await store.putIfAbsent(key, planBytes); report.plans = { objectKey: key, sha256: sha256(planBytes), byteSize: planBytes.length };
    report.verdict = "pass";
  });
} catch (error) {
  report.verdict = "fail"; report.failure = String(error); process.exitCode = 1;
} finally {
  report.cohorts = [1, 2, 3].flatMap(round => ["cold", "warm"].map(mode => ({ round, mode,
    ...summarize(trials.filter(row => row.round === round && row.mode === mode)) })));
  report.aggregate = ["cold", "warm"].map(mode => ({ mode, ...summarize(trials.filter(row => row.mode === mode)) }));
  report.strataCounts = [2022, 2023, 2024, 2025].flatMap(season => [2, 8, 16].map(sampleSize => ({ season, sampleSize,
    cold: trials.filter(row => row.mode === "cold" && row.season === season && row.sampleSize === sampleSize).length,
    warm: trials.filter(row => row.mode === "warm" && row.season === season && row.sampleSize === sampleSize).length })));
  report.targets = { coldP95: (report.aggregate as { mode: string; verdict: string }[]).find(row => row.mode === "cold")?.verdict,
    warmP95: (report.aggregate as { mode: string; verdict: string }[]).find(row => row.mode === "warm")?.verdict,
    constantThreeStatements: trials.length === 600 && trials.every(row => row.statements === 3) ? "pass" : "fail",
    exactlyTwoRightsChecks: trials.length === 600 && trials.every(row => row.rightsChecks === 2) ? "pass" : "fail",
    zeroRawOrPerRowValidationReads: report.workProof ? "pass" : "unmeasured" };
  await save();
  console.log(JSON.stringify({ report: reportPath.pathname, verdict: report.verdict, targets: report.targets }));
}
