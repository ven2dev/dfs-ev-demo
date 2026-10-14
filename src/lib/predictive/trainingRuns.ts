import type { ConsumerReference, FittingRunRequest, TrainingMetadataSelection, TrainingSelectedRow } from "./training.ts";

// Database-created metadata only. A sealed inventory fixes all future shard
// selections, but no shard/pin/byte proof or fitting readiness is created here.
export type TrainingRunInventory = {
  version: "qb-training-run-inventory-v1"; status: "inventory-sealed"; fittingReady: false;
  populationCoverage: "unqualified"; snapshotAt: string; request: FittingRunRequest; requestSha256: string; inventorySha256: string;
  rows: {
    ordinal: number; slot: FittingRunRequest["slots"][number]; history: TrainingSelectedRow["history"];
    selection: TrainingMetadataSelection;
    kickoff: { observationId: string; decisionId: string | null; dependencies: {
      role: "schedule"; observationId: string; profileId: string; sourceKey: string; captureId: string;
      artifactId: string; artifactSha256: string; availableAt: string; ingestedAt: string;
    }[] };
    feature: Omit<TrainingSelectedRow["feature"], "record">;
    label: { state: "missing" | "usable"; reason: string | null; reference: ConsumerReference | null;
      supersededAsOf: boolean; supersededAtSnapshot: boolean };
  }[];
  counts: { partition: "training" | "evaluation"; slots: number; targetEvents: number; usableFeatures: number; usableLabels: number;
    missingFeatures: number; unavailableFeatures: number; expiredFeatures: number; missingLabels: number }[];
  protectedUses: { profile: string; use: "model-input" | "outcome-label" }[];
  reuseDisclosure: { priorRuns: number; targetEventsInRun: number; playerGameTargetsInRun: number;
    reusedTargetEvents: number; reusedPlayerGameTargets: number; interpretation: "repeated-events-are-correlated" };
};
