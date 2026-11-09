import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { verifyProducerBenchmark, type ProducerBenchmark } from "../../scripts/feature-store/producer-capacity-evidence.ts";
import type { Attempt } from "../../scripts/feature-store/producer-capacity-contract.ts";

const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-169/", import.meta.url));
const evidence = async () => {
  const receipt = JSON.parse(await readFile(directory + "benchmark-20261109T050208Z.json", "utf8"));
  const [archive, member] = receipt.fullRecord.path.split("#");
  assert.equal(archive, "records-20261109T050208Z.tar.gz"); assert.equal(member, "run-20261109T050208Z.json");
  const bytes = execFileSync("tar", ["-xOzf", directory + archive, member], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(sha256(bytes), receipt.fullRecord.sha256); assert.equal(bytes.length, receipt.fullRecord.byteSize);
  return { receipt, bytes, full: JSON.parse(bytes.toString()) as ProducerBenchmark };
};

test("#169 committed evidence recomputes 30 attempts, final sources, 12/8 work and teardown offline", async () => {
  const { receipt, full } = await evidence();
  assert.deepEqual(verifyProducerBenchmark(full), receipt.verification);
  assert.equal(receipt.source.gitSha, "55d512b15c3e340c128d8b4195783faa00e29385");
  assert.equal(receipt.verification.sourceCount, 77);
  assert.equal(receipt.verification.qualification, "pass");
  assert.deepEqual(receipt.verification.attempts.map((a: { sql: number }) => a.sql), [...Array(24).fill(12), ...Array(6).fill(8)]);
  assert.equal(Object.keys(full.records).filter(n => n.endsWith(".down.json")).length, 15);
  const records = await verifyEvidenceBundle(directory);
  assert.equal(records.length, 43); assert(records.every(r => r.verdict === "pass"));
});

test("#169 real records refuse changed bytes, work, loopback provenance and missing diagnostics", async () => {
  const { receipt, bytes, full } = await evidence();
  assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.from("not JSON")), /sha256/);
  assert.throws(() => verifyEvidenceReceipt({ ...receipt, verification: { ...receipt.verification, started: 29 } }, bytes), /receipt-mismatch/);
  for (const mutate of [
    (f: ProducerBenchmark) => { (f.records["games.csv.gz-b1-cold.result.json"] as Attempt).measurement.result!.sql.pop(); },
    (f: ProducerBenchmark) => { (f.records["games.csv.gz-b1-cold.result.json"] as Attempt).measurement.result!.loopback!.origin = "https://github.com"; },
    (f: ProducerBenchmark) => { delete (f.records["features-2025-b1-cold.result.json"] as Attempt).diagnostics; },
    (f: ProducerBenchmark) => { delete f.records["features-2025-b3.down.json"]; },
  ]) {
    const altered = structuredClone(full); mutate(altered);
    assert.throws(() => verifyProducerBenchmark(altered));
  }
});

test("#169 discovery stops retain original hashes and do not count as final qualification", async () => {
  const receipt = JSON.parse(await readFile(directory + "discovery-20261109T050208Z.json", "utf8"));
  assert.equal(receipt.qualification, "historical-not-qualification");
  const original = receipt.records.find((r: { path: string }) => r.path.endsWith("paired-20261109T034004Z/report.json"));
  const resumed = receipt.records.find((r: { path: string }) => r.path.endsWith("resumed-20261109T034805Z/report.json"));
  assert.equal(original.sha256, "fdcc09a24ffb0b94cdfbcd7d05b28b8cc674ba20df82bb5a124931d82d3d3900");
  assert.equal(resumed.sha256, "23cbf4bf3acb623344b70f3ee4f722b4d080126758b323140ee333f8aa123a0a");
  assert.equal(receipt.observations.find((r: { run: string }) => r.run === "paired-20261109T034004Z").status, "stopped");
  assert.equal(receipt.observations.find((r: { run: string }) => r.run === "resumed-20261109T034805Z").newSamples, 10);
});
