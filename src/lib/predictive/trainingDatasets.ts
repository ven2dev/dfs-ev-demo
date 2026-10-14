import { normalizeTrainingShardRequest, type TrainingShardRequest } from "./trainingShards.ts";
import type { TrainingRunInventory } from "./trainingRuns.ts";
import type { FittingRunRequest } from "./training.ts";
import type { SourceConsumerBody } from "./sourceConsumers.ts";
import { exact, refuse } from "./validation.ts";

export type TrainingDatasetRequest = TrainingShardRequest & { pinId: string };
export const normalizeTrainingDatasetRequest = (input: TrainingDatasetRequest) => {
  exact(input, ["version", "fittingRunId", "inventorySha256", "datasetId", "pinId"]);
  const { pinId, ...shard } = input;
  if (typeof pinId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(pinId) || pinId.includes("|")) refuse("training-pin-identity-refused");
  return { ...normalizeTrainingShardRequest(shard), pinId };
};
export type TrainingDatasetManifest = {
  version: "qb-training-dataset-v1"; status: "sealed"; fittingReady: false; populationCoverage: "unqualified";
  datasetId: string; fittingRunId: string; inventorySha256: string; inventorySnapshotAt: string; recordedAt: string;
  requestSha256: string; manifestSha256: string; activePin: boolean; byteVerification: "required-on-every-access";
  rows: TrainingRunInventory["rows"]; counts: TrainingRunInventory["counts"]; protectedUses: TrainingRunInventory["protectedUses"];
  selection: FittingRunRequest["selection"]; modelIdentity: FittingRunRequest["modelIdentity"]; splitPolicy: FittingRunRequest["splitPolicy"];
  population: FittingRunRequest["population"]; fitCutoff: string; evaluationPlanId: string; foldId: string;
  reuseDisclosure: TrainingRunInventory["reuseDisclosure"]; pinEligibility: NonNullable<TrainingRunInventory["pinEligibility"]> | null;
  consumerManifests: { id: string; kind: "feature" | "label"; bodySha256: string; executionDigest: string; manifest: SourceConsumerBody["manifest"] }[];
  consumerIds: string[]; closure: { references: { kind: string; id: string }[];
    protectedUses: TrainingRunInventory["protectedUses"];
    blobs: { sha256: string; storageRef: string; byteSize: number; mediaType: "application/json" | "text/csv" | "application/gzip" }[] };
};
export type TrainingDatasetContext = { manifest: TrainingDatasetManifest; inventory: TrainingRunInventory };
