import type { TrainingDatasetManifest } from "./trainingDatasets.ts";
import type { TrainingRunInventory } from "./trainingRuns.ts";
import { trainingShardMembership, type TrainingShardProof } from "./trainingShards.ts";
import { TRAINING_READ_VERSION } from "./training.ts";
import { canonical, compareText, digest, exact, instant, refuse } from "./validation.ts";

export type TrainingRunReadRequest = {
  version: typeof TRAINING_READ_VERSION; fittingRunId: string; inventorySha256: string;
};
export const normalizeTrainingRunReadRequest = (input: TrainingRunReadRequest) => {
  exact(input, ["version", "fittingRunId", "inventorySha256"]);
  if (input.version !== TRAINING_READ_VERSION) refuse("training-version-refused");
  if (typeof input.fittingRunId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(input.fittingRunId) || input.fittingRunId.includes("|")) {
    refuse("training-identity-refused");
  }
  if (typeof input.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.inventorySha256)) refuse("training-digest-refused");
  return structuredClone(input);
};

// Enumerate from the complete sealed run, never from a caller's shard subset.
// This is structural correspondence only; guarded SQL and actual byte checks
// remain the store's responsibility before emitting a readiness report.
export const trainingRunDatasetIds = (inventory: TrainingRunInventory, input: TrainingRunReadRequest) => {
  const request = normalizeTrainingRunReadRequest(input);
  const ids = [...new Set(inventory.request.slots.map((slot) => slot.datasetId))].sort(compareText);
  for (const datasetId of ids) trainingShardMembership(inventory, { ...request, datasetId });
  return ids;
};

export const trainingReadinessCounts = (rows: TrainingRunInventory["rows"]) =>
  (["training", "evaluation"] as const).map((partition) => {
    const members = rows.filter((row) => row.slot.partition === partition);
    return { partition, slots: members.length, targetEvents: new Set(members.map((row) => row.slot.gameId)).size,
      usableFeatures: members.filter((row) => row.feature.state === "usable").length,
      missingFeatures: members.filter((row) => row.feature.state === "missing").length,
      unavailableFeatures: members.filter((row) => row.feature.state === "unavailable").length,
      expiredFeatures: members.filter((row) => row.feature.state === "expired").length,
      usableLabels: members.filter((row) => row.label.state === "usable").length,
      missingLabels: members.filter((row) => row.label.state === "missing").length };
  });

export type TrainingVerifiedDataset = {
  manifest: TrainingDatasetManifest;
  proof: Pick<TrainingShardProof, "request" | "rows" | "counts" | "selectionSha256" | "verifiedAt">;
};

export const trainingRunReadiness = (inventory: TrainingRunInventory, input: TrainingRunReadRequest,
  checked: ReadonlyMap<string, TrainingVerifiedDataset | null>, checkedAt: string) => {
  const request = normalizeTrainingRunReadRequest(input), ids = trainingRunDatasetIds(inventory, request);
  if (instant(checkedAt) < instant(inventory.snapshotAt)) refuse("training-shard-clock-refused");
  if (checked.size !== ids.length || ids.some((id) => !checked.has(id))) refuse("training-run-dataset-inventory-mismatch");
  const counts = trainingReadinessCounts(inventory.rows);
  if (canonical(counts) !== canonical(inventory.counts)) refuse("training-run-counts-mismatch");
  const datasets = ids.map((datasetId) => {
    const rows = trainingShardMembership(inventory, { ...request, datasetId }), entry = checked.get(datasetId);
    const selectionSha256 = digest(canonical({ inventorySha256: request.inventorySha256, datasetId, rows }));
    const shardCounts = trainingReadinessCounts(rows);
    if (entry) {
      const { manifest, proof } = entry;
      if (manifest.datasetId !== datasetId || manifest.fittingRunId !== request.fittingRunId ||
          manifest.inventorySha256 !== request.inventorySha256 || !/^[a-f0-9]{64}$/.test(manifest.manifestSha256) ||
          typeof manifest.activePin !== "boolean" || canonical(manifest.rows) !== canonical(rows) ||
          canonical(manifest.counts) !== canonical(shardCounts) || canonical(proof.rows) !== canonical(rows) ||
          canonical(proof.counts) !== canonical(shardCounts) || canonical(proof.request) !== canonical({ ...request, datasetId }) ||
          proof.selectionSha256 !== selectionSha256 || instant(proof.verifiedAt) > instant(checkedAt) ||
          instant(proof.verifiedAt) < instant(inventory.snapshotAt)) refuse("training-run-dataset-inventory-mismatch");
    }
    return { datasetId, state: entry ? "verified" as const : "missing" as const,
      reason: entry ? null : "dataset-not-sealed", manifestSha256: entry?.manifest.manifestSha256 ?? null,
      activePin: entry?.manifest.activePin ?? false, selectionSha256, ordinals: rows.map((row) => row.ordinal), counts: shardCounts };
  });
  const datasetsComplete = datasets.every((dataset) => dataset.state === "verified");
  const durablyPinned = datasetsComplete && datasets.every((dataset) => dataset.activePin);
  const usablePairs = inventory.rows.filter((row) => row.feature.state === "usable" && row.label.state === "usable").length;
  const usableEvidenceComplete = datasetsComplete && usablePairs === inventory.rows.length;
  const blockers = [
    ...(!datasetsComplete ? ["datasets-not-sealed"] : []),
    ...(datasets.some((dataset) => dataset.state === "verified" && !dataset.activePin) ? ["datasets-not-pinned"] : []),
    ...(counts.some((count) => count.usableFeatures !== count.slots) ? ["features-not-usable"] : []),
    ...(counts.some((count) => count.usableLabels !== count.slots) ? ["labels-not-usable"] : []),
    "population-unqualified",
  ];
  const body = { version: "qb-training-run-readiness-v1" as const, request, inventorySnapshotAt: inventory.snapshotAt,
    status: datasetsComplete ? "verified" as const : "incomplete" as const, datasetsComplete, durablyPinned, usableEvidenceComplete,
    fittingReady: false as const, populationCoverage: "unqualified" as const, blockers, datasets, counts,
    requestedSlots: inventory.rows.length, verifiedSlots: datasets.filter((dataset) => dataset.state === "verified")
      .reduce((total, dataset) => total + dataset.ordinals.length, 0), usablePairs, reuseDisclosure: inventory.reuseDisclosure };
  // Ephemeral access-time report, never a durable byte certificate or fitting
  // authorization. The stable digest excludes the access clock and metrics.
  return { ...body, checkedAt, readinessSha256: digest(canonical(body)) };
};
