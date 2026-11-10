import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { compactPredictionBenchmark, compositeCohortSummary, verifyEvidenceReceipt, verifyPredictionBenchmark,
  type FullPredictionBenchmark } from "../../scripts/feature-store/artifact-governance-evidence.ts";

const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-167/", import.meta.url));
const evidence = async () => {
  const name = (await readdir(directory)).filter(n => /^final-benchmark-.*\.json$/.test(n)).sort().at(-1);
  assert(name, "missing-final-handler-evidence");
  const receipt = JSON.parse(await readFile(directory + name, "utf8"));
  const [archive, member] = receipt.fullRecord.path.split("#");
  const bytes = execFileSync("tar", ["-xOzf", directory + archive, member], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(sha256(bytes), receipt.fullRecord.sha256); assert.equal(bytes.length, receipt.fullRecord.byteSize);
  return { receipt, bytes, full: JSON.parse(bytes.toString()) as FullPredictionBenchmark };
};

test("#167 final evidence recomputes schedule, work and setup shares without DB, cache or CI speed assertions", async () => {
  const { receipt, full } = await evidence();
  // Recorded percentiles are arithmetic here. Only the opt-in benchmark/audit
  // enforces their deadline; normal CI makes no real/recorded speed assertion.
  assert.deepEqual(verifyPredictionBenchmark(full, false), receipt.verification);
  assert.deepEqual(full.samples.filter(s => s.arm === "candidate").map(s => s.work.sql), Array(600).fill(3));
});

test("#167 final verifier rejects tampered member bytes, requests, sources, work and incomplete cohorts", async () => {
  const { receipt, bytes, full } = await evidence();
  assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /full-record-sha256-mismatch/);
  for (const mutate of [
    (v: FullPredictionBenchmark) => { v.samples[50].work.gets++; },
    (v: FullPredictionBenchmark) => { v.samples[50].work.hashes++; },
    (v: FullPredictionBenchmark) => { v.samples[51] = v.samples[50]; },
    (v: FullPredictionBenchmark) => { v.samples[50].setupShare = .9; },
    (v: FullPredictionBenchmark) => { v.samples[150].queries.reverse(); },
    (v: FullPredictionBenchmark) => { v.cohorts.pop(); },
    (v: FullPredictionBenchmark) => { v.serverWork![0].rightsCalls++; },
    (v: FullPredictionBenchmark) => { v.handlerRequests!.values[0].line = 3; },
    (v: FullPredictionBenchmark) => { v.codeHashes["services/pipeline/src/featureStore/predict.ts"] = "a".repeat(64); },
  ]) {
    const value = structuredClone(full); mutate(value); assert.throws(() => verifyPredictionBenchmark(value, false));
  }
});

test("#167 opt-in gate refuses a single slow cohort using synthetic durations, even with other cohorts fast", async () => {
  const { full } = await evidence();
  for (const sample of full.samples) {
    sample.setupMs = sample.temperature === "cold" ? 10 : 0;
    sample.warmPathMs = 3; sample.totalMs = sample.setupMs + sample.warmPathMs;
    sample.setupShare = sample.setupMs / sample.totalMs;
    sample.getMs = .5; sample.computeMs = 0; sample.serializationMs = 0;
    for (const q of sample.queries) q.elapsedMs = .5;
    if (sample.arm === "candidate" && sample.temperature === "cold" && sample.cohort === 1) {
      sample.totalMs = 211; sample.warmPathMs = 201; sample.setupShare = 10 / 211;
    }
  }
  full.baselineFirstP95Ms = 3;
  full.cohorts = full.cohorts.map(c => compositeCohortSummary(full.samples.filter(s =>
    s.phase === "interleaved" && s.temperature === c.temperature && s.cohort === c.cohort), c.temperature, c.cohort));
  assert.throws(() => verifyPredictionBenchmark(full), /composite-full-path-headroom-gate-failed/);
  // Receipt generation also refuses a forged pass on that failed cohort.
  assert.throws(() => compactPredictionBenchmark(Buffer.from(JSON.stringify(full)), "synthetic.tar.gz#full.json"));
});
