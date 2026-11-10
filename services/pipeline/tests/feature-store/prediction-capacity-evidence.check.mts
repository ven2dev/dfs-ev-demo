import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { verifyCapacityBenchmark, type FullCapacityBenchmark } from "../../scripts/feature-store/prediction-capacity-evidence.ts";

const evidence = async (issue: 168 | 242) => {
  const directory = fileURLToPath(new URL(`../../../../docs/evidence/feature-store-${issue}/`, import.meta.url));
  const names = (await readdir(directory)).filter(n => /^final-benchmark-.*\.json$/.test(n)).sort();
  assert(names.length, "missing-final-capacity-evidence");
  const receipt = JSON.parse(await readFile(directory + names.at(-1), "utf8"));
  const [archive, member] = receipt.fullRecord.path.split("#");
  assert(/^[a-zA-Z0-9_-]+\.tar\.gz$/.test(archive));
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(member) && member.split("/").every((p: string) => p && p !== "." && p !== ".."));
  const bytes = execFileSync("tar", ["-xOzf", directory + archive, member], { maxBuffer: 16 * 1024 * 1024 });
  // Check hash and size before parsing or recomputing any sample.
  assert.equal(sha256(bytes), receipt.fullRecord.sha256); assert.equal(bytes.length, receipt.fullRecord.byteSize);
  return { directory, receipt, bytes, full: JSON.parse(bytes.toString()) as FullCapacityBenchmark };
};

for (const issue of [168, 242] as const) {
  test(`#${issue} final evidence recomputes six schedules, work, coverage and process provenance without a CI speed gate`, async () => {
    const { directory, receipt, full } = await evidence(issue);
    assert.deepEqual(verifyCapacityBenchmark(full, false), receipt.verification);
    assert.equal(full.issue, issue); assert.equal(full.schemaVersion, issue === 168 ? 1 : 2);
    for (const trial of full.trials.filter(t => t.name.startsWith("C"))) {
      if (issue === 242) { assert.equal(trial.startupTail?.length, 5); assert(trial.startupMaximumMs! > 0); }
      else { assert(!("startupTail" in trial)); assert(!("startupMaximumMs" in trial)); }
    }
    assert.equal(full.samples.length, 600);
    assert.deepEqual(full.samples.map(s => s.work?.sql), Array(600).fill(3));
    // Validate all committed member addresses without invoking opt-in speed gates.
    const records = await verifyEvidenceBundle(directory, false);
    assert(records.length > 0 && records.every(r => r.verdict === "pass"));
  });

  test(`#${issue} final evidence refuses altered bytes, request schedules, process identity, work and setup arithmetic`, async () => {
    const { receipt, bytes, full } = await evidence(issue);
    assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /sha256/);
    for (const mutate of [
      (v: FullCapacityBenchmark) => { v.manifest.requests.reverse(); },
      (v: FullCapacityBenchmark) => { v.samples[1].pid = v.samples[0].pid; },
      (v: FullCapacityBenchmark) => { v.samples[100].index++; },
      (v: FullCapacityBenchmark) => { v.samples[0].work!.gets++; },
      (v: FullCapacityBenchmark) => { v.samples[0].work!.hashes++; },
      (v: FullCapacityBenchmark) => { v.samples[0].startupMs++; },
      (v: FullCapacityBenchmark) => { v.trials.pop(); },
      (v: FullCapacityBenchmark) => { v.serverWork![0].rightsCalls++; },
      (v: FullCapacityBenchmark) => { v.warmControls!.deletionRefusal = false; },
      (v: FullCapacityBenchmark) => { v.samples[0].serialized = '{"status":"unavailable"}'; },
      (v: FullCapacityBenchmark) => { v.codeHashes["services/pipeline/src/featureStore/predict.ts"] = "0".repeat(64); },
    ]) {
      const altered = structuredClone(full); mutate(altered);
      assert.throws(() => verifyCapacityBenchmark(altered, false));
    }
    if (issue === 242) for (const mutate of [
      (v: FullCapacityBenchmark) => { v.trials[0].startupMaximumMs!++; },
      (v: FullCapacityBenchmark) => { v.trials[0].startupTail![0].index++; },
      (v: FullCapacityBenchmark) => { v.trials[0].startupTail!.reverse(); },
      (v: FullCapacityBenchmark) => { Object.assign(v, { startupGate: { ...v.startupGate, sampleDeadlineMs: 301 } }); },
      (v: FullCapacityBenchmark) => { Object.assign(v, { schemaVersion: 1 }); },
    ]) {
      const altered = structuredClone(full); mutate(altered);
      assert.throws(() => verifyCapacityBenchmark(altered, false));
    }
  });
}
