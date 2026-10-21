import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EVALUATION_MODES, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { completeQbReport, summarizeQbReport } from "./evaluation-report.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";

const storageRoot = await realpath(await mkdtemp("/private/tmp/dfs164-scored-"));
const store = await openLocalObjectStore(storageRoot);
const { code, codeHashes } = await evaluationCodeIdentity();
const receipt: Record<string, unknown> = { schemaVersion: 1, issue: 164, step: 3,
  recordedAt: new Date().toISOString(), code, codeHashes, storageRoot, runtime: process.version,
  machine: { arch: arch(), platform: platform() }, verdict: "running", targetMs: 7_000, deadlineMs: 10_000,
  boundary: "report execution: pinned inputs, three restricted SQL queries, three object reads, scoring, serialization, private report write, final rights/status recheck; excludes fixture reconstruction and connection setup",
  cacheState: "three alternating rounds per evidence mode; existing restricted connection; OS/database/file caches unflushed; no scored-result reuse",
  limitation: "warm-path checkpoint only; repeated fresh-connection cold trials and integrated suites remain step 4; local timings omit Vercel boot and Neon wake",
  deliveryLimit: "a revocation after the final SQL snapshot and before bytes leave the process cannot be prevented; archived reports require fresh authorization before later delivery" };
const compactAccess = (access: unknown) => {
  const value=access as {allowed:boolean;checked_at:string;decisions:unknown[]};
  return {allowed:value.allowed,checkedAt:value.checked_at,decisions:value.decisions.length,
    decisionsSha256:sha256(Buffer.from(JSON.stringify(value.decisions)))};
};
const trials: unknown[] = [], reports: unknown[] = [];
receipt.trials = trials; receipt.reports = reports;
try {
  await withFeatureStoreDatabase(async context => {
    receipt.database = (await context.admin.query("SELECT version() AS version")).rows[0].version;
    const fixture = await prepareEvaluationFixture(context, store, code, event => console.log(JSON.stringify(event)));
    receipt.inputPinsArtifact = fixture.inputPinsArtifact;
    receipt.preregistration = fixture.pins.preregistration;
    receipt.versions = fixture.pins.versions;
    receipt.populationDiagnostics = fixture.pins.populationDiagnostics;
    receipt.cohorts = fixture.prepared.map(p => ({ mode: p.mode, fileSha256: p.dataset.fileSha256,
      contentSha256: p.dataset.contentSha256, count: p.dataset.rowCount }));
    const seenHashes = new Map<string, string>();
    for (let round = 1; round <= 3; round++) for (const mode of EVALUATION_MODES) {
      const sql: string[] = [], objectReads: string[] = [], objectWrites: string[] = [];
      const reader = new Proxy(context.reader, { get(target, property) {
        if (property !== "query") return Reflect.get(target, property, target);
        return (...args: unknown[]) => {
          sql.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
          return Reflect.apply(target.query, target, args);
        };
      } });
      const measuredStore = { ...store,
        get: async (key: string) => { objectReads.push(key); return store.get(key); },
        putIfAbsent: async (key: string, bytes: Uint8Array) => { objectWrites.push(key); return store.putIfAbsent(key, bytes); } };
      const before = context.queryCounts.reader;
      const result = await completeQbReport(reader, measuredStore, fixture.inputPinsArtifact, mode);
      const rightsChecks = sql.filter(s => s.includes("fs138.effective_rights(")).length;
      assert.equal(context.queryCounts.reader - before, 3); assert.equal(sql.length, 3); assert.equal(rightsChecks, 2);
      assert(!sql.some(s => /fs138\.(norm_|normalized_evidence|outcome_labels|feature_values)/.test(s)));
      assert.equal(objectReads.length, 3); assert(!objectReads.some(key => key.startsWith("raw/")));
      assert.equal(objectWrites.length, 1);
      const previous = seenHashes.get(mode);
      if (previous) assert.equal(result.logicalSha256, previous, "repeat-report-logical-hash-mismatch");
      else { seenHashes.set(mode, result.logicalSha256); reports.push({ artifact: result.artifact,
        logicalSha256: result.logicalSha256, ...summarizeQbReport(result.report) }); }
      trials.push({ round, mode, elapsedMs: result.elapsedMs, ...result.timingMs,
        logicalSha256: result.logicalSha256, artifact: result.artifact, authorization: result.authorization,
        delivery: result.delivery, work: { statements: sql.length, rightsChecks, objectReads: objectReads.length,
          objectWrites: objectWrites.length, rawSourceReads: 0, perExampleQueries: 0 },
        verdict: result.elapsedMs <= 7_000 ? "pass" : "fail" });
      console.log(JSON.stringify({ stage: "scored", round, mode, elapsedMs: result.elapsedMs,
        logicalSha256: result.logicalSha256, folds: result.report.folds.length }));
    }
    receipt.verdict = trials.every(t => (t as { verdict: string }).verdict === "pass") ? "step-3-warm-pass" : "fail";
    if (receipt.verdict === "fail") process.exitCode = 1;
  });
} catch (error) { receipt.verdict = "fail"; receipt.failure = String(error); process.exitCode = 1; }
finally {
  receipt.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const full = Buffer.from(JSON.stringify(receipt, (_key, value: unknown) => value === Infinity ? "positive-infinity" : value) + "\n");
  const key = objectKey("audits", full);
  await store.putIfAbsent(key, full);
  receipt.fullReceipt = { objectKey: key, sha256: sha256(full), byteSize: full.byteLength };
  // Detailed groups/calibration stay in ObjectStore. Commit one-line group rows
  // plus the compact checkpoint rather than thousands of pretty-printed lines.
  const directory = new URL("docs/evidence/feature-store-164/", EVALUATION_ROOT);
  await mkdir(directory, { recursive: true });
  const summary = { ...receipt, trials: (trials as {authorization:unknown;delivery:unknown}[]).map(trial => ({...trial,
    authorization: compactAccess(trial.authorization), delivery: compactAccess(trial.delivery)})), reports: reports.map(r => {
    const report = r as ReturnType<typeof summarizeQbReport>;
    return { ...report, groups: undefined };
  }) };
  const scoreSummary = reports.map(r => {
    const report = r as ReturnType<typeof summarizeQbReport>;
    return {evidenceMode:report.evidenceMode,groups:report.groups.map(g=>({season:g.season,stratum:g.stratum,
      candidates:g.coverage.candidates,scored:g.coverage.scoredFolds,missingFeatures:g.coverage.missingFeatures,
      missingLabels:g.coverage.missingLabels,rps:g.rps,combined:g.combined,
      thresholds:g.stratum==='all'&&g.season===null?g.thresholds:undefined}))};
  });
  const scores = '{"format":"qb-evaluation-score-summary-v1","reports":[\n'+scoreSummary.map(report=>
    '{"evidenceMode":'+JSON.stringify(report.evidenceMode)+',"groups":[\n'+report.groups.map(g=>
      JSON.stringify(g,(_key,value:unknown)=>value===Infinity?'positive-infinity':value)).join(',\n')+'\n]}').join(',\n')+'\n]}\n';
  await writeFile(new URL('step-3-score-summary.json',directory),scores);
  await writeFile(new URL(receipt.verdict === "fail" ? "step-3-failure.json" : "step-3-evaluation.json", directory),
    JSON.stringify(summary, (_key, value: unknown) => value === Infinity ? "positive-infinity" : value, 2) + "\n");
}
console.log(JSON.stringify({ verdict: receipt.verdict, storageRoot }));
