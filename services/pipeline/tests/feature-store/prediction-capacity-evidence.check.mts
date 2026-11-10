import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { verifyEvidenceBundle } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { resolveEvidenceRecord } from "../../scripts/feature-store/evidence-records.ts";
import { receiptIdentity, verifyPublicEvidenceReceipt, type EvidencePublicProjection } from "../../scripts/feature-store/evidence-public-projection.ts";
import type { FullCapacityBenchmark } from "../../scripts/feature-store/prediction-capacity-evidence.ts";

const evidence = async (issue: 168 | 242) => {
  const directory = fileURLToPath(new URL(`../../../../docs/evidence/feature-store-${issue}/`, import.meta.url));
  const names = (await readdir(directory)).filter(n => /^final-benchmark-.*\.json$/.test(n) &&
    !n.endsWith(".reference.json") && !n.endsWith(".public.json")).sort();
  assert(names.length, "missing-final-capacity-evidence");
  const receipt = JSON.parse(await readFile(directory + names.at(-1), "utf8"));
  const resolved = await resolveEvidenceRecord(directory, receipt.fullRecord);
  assert.equal(resolved.mode, "public-metadata", "committed-forecast-archive-not-removed");
  assert(resolved.mode === "public-metadata");
  const record = (resolved.projection as EvidencePublicProjection).records.find(r => r.member === resolved.member)!;
  return { directory, receipt, record };
};

for (const issue of [168, 242] as const) {
  test(`#${issue} public evidence recomputes six schedules, work, coverage and process provenance; private values need private bytes`, async () => {
    const { directory, receipt, record } = await evidence(issue);
    const verification = verifyPublicEvidenceReceipt(receipt, record);
    assert(verification.audit === "public-metadata" && verification.recomputed);
    assert.deepEqual(verification.verification, receipt.verification);
    assert.equal(receipt.issue, issue); assert.equal(receipt.schemaVersion, issue === 168 ? 1 : 2);
    for (const trial of receipt.trials.filter((t: { name: string }) => t.name.startsWith("C"))) {
      if (issue === 242) { assert.equal(trial.startupTail?.length, 5); assert(trial.startupMaximumMs! > 0); }
      else { assert(!("startupTail" in trial)); assert(!("startupMaximumMs" in trial)); }
    }
    assert.equal(receipt.samples.length, 600);
    assert.deepEqual(receipt.samples.map((s: { work: { sql: number } }) => s.work.sql), Array(600).fill(3));
    const records = await verifyEvidenceBundle(directory, false);
    assert(records.length > 0 && records.every(r => r.verdict === "pass"));
    assert(records.some(r => r.audit === "public-metadata"));
    assert(record.capacity!.samples.every(s => !Object.keys(s).some(k => /player|game|feature|forecast|context/i.test(k))));
  });

  test(`#${issue} public evidence refuses changed schedules, process/work/source identities and phase/tail arithmetic`, async () => {
    const { receipt, record } = await evidence(issue);
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
      (v: FullCapacityBenchmark) => { v.codeHashes["services/pipeline/src/featureStore/predict.ts"] = "0".repeat(64); },
      ...(issue === 242 ? [
        (v: FullCapacityBenchmark) => { v.trials[0].startupMaximumMs!++; },
        (v: FullCapacityBenchmark) => { v.trials[0].startupTail![0].index++; },
        (v: FullCapacityBenchmark) => { v.trials[0].startupTail!.reverse(); },
        (v: FullCapacityBenchmark) => { Object.assign(v, { startupGate: { ...v.startupGate, sampleDeadlineMs: 301 } }); },
        (v: FullCapacityBenchmark) => { Object.assign(v, { schemaVersion: 1 }); },
      ] : []),
    ]) {
      const altered = structuredClone(receipt); mutate(altered);
      assert.throws(() => verifyPublicEvidenceReceipt(altered, record), /public-receipt-identity-mismatch/);
      // Even if a replacement projection pins this altered receipt, the shared
      // deterministic schedule/work/timing checks still refuse it.
      const changedProjection = structuredClone(record); changedProjection.receipts = [receiptIdentity(altered)];
      assert.throws(() => verifyPublicEvidenceReceipt(altered, changedProjection));
    }
  });
}
