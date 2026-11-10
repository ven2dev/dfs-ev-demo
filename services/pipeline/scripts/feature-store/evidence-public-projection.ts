import assert from "node:assert/strict";
import { evidenceIdentity, type EvidenceIdentity } from "./evidence-records.ts";
import { verifyCapacityRecordedMetadata, type FullCapacityBenchmark } from "./prediction-capacity-evidence.ts";
import type { CapacitySample } from "./prediction-capacity-process.ts";

type PublicSample = EvidenceIdentity & { status: "available" | "unavailable"; reason: string | null;
  timing: Record<string, number | CapacitySample["queries"]> };
export type PublicRecordProjection = { member: string; receipts: EvidenceIdentity[];
  capacity?: { samples: PublicSample[]; warmControlSamples: PublicSample[] } };
export type EvidencePublicProjection = { schema: "prediction-evidence-public-v1"; archiveSha256: string; records: PublicRecordProjection[] };
const timingFields = ["totalMs", "spawnMs", "bootstrapMs", "importMs", "storeMs", "startupMs", "residualMs", "connectMs", "handlerMs"];
const exact = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "unexpected-public-projection-fields");
export const receiptIdentity = (receipt: unknown) => evidenceIdentity(Buffer.from(JSON.stringify(receipt)));

const projectSample = (sample: CapacitySample): PublicSample => {
  assert(typeof sample.serialized === "string", "sample-response-bytes-required");
  const response = JSON.parse(sample.serialized);
  assert(["available", "unavailable"].includes(response.status));
  return { ...evidenceIdentity(Buffer.from(sample.serialized)), status: response.status, reason: response.reason ?? null,
    timing: { ...Object.fromEntries(timingFields.filter(key => key in sample).map(key => [key, sample[key as keyof CapacitySample]])),
      ...(sample.queries ? { queries: sample.queries.map(q => ({ kind: q.kind, elapsedMs: q.elapsedMs })) } : {}) } as PublicSample["timing"] };
};
export const projectCapacityResponses = (full: FullCapacityBenchmark) => ({
  samples: full.samples.map(projectSample), warmControlSamples: full.warmControlSamples?.map(projectSample) ?? [],
});

const validatePublicRecord = (record: PublicRecordProjection) => {
  exact(record, record.capacity ? ["member", "receipts", "capacity"] : ["member", "receipts"]);
  assert(Array.isArray(record.receipts));
  for (const identity of record.receipts) {
    exact(identity, ["sha256", "byteSize"]);
    assert(/^[a-f0-9]{64}$/.test(identity.sha256) && Number.isSafeInteger(identity.byteSize) && identity.byteSize > 0);
  }
  if (!record.capacity) return;
  exact(record.capacity, ["samples", "warmControlSamples"]);
  for (const samples of [record.capacity.samples, record.capacity.warmControlSamples]) {
    assert(Array.isArray(samples));
    for (const sample of samples) {
      exact(sample, ["sha256", "byteSize", "status", "reason", "timing"]);
      assert(/^[a-f0-9]{64}$/.test(sample.sha256) && Number.isSafeInteger(sample.byteSize) && sample.byteSize > 0);
      assert(["available", "unavailable"].includes(sample.status));
      assert(sample.reason === null || typeof sample.reason === "string" && /^[a-z0-9-]+$/.test(sample.reason));
      assert(sample.timing && typeof sample.timing === "object");
      for (const [key, number] of Object.entries(sample.timing)) {
        if (key === "queries") {
          assert(Array.isArray(number));
          for (const query of number) {
            exact(query, ["kind", "elapsedMs"]);
            assert(["context", "check"].includes(query.kind) && Number.isFinite(query.elapsedMs) && query.elapsedMs >= 0);
          }
        } else assert(timingFields.includes(key) && typeof number === "number" && Number.isFinite(number) && number >= 0);
      }
    }
  }
};
export const validateEvidenceProjection = (value: EvidencePublicProjection, archiveSha256: string) => {
  exact(value, ["schema", "archiveSha256", "records"]);
  assert.equal(value.schema, "prediction-evidence-public-v1", "unknown-public-projection-format");
  assert.equal(value.archiveSha256, archiveSha256, "projection-archive-mismatch");
  assert(Array.isArray(value.records), "invalid-projection-records");
  const members = new Set<string>();
  for (const record of value.records) {
    assert(!members.has(record.member), "duplicate-public-projection-member"); members.add(record.member);
    validatePublicRecord(record);
  }
};

// The receipt stays byte-for-byte historical. New per-sample data is limited
// to response hash/size/status/refusal and timings; no identifier is added.
export const verifyPublicEvidenceReceipt = (receipt: Record<string, unknown>, record: PublicRecordProjection, enforceSpeed = false) => {
  validatePublicRecord(record);
  const identity = receiptIdentity(receipt);
  assert(record.receipts.some(r => r.sha256 === identity.sha256 && r.byteSize === identity.byteSize), "public-receipt-identity-mismatch");
  if (receipt.kind !== "prediction-capacity-benchmark") return { audit: "public-metadata" as const, recomputed: false };
  assert(record.capacity, "missing-public-capacity-projection");
  const full = structuredClone(receipt) as unknown as FullCapacityBenchmark;
  assert.equal(full.samples.length, record.capacity.samples.length, "public-sample-count-mismatch");
  full.samples.forEach((sample, i) => {
    const projected = record.capacity!.samples[i];
    assert.equal(projected.status, "available"); assert.equal(projected.reason, null);
    assert.equal(sample.outputBytes, projected.byteSize, "public-output-size-mismatch");
    for (const key of timingFields) if (key in sample) assert.equal(sample[key as keyof CapacitySample], projected.timing[key], "public-sample-timing-mismatch");
    const queries = projected.timing.queries as CapacitySample["queries"];
    assert.deepEqual(sample.queries, queries?.map(q => q.kind), "public-query-order-mismatch");
    sample.queries = queries;
    // No serialized response is present or manufactured for this metadata path.
    assert(!("serialized" in sample), "public-response-bytes-refused");
  });
  const statuses = record.capacity.warmControlSamples.map((sample, i) => {
    const status = { status: sample.status, ...(sample.reason === null ? {} : { reason: sample.reason }) };
    const reported = (receipt.warmControlSamples as { status: string; reason: string | null }[])[i];
    assert(reported && reported.status === sample.status && reported.reason === sample.reason, "public-control-status-mismatch");
    return status;
  });
  const verification = verifyCapacityRecordedMetadata(full, statuses, enforceSpeed);
  assert.deepEqual(verification, receipt.verification, "public-capacity-verification-mismatch");
  // Full forecast/context/value/linkage checks require the retained bytes.
  return { audit: "public-metadata" as const, recomputed: true, verification };
};

