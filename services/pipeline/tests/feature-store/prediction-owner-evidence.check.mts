import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compactBehavior, verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";

const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-168/", import.meta.url));
const load = async (prefix: string) => {
  const names = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith(".json"));
  assert.equal(names.length, 1);
  const receipt = JSON.parse(await readFile(directory + names[0], "utf8"));
  const [archive, member] = receipt.fullRecord.path.split("#");
  const bytes = execFileSync("tar", ["-xOzf", directory + archive, member]);
  verifyEvidenceReceipt(receipt, bytes); // SHA-256 and size precede parsing/recomputation.
  return { receipt, bytes, full: JSON.parse(bytes.toString()) };
};

test("#168 Step 0 evidence is independently auditable without a database/cache or timing gate", async () => {
  // Final speed receipts now share this directory. CI checks all member hashes;
  // the opt-in audit owns recorded latency gates, not this Step 0 owner test.
  const records = await verifyEvidenceBundle(directory, false);
  assert(records.length >= 2 && records.every(r => r.verdict === "pass"));
  for (const prefix of ["step-0-handler-", "step-0-owner-"]) {
    const { receipt, bytes } = await load(prefix);
    assert.equal(receipt.issue, 168); assert.equal(receipt.step, 0);
    assert.deepEqual(Object.keys(receipt.sourceHashes).sort(), Object.keys(receipt.sourceBlobIds).sort());
    assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /full-record-sha256-mismatch/);
  }
});
test("#168 owner receipt recomputes exactly-once disposal, bounded startup and no-late-query controls", async () => {
  const { receipt, full } = await load("step-0-owner-");
  assert.deepEqual([receipt.work.sql, receipt.work.combinedChecks, receipt.work.descriptorGets], [3, 2, 1]);
  for (const change of [
    (r: typeof full) => { r.probes[0].details[0].ownerEnds++; },
    (r: typeof full) => { r.probes[1].details[0].destroyingReleases = 0; },
    (r: typeof full) => { r.probes[1].details[2].noLateQuery = false; },
    (r: typeof full) => { r.probes[2].details[0].handlerEndCapability = true; },
    (r: typeof full) => { r.probes[3].details.statementTimeoutMs = 301; },
    (r: typeof full) => { r.probes[4].details.connections = 1; },
    (r: typeof full) => { r.probes.pop(); },
  ]) {
    const altered = structuredClone(full); change(altered);
    assert.throws(() => compactBehavior(Buffer.from(JSON.stringify(altered)), receipt.fullRecord.path));
  }
});
