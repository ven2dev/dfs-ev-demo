import { TRAINING_BOUNDS, type FittingRunRequest, type TrainingMetadataSelection, type TrainingSelectedRow } from "./training.ts";
import { canonical, digest, refuse } from "./validation.ts";

export type TrainingKickoffProof = {
  observationId: string; profileId: string;
  dependencies: { observationId: string; captureId: string; artifactId: string; sha256: string; availableAt: string; ingestedAt: string }[];
  decisions: { id: string; sha256: string }[];
};

// The store constructs this only after guarded SQL selection, current rights,
// kickoff verification and full consumer reconstruction. This pure formatter
// does not authorize an arbitrary caller's records or create durable membership.
export const trainingRunPreview = (request: FittingRunRequest, snapshotAt: string, selected: TrainingSelectedRow[],
  metadata: TrainingMetadataSelection[], kickoffs: TrainingKickoffProof[]) => {
  if (selected.length !== request.slots.length || metadata.length !== selected.length || kickoffs.length !== selected.length ||
      selected.some((row, i) => row.ordinal !== i || metadata[i].ordinal !== i)) refuse("training-selection-inventory-mismatch");
  const requestSha256 = digest(canonical(request));
  const rows = selected.map((row, i) => ({ ordinal: row.ordinal, slot: row.slot, history: row.history,
    selection: metadata[i], kickoff: kickoffs[i],
    feature: { state: row.feature.state, reason: row.feature.reason, reference: row.feature.reference,
      reasons: row.feature.reasons, quality: row.feature.quality },
    label: { state: row.label.state, reason: row.label.reason, reference: row.label.reference,
      supersededAsOf: row.label.supersededAsOf, supersededAtSnapshot: row.label.supersededNow },
  }));
  const counts = (["training", "evaluation"] as const).map((partition) => {
    const members = rows.filter((row) => row.slot.partition === partition);
    return { partition, slots: members.length, targetEvents: new Set(members.map((row) => row.slot.gameId)).size,
      features: { usable: members.filter((row) => row.feature.state === "usable").length,
        unavailable: members.filter((row) => row.feature.state === "unavailable").length,
        missing: members.filter((row) => row.feature.state === "missing").length,
        expired: members.filter((row) => row.feature.state === "expired").length },
      labels: { usable: members.filter((row) => row.label.state === "usable").length,
        missing: members.filter((row) => row.label.state === "missing").length } };
  });
  const preview = { version: "qb-training-run-preview-v1" as const, status: "preview-only" as const,
    fittingReady: false as const, populationCoverage: "unqualified" as const, snapshotAt, request, requestSha256,
    selectionSha256: digest(canonical({ requestSha256, snapshotAt, rows })), rows, counts };
  if (Buffer.byteLength(canonical(preview)) > TRAINING_BOUNDS.pageBytes) refuse("training-page-byte-bounds-refused");
  // Detach references to the caller/verification cache. No numeric source or
  // target-label body is returned by the planning surface.
  return structuredClone(preview);
};
export type TrainingRunPreview = ReturnType<typeof trainingRunPreview>;
