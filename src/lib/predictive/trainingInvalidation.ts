import { canonical, digest, exact, refuse } from "./validation.ts";

export const TRAINING_INVALIDATION_VERSION = "qb-training-invalidation-v1";
export type TrainingInvalidationTarget = { kind: "run" | "dataset"; id: string; sha256: string | null };
export const normalizeTrainingInvalidationTarget = (input: TrainingInvalidationTarget) => {
  exact(input, ["kind", "id", "sha256"]);
  if (!["run", "dataset"].includes(input.kind) || typeof input.id !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(input.id) || input.id.includes("|")) refuse("training-invalidation-target-refused");
  if (input.sha256 !== null && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))) {
    refuse("training-invalidation-target-refused");
  }
  return structuredClone(input);
};
export const TRAINING_INVALIDATION_OPERATIONS = ["run-metadata", "run-readiness", "shard-verify", "dataset-prepare",
  "dataset-manifest", "dataset-page", "dataset-pin"] as const;
export type TrainingInvalidationOperation = typeof TRAINING_INVALIDATION_OPERATIONS[number];

// Request mistakes, capacity refusals, cancellation, lock/statement timeouts,
// connection failures and programmer errors are not evidence invalidations.
// SQL repeats this allowlist; neither side stores arbitrary exception messages.
export const TRAINING_INVALIDATION_FAILURES = {
  "training-run-rights-refused": "rights-unavailable",
  "training-dataset-rights-refused": "rights-unavailable",
  "training-kickoff-rights-refused": "rights-unavailable",
  "source-consumer-rights-refused": "rights-unavailable",
  "predictive-source-plan-rights-profile-invalid": "rights-unavailable",
  "source-normalization-rights-refused": "rights-unavailable",
  "compressed-selection-rights-refused": "rights-unavailable",
  "training-run-evidence-removed": "evidence-removed",
  "training-dataset-evidence-removed": "evidence-removed",
  "training-shard-feature-expired": "evidence-expired",
  "training-dataset-feature-expired": "evidence-expired",
  "artifact-integrity-failed": "evidence-integrity-failed",
  "stored-observation-mismatch": "evidence-integrity-failed",
  "stored-source-row-mismatch": "evidence-integrity-failed",
  "stored-source-consumer-mismatch": "evidence-integrity-failed",
  "training-shard-evidence-mismatch": "evidence-integrity-failed",
  "training-shard-kickoff-mismatch": "evidence-integrity-failed",
  "training-inventory-integrity-refused": "evidence-integrity-failed",
  "training-dataset-integrity-refused": "evidence-integrity-failed",
  "compressed-inspection-integrity-failed": "evidence-integrity-failed",
  "compressed-publication-integrity-failed": "evidence-integrity-failed",
  "compressed-wire-integrity-failed": "evidence-integrity-failed",
  "artifact-file-refused": "evidence-inaccessible",
  "artifact-root-refused": "evidence-inaccessible",
  "artifact-reference-refused": "evidence-inaccessible",
  "artifact-unreadable": "evidence-inaccessible",
} as const;
export type TrainingInvalidationFailure = keyof typeof TRAINING_INVALIDATION_FAILURES;
export type TrainingInvalidationReason = typeof TRAINING_INVALIDATION_FAILURES[TrainingInvalidationFailure];
export const trainingInvalidationFailure = (error: unknown): TrainingInvalidationFailure | null => {
  if (!(error instanceof Error)) return null;
  if (Object.hasOwn(TRAINING_INVALIDATION_FAILURES, error.message)) return error.message as TrainingInvalidationFailure;
  if (["ENOENT", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return "artifact-unreadable";
  return null;
};
export type TrainingInvalidationRequest = {
  version: typeof TRAINING_INVALIDATION_VERSION; target: TrainingInvalidationTarget;
  operation: TrainingInvalidationOperation; failureCode: TrainingInvalidationFailure;
};
export const normalizeTrainingInvalidationRequest = (input: TrainingInvalidationRequest) => {
  exact(input, ["version", "target", "operation", "failureCode"]);
  if (input.version !== TRAINING_INVALIDATION_VERSION || !TRAINING_INVALIDATION_OPERATIONS.includes(input.operation) ||
      !Object.hasOwn(TRAINING_INVALIDATION_FAILURES, input.failureCode)) refuse("training-invalidation-request-refused");
  return { ...input, target: normalizeTrainingInvalidationTarget(input.target) };
};
export type TrainingInvalidationAddress = {
  version: "qb-training-invalidation-address-v1"; kind: "run" | "dataset";
  identitySha256: string; runIdentitySha256: string; datasetIdentitySha256: string | null;
  inventorySha256: string; manifestSha256: string | null;
};
export type TrainingInvalidationReceipt = {
  version: typeof TRAINING_INVALIDATION_VERSION; ordinal: number; eventSha256: string; recordedAt: string;
  address: TrainingInvalidationAddress; addressSha256: string; reason: TrainingInvalidationReason;
  operation: TrainingInvalidationOperation | "retention";
  failureCode: TrainingInvalidationFailure | "retention-evidence-removed" | "retention-evidence-expired";
  origin: "reader-reported" | "database-confirmed" | "authorized-retention"; causeSha256: string;
};
export type TrainingInvalidationAudit =
  | { status: "recorded"; receipt: TrainingInvalidationReceipt & { reused: boolean } }
  | { status: "not-installed" }
  | { status: "failed"; code: string };
export class TrainingReadWithheldError extends Error {
  readonly code: TrainingInvalidationFailure;
  readonly invalidation: TrainingInvalidationAudit;
  constructor(failure: TrainingInvalidationFailure, cause: unknown, audit: TrainingInvalidationAudit) {
    super(failure, { cause }); this.name = "TrainingReadWithheldError"; this.code = failure;
    this.invalidation = structuredClone(audit);
  }
}
export type TrainingInvalidationHistoryRequest = {
  version: typeof TRAINING_INVALIDATION_VERSION; target: TrainingInvalidationTarget;
  afterOrdinal: number | null; throughOrdinal: number | null; limit: number;
};
export const normalizeTrainingInvalidationHistoryRequest = (input: TrainingInvalidationHistoryRequest) => {
  exact(input, ["version", "target", "afterOrdinal", "throughOrdinal", "limit"]);
  if (input.version !== TRAINING_INVALIDATION_VERSION || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64 ||
      [input.afterOrdinal, input.throughOrdinal].some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0)) ||
      input.afterOrdinal !== null && (input.throughOrdinal === null || input.afterOrdinal > input.throughOrdinal)) {
    refuse("training-invalidation-history-request-refused");
  }
  return { ...input, target: normalizeTrainingInvalidationTarget(input.target) };
};
export type TrainingInvalidationHistory = {
  version: typeof TRAINING_INVALIDATION_VERSION; addressSha256: string; throughOrdinal: number;
  entries: TrainingInvalidationReceipt[]; nextAfterOrdinal: number | null;
};
// Receipts contain only digests, enums and database clocks. They report a
// refusal, never source bytes, repair certification, deletion authority or
// permission to use a previously delivered page.
export const trainingInvalidationReceiptDigest = (receipt: TrainingInvalidationReceipt) => digest(canonical({
  version: receipt.version, addressSha256: receipt.addressSha256, reason: receipt.reason, operation: receipt.operation,
  failureCode: receipt.failureCode, origin: receipt.origin, causeSha256: receipt.causeSha256,
}));
