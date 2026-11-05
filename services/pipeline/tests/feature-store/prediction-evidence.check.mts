import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compactBehavior, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";

// Recorded work arithmetic only: no clock or speed assertion in CI. The shared
// bundle-membership test already checks every #167 receipt's member hash/size.
const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-167/", import.meta.url));
const receiptName = "step-2-behavior-20261105T0310Z.json";
const evidence = async () => {
  const receipt = JSON.parse(await readFile(directory + receiptName, "utf8"));
  const [archive, member] = receipt.fullRecord.path.split("#");
  const bytes = execFileSync("tar", ["-xOzf", directory + archive, member]);
  // Verify bytes before parsing any detailed measurement.
  verifyEvidenceReceipt(receipt, bytes);
  return { receipt, bytes, full: JSON.parse(bytes.toString()) };
};
test("#167 handler receipt recomputes all-n/prefix/dynamic rights budgets and matched database work", async () => {
  const { receipt, bytes } = await evidence();
  assert.equal(receipt.work.allNSuccessControls, 30);
  assert.deepEqual([receipt.work.sql, receipt.work.combinedChecks, receipt.work.descriptorGets, receipt.work.modelOnlySql], [3, 2, 1, 2]);
  assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /full-record-sha256-mismatch/);
});
test("#167 handler evidence refuses hidden work, forged counts, omitted cohorts and ineffective server observers", async () => {
  const { receipt, bytes, full } = await evidence();
  for (const mutate of [
    (value: typeof full) => { value.budgets[0].rightsCalls++; },
    (value: typeof full) => { value.budgets[0].work.sql++; },
    (value: typeof full) => { value.budgets[0].work.hashes++; },
    (value: typeof full) => { value.probes[0].details.pop(); },
    (value: typeof full) => { value.budgets[0].trace.reverse(); },
    (value: typeof full) => { value.probes.find((p: { name: string }) => p.name.startsWith("actual handler Q1/Q2 database work"))
      .details.matched[1].q1[0].seq_scan++; },
    (value: typeof full) => { value.probes.find((p: { name: string }) => p.name.startsWith("actual handler Q1/Q2 database work"))
      .details.negativeControls.writeDetected = false; },
  ]) {
    const modified = structuredClone(full); mutate(modified);
    assert.throws(() => compactBehavior(Buffer.from(JSON.stringify(modified)), receipt.fullRecord.path));
  }
  assert.throws(() => verifyEvidenceReceipt({ ...receipt, work: { ...receipt.work, combinedChecks: 4 } },
    bytes), /compact-receipt-mismatch/);
});
