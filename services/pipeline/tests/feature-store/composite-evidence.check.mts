import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { compactCompositeBenchmark, compositeCohortSummary, verifyCompositeBenchmark,
  verifyEvidenceReceipt, verifyEvidenceBundle, compactBehavior, type FullCompositeBenchmark } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import type { CompositeCase, CompositeSample } from "../../scripts/feature-store/composite-authorization-measure.ts";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";

const fixture = (): FullCompositeBenchmark => {
  const cases: CompositeCase[] = Array.from({ length: 15 }, (_, i) => ({ featureId: `feature-${i}`, n: i + 2,
    request: { playerId: `QB-${i}`, gameId: "game", knownAsOf: "2026-10-31T00:00:00Z", featureVersion: "qb-passing-yards-feature-v1",
      historyPolicy: "prior-eligible-reg-max16-min2-cutoff1h-v1", evidenceMode: "retrospective-reconstruction-v1" } }));
  const sample = (arm: CompositeSample["arm"], temperature: CompositeSample["temperature"], input: CompositeCase,
    phase: CompositeSample["phase"], cohort: number, position: number, read: number): CompositeSample => ({
    arm, temperature, featureId: input.featureId, n: input.n, phase, cohort, position, read, verdict: "pass",
    totalMs: temperature === "cold" ? 13 : 3, setupMs: temperature === "cold" ? 10 : 0, warmPathMs: 3,
    setupShare: temperature === "cold" ? 10 / 13 : 0, getMs: arm === "candidate" ? .5 : 0,
    computeMs: .25, serializationMs: .25, outputBytes: 42,
    work: { sql: 3, checks: 2, gets: arm === "candidate" ? 1 : 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 },
    queries: (arm === "candidate" ? ["context", "check", "check"] as const : ["check", "history", "check"] as const)
      .map(kind => ({ kind, elapsedMs: .5 })) });
  const samples = Array.from({ length: 45 }, (_, i) => sample("baseline", "warm", cases[i % 15], "baseline-first", 0, 0, i + 1));
  const cohorts = [];
  for (const temperature of ["cold", "warm"] as const) for (let cohort = 1; cohort <= 3; cohort++) {
    const current = [];
    for (const [position, arm] of (["baseline", "candidate", "candidate", "baseline"] as const).entries())
      for (let read = 1; read <= 50; read++) current.push(sample(arm, temperature,
        cases[((position < 2 ? 0 : 50) + read - 1) % 15], "interleaved", cohort, position, read));
    samples.push(...current); cohorts.push(compositeCohortSummary(current, temperature, cohort));
  }
  const rows = [{ table: "feature_values", seq_scan: 0, seq_tup_read: 0, idx_scan: 1, idx_tup_fetch: 1, inserted: 0, updated: 0, deleted: 0 }];
  return { kind: "composite-authorization-benchmark", issue: 231, schemaVersion: 3, verdict: "pass", samples, cohorts,
    baselineFirstP95Ms: 3, sourceUnchanged: true,
    requests: { cases, sha256: sha256(Buffer.from(JSON.stringify(cases))), selection: "synthetic arithmetic control" },
    modelOnly: { sql: 2, descriptorGets: 1, verdict: "pass" },
    fixture: { wireFiles: 16, modes: [{ mode: "strict-point-in-time-v1", rowCount: 0, contentSha256: "empty" },
      { mode: "retrospective-reconstruction-v1", rowCount: 2504, contentSha256: "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d" }] },
    serverWork: cases.map(input => ({ n: input.n, featureId: input.featureId, profiles: ["model", "served"], rightsCalls: 4,
      q1: rows, q2: rows, verdict: "pass" })) };
};

