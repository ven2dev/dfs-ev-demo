import { describe, expect, it } from "vitest";
import { normalizeTrainingInvalidationHistoryRequest, normalizeTrainingInvalidationRequest, trainingInvalidationFailure,
  trainingInvalidationReceiptDigest, TrainingReadWithheldError, type TrainingInvalidationReceipt } from "../../src/lib/predictive/trainingInvalidation.ts";

const target = { kind: "dataset" as const, id: "fixed-dataset", sha256: "a".repeat(64) };
const request = () => ({ version: "qb-training-invalidation-v1" as const, target, operation: "dataset-page" as const, failureCode: "artifact-integrity-failed" as const });
describe("minimal evidence-refusal audits", () => {
  it("refuses caller clocks free-form diagnostics source payloads and unsupported failure classes", () => {
    expect(normalizeTrainingInvalidationRequest(request())).toEqual(request());
    for (const extra of [{ recordedAt: "2026-01-01T00:00:00.000Z" }, { message: "private contents" }, { sourceRows: [] }, { origin: "database-confirmed" }]) {
      expect(() => normalizeTrainingInvalidationRequest({ ...request(), ...extra } as never)).toThrow("schema-fields-refused");
    }
    expect(() => normalizeTrainingInvalidationRequest({ ...request(), operation: "retention" } as never)).toThrow("training-invalidation-request-refused");
    expect(() => normalizeTrainingInvalidationRequest({ ...request(), failureCode: "57014" } as never)).toThrow("training-invalidation-request-refused");
    expect(() => normalizeTrainingInvalidationRequest({ ...request(), target: { ...target, sha256: "wrong" } })).toThrow("training-invalidation-target-refused");
  });
  it("classifies evidence failures without turning malformed requests capacity cancellation or transport errors into invalidation", () => {
    expect(trainingInvalidationFailure(new Error("artifact-integrity-failed"))).toBe("artifact-integrity-failed");
    const missing = Object.assign(new Error("ENOENT: secret owner path and payload"), { code: "ENOENT" });
    expect(trainingInvalidationFailure(missing)).toBe("artifact-unreadable");
    for (const code of ["schema-fields-refused", "training-page-cursor-refused", "training-page-byte-bounds-refused", "source-verification-byte-bounds-refused",
      "predictive-session-busy", "57014", "55P03", "ECONNRESET", "AbortError"]) {
      expect(trainingInvalidationFailure(Object.assign(new Error(code), { code }))).toBeNull();
    }
    expect(trainingInvalidationFailure("artifact-integrity-failed")).toBeNull();
    const error = new TrainingReadWithheldError("artifact-unreadable", missing, { status: "failed", code: "training-invalidation-audit-failed" });
    expect(error.message).toBe("artifact-unreadable"); expect(error.cause).toBe(missing);
    expect(JSON.stringify(error.invalidation)).not.toContain("secret");
  });
  it("binds the stable receipt to its exact cause scope and operation while excluding restore clocks and ordinals", () => {
    const receipt: TrainingInvalidationReceipt = { version: "qb-training-invalidation-v1", ordinal: 1, eventSha256: "", recordedAt: "2026-10-14T12:00:00.000Z",
      addressSha256: "a".repeat(64), address: { version: "qb-training-invalidation-address-v1", kind: "dataset", identitySha256: "b".repeat(64),
        runIdentitySha256: "c".repeat(64), datasetIdentitySha256: "b".repeat(64), inventorySha256: "d".repeat(64), manifestSha256: "e".repeat(64) },
      reason: "evidence-integrity-failed", operation: "dataset-page", failureCode: "artifact-integrity-failed", origin: "reader-reported", causeSha256: "f".repeat(64) };
    const first = trainingInvalidationReceiptDigest(receipt);
    expect(trainingInvalidationReceiptDigest({ ...receipt, ordinal: 20, recordedAt: "2026-11-14T12:00:00.000Z" })).toBe(first);
    expect(trainingInvalidationReceiptDigest({ ...receipt, causeSha256: "0".repeat(64) })).not.toBe(first);
    expect(trainingInvalidationReceiptDigest({ ...receipt, operation: "dataset-manifest" })).not.toBe(first);
    expect(trainingInvalidationReceiptDigest({ ...receipt, origin: "database-confirmed" })).not.toBe(first);
  });
  it("bounds audit history and requires a fixed upper ordinal when continuing a page", () => {
    const history = { version: "qb-training-invalidation-v1" as const, target, afterOrdinal: null, throughOrdinal: null, limit: 64 };
    expect(normalizeTrainingInvalidationHistoryRequest(history)).toEqual(history);
    expect(normalizeTrainingInvalidationHistoryRequest({ ...history, afterOrdinal: 4, throughOrdinal: 6 }).afterOrdinal).toBe(4);
    for (const extra of [{ limit: 65 }, { afterOrdinal: 4 }, { afterOrdinal: 7, throughOrdinal: 6 }, { throughOrdinal: -1 }, { throughOrdinal: 1.5 }]) {
      expect(() => normalizeTrainingInvalidationHistoryRequest({ ...history, ...extra })).toThrow("training-invalidation-history-request-refused");
    }
  });
});
