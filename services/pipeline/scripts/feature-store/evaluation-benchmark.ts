import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import type { ClientConfig } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, EVALUATION_MODES, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { measureQbReport } from "./evaluation-measure.ts";
import type { Artifact } from "./evaluation-report.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";

type Measurement = Awaited<ReturnType<typeof measureQbReport>> & {
  requestMs: number; connectionMs: number; objectStoreSetupMs: number; processStartMs?: number; endToEndMs?: number;
};
type Trial = { round: number; mode: QbEvidenceMode; temperature: "cold" | "warm"; verdict: string;
  result?: Measurement; failure?: string };
const rounds = 10;
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const coldTrial = (config: ClientConfig, cleanupConfig: ClientConfig, storageRoot: string, inputPins: Artifact, mode: QbEvidenceMode): Promise<Measurement> =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const child = fork(new URL("./evaluation-worker.ts", import.meta.url), [], { execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let processStartMs = 0, measurement: Measurement | undefined, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("cold-worker-timeout-20s"); child.kill("SIGKILL"); }, 20_000);
    child.on("error", error => { failure = error; });
    child.on("message", (message: { ready?: boolean; result?: Measurement; failure?: string }) => {
      if (message.ready) { processStartMs = performance.now() - started; child.send({ config, cleanupConfig, storageRoot, inputPins, mode }); }
      if (message.result) measurement = { ...message.result, processStartMs, endToEndMs: performance.now() - started };
      if (message.failure) failure = new Error(message.failure);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !measurement) reject(failure ?? new Error("cold-worker-incomplete:" + code));
      else resolve(measurement);
    });
  });

const storageRoot = await realpath(await mkdtemp("/private/tmp/dfs164-final-"));
const store = await openLocalObjectStore(storageRoot);
const { code, codeHashes } = await evaluationCodeIdentity();
const trials: Trial[] = [];
const receipt: Record<string, unknown> = { schemaVersion: 1, issue: 164, step: 4,
  recordedAt: new Date().toISOString(), code, codeHashes, runtime: process.version,
  machine: { arch: arch(), platform: platform() }, storageRoot, rounds, trials, verdict: "running",
  targetMs: 7_000, deadlineMs: 10_000,
  gate: "every completed request <=7000 ms, including fresh restricted connection for cold; any error/deadline miss fails; report nearest-rank p50/p95 and maximum by mode/temperature",
  boundary: "request connection (cold) plus pinned input reads, three SQL statements, full scoring/serialization, private ObjectStore report write and pre-delivery rights/status recheck; fixture reconstruction excluded",
  cacheState: "ten alternating rounds, cold/warm order reversed on even rounds; fresh native Node process and connection per cold; existing connection/process per warm; OS/file/PostgreSQL caches unflushed; no scored-result reuse; immutable output address may already exist (put-if-absent validates existing bytes)",
  disclosures: ["cold Node startup and ObjectStore initialization measured separately; full local end-to-end disclosed, not gated",
    "no optimization comparison: absolute repeated targets, not ABBA", "local probes do not model Vercel boot or Neon compute wake",
    "revocation after the final SQL snapshot and before bytes leave the process remains the accepted delivery window"] };
try {
  await withFeatureStoreDatabase(async context => {
    receipt.database = (await context.admin.query("SELECT version() AS version")).rows[0].version;
    const fixture = await prepareEvaluationFixture(context, store, code, event => console.log(JSON.stringify(event)));
    receipt.inputPinsArtifact = fixture.inputPinsArtifact;
    receipt.preregistration = fixture.pins.preregistration;
    receipt.versions = fixture.pins.versions;
    receipt.cohorts = fixture.prepared.map(p => ({ mode: p.mode, fileSha256: p.dataset.fileSha256,
      contentSha256: p.dataset.contentSha256, count: p.dataset.rowCount }));
    const config = await context.createReaderConfig();
    const cleanupConfig = await context.createWriterConfig();
    const hashes = new Map<string, string>();
    for (let round = 1; round <= rounds; round++) for (const mode of EVALUATION_MODES)
      for (const temperature of (round % 2 ? ["cold", "warm"] : ["warm", "cold"]) as ("cold" | "warm")[]) {
        let result: Measurement | undefined;
        try {
          if (temperature === "cold") result = await coldTrial(config, cleanupConfig, storageRoot, fixture.inputPinsArtifact, mode);
          else {
            const started = performance.now();
            const measured = await measureQbReport(context.reader, store, fixture.inputPinsArtifact, mode, context.writer);
            result = { ...measured, requestMs: performance.now() - started, connectionMs: 0, objectStoreSetupMs: 0 };
          }
          const expected = hashes.get(mode);
          if (expected) assert.equal(result.logicalSha256, expected, "cold-warm-logical-hash-mismatch");
          else hashes.set(mode, result.logicalSha256);
          const verdict = result.requestMs <= 7_000 ? "pass" : "fail";
          trials.push({ round, mode, temperature, result, verdict });
          console.log(JSON.stringify({ round, mode, temperature, requestMs: result.requestMs, verdict }));
        } catch (error) { trials.push({ round, mode, temperature, result, verdict: "fail", failure: String(error) }); }
      }
    receipt.logicalHashes = Object.fromEntries(hashes);
    receipt.cohortsMeasured = EVALUATION_MODES.flatMap(mode => (["cold", "warm"] as const).map(temperature => {
      const selected = trials.filter(t => t.mode === mode && t.temperature === temperature);
      const completed = selected.flatMap(t => t.result ? [t.result] : []);
      const requests = completed.map(r => r.requestMs);
      return { mode, temperature, attempted: selected.length, completed: completed.length,
        failed: selected.filter(t => t.verdict !== "pass").length,
        p50Ms: requests.length ? percentile(requests, .5) : null, p95Ms: requests.length ? percentile(requests, .95) : null,
        maximumMs: requests.length ? Math.max(...requests) : null,
        processStartP95Ms: temperature === "cold" && completed.length ? percentile(completed.map(r => r.processStartMs!), .95) : null,
        endToEndP95Ms: temperature === "cold" && completed.length ? percentile(completed.map(r => r.endToEndMs!), .95) : null,
        verdict: selected.length === rounds && selected.every(t => t.verdict === "pass") ? "pass" : "fail" };
    }));
    receipt.verdict = trials.length === rounds * 4 && trials.every(t => t.verdict === "pass") ? "pass" : "fail";
  });
} catch (error) { receipt.verdict = "fail"; receipt.failure = String(error); }
finally {
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
  const key = objectKey("audits", bytes);
  await store.putIfAbsent(key, bytes);
  receipt.fullReceipt = { objectKey: key, sha256: sha256(bytes), byteSize: bytes.byteLength };
  const compact = { ...receipt, trials: undefined };
  const directory = new URL("docs/evidence/feature-store-164/", EVALUATION_ROOT);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("step-4-capacity.json", directory), JSON.stringify(compact, null, 2) + "\n");
}
console.log(JSON.stringify({ verdict: receipt.verdict, storageRoot, cohorts: receipt.cohortsMeasured }));
if (receipt.verdict !== "pass") process.exitCode = 1;