test("#231 committed receipts resolve only to checksum-matching durable bundle members, without DB/cache", async () => {
  const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-231/", import.meta.url));
  // CI validates bytes/membership only. No live or recorded speed assertion.
  const results = await verifyEvidenceBundle(directory, false);
  assert.equal(results.length, 3); assert(results.every(result => result.verdict === "pass"));
});
test("#167 Step 0 receipts retain hash-matching append-only evidence without DB/cache", async () => {
  const directory = fileURLToPath(new URL("../../../../docs/evidence/feature-store-167/", import.meta.url));
  const results = await verifyEvidenceBundle(directory, false);
  // Later step receipts append to this directory; every reference is audited.
  assert(results.length >= 2); assert(results.every(result => result.verdict === "pass"));
});
test("append-only evidence audits distinct named bundles without path escapes or ambiguous members", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fs167-evidence-"));
  try {
    const bytes = Buffer.from(JSON.stringify({ issue: 167, step: 0, verdict: "pass", probes: [] }));
    for (const archive of ["step-0-full-records-first.tar.gz", "step-0-full-records-second.tar.gz"]) {
      // Same member name in different bundles remains a distinct hash reference.
      const receipt = compactBehavior(bytes, archive + "#full.json");
      await writeFile(join(directory, archive), deterministicEvidenceBundle([{ member: "full.json", bytes }]));
      await writeFile(join(directory, archive + ".json"), JSON.stringify(receipt));
    }
    assert.equal((await verifyEvidenceBundle(directory)).length, 2);
    const receiptPath = join(directory, "step-0-full-records-first.tar.gz.json");
    for (const path of ["../escape.tar.gz#full.json", "/absolute.tar.gz#full.json", "-option.tar.gz#full.json",
      "step-0-full-records-first.tar.gz#../escape", "step-0-full-records-first.tar.gz#missing.json"]) {
      await writeFile(receiptPath, JSON.stringify(compactBehavior(bytes, path)));
      await assert.rejects(verifyEvidenceBundle(directory), /unexpected-full-record-bundle|absolute-full-record-path|unsafe-full-record-member|missing-full-record-member/);
    }
    await writeFile(receiptPath, JSON.stringify(compactBehavior(Buffer.from("{}"), "step-0-full-records-first.tar.gz#full.json")));
    await assert.rejects(verifyEvidenceBundle(directory), /full-record-sha256-mismatch/);
    await writeFile(receiptPath, JSON.stringify(compactBehavior(bytes, "step-0-full-records-first.tar.gz#full.json")));
    await writeFile(join(directory, "step-0-full-records-first.tar.gz"), deterministicEvidenceBundle([
      { member: "full.json", bytes }, { member: "unreferenced.json", bytes }]));
    await assert.rejects(verifyEvidenceBundle(directory), /unreferenced-bundle-member/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("#231 receipt recomputes full-path cohort percentiles and setup shares after checking the member hash", () => {
  const bytes = Buffer.from(JSON.stringify(fixture())), receipt = compactCompositeBenchmark(bytes, "full-records.tar.gz#final/full-samples.json");
  assert(!("samples" in receipt)); assert("candidateCohorts" in receipt.verification); assert.equal(receipt.verification.candidateCohorts, 6);
  verifyEvidenceReceipt(receipt, bytes);
  assert.throws(() => verifyEvidenceReceipt(receipt, Buffer.concat([bytes, Buffer.from(" ")])), /full-record-sha256-mismatch/);
  receipt.cohorts[0].candidateMeanSetupShare = .1;
  assert.throws(() => verifyEvidenceReceipt(receipt, bytes), /compact-receipt-mismatch/);
});
test("#231 verifier rejects missing work, duplicate coordinates, forged cohorts and incorrect cold setup arithmetic", () => {
  for (const mutate of [
    (full: FullCompositeBenchmark) => { full.samples[45].work.checks = 4; },
    (full: FullCompositeBenchmark) => { full.samples[46] = full.samples[45]; },
    (full: FullCompositeBenchmark) => { full.cohorts[0].candidateP95Ms = 1; },
    (full: FullCompositeBenchmark) => { full.samples[45].warmPathMs = 13; },
    (full: FullCompositeBenchmark) => { full.serverWork![0].rightsCalls = 2; },
    (full: FullCompositeBenchmark) => { full.requests!.cases[0].request.gameId = "tampered"; },
    (full: FullCompositeBenchmark) => { full.samples[45].queries[0].elapsedMs = 100; },
  ]) { const full = fixture(); mutate(full); assert.throws(() => verifyCompositeBenchmark(full)); }
});
test("#231 verifier gates each complete cohort, not stage p95 sums or pooled averages", () => {
  const full = fixture();
  for (const sample of full.samples.filter(s => s.arm === "candidate" && s.temperature === "cold" && s.cohort === 1)) {
    sample.totalMs = 211; sample.warmPathMs = 201; sample.setupShare = 10 / 211;
  }
  full.cohorts[0] = compositeCohortSummary(full.samples.filter(s => s.phase === "interleaved" && s.temperature === "cold" && s.cohort === 1), "cold", 1);
  assert.throws(() => verifyCompositeBenchmark(full), /composite-full-path-headroom-gate-failed/);
});
test("evidence bundle bytes are deterministic USTAR with sorted regular members and fixed metadata", () => {
  const records = [{ member: "z/full.json", bytes: Buffer.from("{\"z\":1}\n") }, { member: "a/full.json", bytes: Buffer.from("{}\n") }];
  const bytes = deterministicEvidenceBundle(records);
  assert.deepEqual(bytes, deterministicEvidenceBundle([...records].reverse()));
  assert.equal(bytes.readUInt32LE(4), 0, "gzip mtime omitted by -n");
  const tar = gunzipSync(bytes), names = [];
  for (let offset = 0; tar[offset];) {
    const header = tar.subarray(offset, offset + 512), text = (at: number, width: number) => header.subarray(at, at + width).toString().replace(/\0.*$/, "");
    const name = text(0, 100), size = parseInt(text(124, 12), 8); names.push(name);
    assert.equal(parseInt(text(108, 8), 8), 0); assert.equal(parseInt(text(116, 8), 8), 0);
    assert.equal(parseInt(text(136, 12), 8), 0); assert.equal(text(156, 1), "0");
    assert.equal(text(265, 32), ""); assert.equal(text(297, 32), "");
    assert.deepEqual(tar.subarray(offset + 512, offset + 512 + size), records.find(r => r.member === name)!.bytes);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, ["a/full.json", "z/full.json"]);
  for (const member of ["../escape", "/absolute", "a/./file", "a//file", "-option", "a".repeat(101)])
    assert.throws(() => deterministicEvidenceBundle([{ member, bytes: Buffer.from("{}") }]), /unsafe-bundle-member/);
});
