import type { SourceConsumerRecord } from "./sourceConsumers.ts";
import { normalizeFittingRunRequest, selectTrainingRows, TRAINING_BOUNDS } from "./training.ts";
import type { TrainingKickoffProof } from "./trainingPreview.ts";
import type { TrainingRunInventory } from "./trainingRuns.ts";
import { canonical, compareText, digest, exact, instant, refuse } from "./validation.ts";

export type TrainingShardRequest = {
  version: "qb-training-read-v1"; fittingRunId: string; inventorySha256: string; datasetId: string;
};
export const normalizeTrainingShardRequest = (input: TrainingShardRequest) => {
  exact(input, ["version", "fittingRunId", "inventorySha256", "datasetId"]);
  if (input.version !== "qb-training-read-v1") refuse("training-version-refused");
  for (const id of [input.fittingRunId, input.datasetId]) if (typeof id !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(id) || id.includes("|")) refuse("training-identity-refused");
  if (typeof input.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.inventorySha256)) refuse("training-digest-refused");
  return structuredClone(input);
};

// This checks the database-delivered inventory, not a caller-supplied selection.
// The store must still hold the SQL guard and authorize all protected uses.
export const trainingShardMembership = (inventory: TrainingRunInventory, input: TrainingShardRequest) => {
  const request = normalizeTrainingShardRequest(input);
  if (inventory.version !== "qb-training-run-inventory-v1" || inventory.status !== "inventory-sealed" || inventory.fittingReady !== false ||
      inventory.populationCoverage !== "unqualified" || inventory.request.fittingRunId !== request.fittingRunId ||
      inventory.inventorySha256 !== request.inventorySha256) refuse("training-shard-inventory-mismatch");
  const { inventorySha256, ...body } = inventory;
  const normalized = normalizeFittingRunRequest(inventory.request, inventory.snapshotAt);
  if (digest(canonical(body)) !== inventorySha256 || canonical(normalized) !== canonical(inventory.request) ||
      digest(canonical(normalized)) !== inventory.requestSha256 || inventory.rows.length !== normalized.slots.length ||
      inventory.rows.some((row, i) => row.ordinal !== i || row.selection.ordinal !== i || canonical(row.slot) !== canonical(normalized.slots[i]))) {
    refuse("training-shard-inventory-mismatch");
  }
  const rows = inventory.rows.filter((row) => row.slot.datasetId === request.datasetId);
  if (inventory.pinEligibility) {
    exact(inventory.pinEligibility, ["version", "featureIds"]);
    const ids = inventory.pinEligibility.featureIds;
    if (inventory.pinEligibility.version !== "source-feature-pin-eligibility-v1" || !Array.isArray(ids) ||
        new Set(ids).size !== ids.length || ids.some((id) => !inventory.rows.some((row) => row.selection.featureId === id))) {
      refuse("training-shard-pin-policy-refused");
    }
  }
  if (!rows.length) refuse("training-shard-not-assigned");
  if (rows.length > TRAINING_BOUNDS.slotsPerDataset) refuse("training-dataset-bounds-refused");
  return rows;
};

export const assertTrainingShardUnexpired = (rows: readonly Pick<TrainingRunInventory["rows"][number], "feature">[], accessAt: string,
  pinnedFeatureIds: ReadonlySet<string> = new Set()) => {
  const clock = instant(accessAt);
  // An already-expired slot remains an explicit expired state. A selection
  // that loses eligibility after inventory preparation must not be resealed as
  // usable, unavailable or freshly expired under the original inventory hash.
  for (const row of rows) if (row.feature.reference && !pinnedFeatureIds.has(row.feature.reference.id) && row.feature.state !== "expired" &&
      clock >= instant(row.feature.reference.recordedAt) + 90 * 86_400_000) refuse("training-shard-feature-expired");
};

// Pure correspondence check/formatter, not a certificate callers can submit to
// SQL. The store invokes it only after actual byte reconstruction under guard.
// Future dataset sealing must perform that verification in its own transaction.
export const trainingShardProof = (inventory: TrainingRunInventory, input: TrainingShardRequest, verifiedAt: string,
  records: SourceConsumerRecord[], kickoffs: TrainingKickoffProof[], pinnedFeatureIds: ReadonlySet<string> = new Set()) => {
  const rows = trainingShardMembership(inventory, input);
  if (instant(verifiedAt) < instant(inventory.snapshotAt)) refuse("training-shard-clock-refused");
  assertTrainingShardUnexpired(rows, verifiedAt, pinnedFeatureIds);
  const ids = new Set(rows.flatMap((row) => [row.selection.featureId, row.selection.labelId].filter((id): id is string => id !== null)));
  if (records.length !== ids.size || new Set(records.map((record) => record.id)).size !== ids.size ||
      records.some((record) => !ids.has(record.id)) || kickoffs.length !== rows.length) refuse("training-shard-evidence-mismatch");
  const selected = selectTrainingRows({ ...inventory.request, slots: rows.map((row) => row.slot) }, inventory.snapshotAt, records,
    new Set(inventory.pinEligibility?.featureIds ?? []),
    rows.map((row, ordinal) => ({ ...row.selection, ordinal })));
  rows.forEach((row, i) => {
    const checked = selected[i], proof = kickoffs[i];
    const { record: _feature, ...feature } = checked.feature; void _feature;
    const { record: _label, supersededNow, ...label } = checked.label; void _label;
    if (canonical(checked.history) !== canonical(row.history) || canonical(feature) !== canonical(row.feature) ||
        canonical({ ...label, supersededAtSnapshot: supersededNow }) !== canonical(row.label)) refuse("training-shard-evidence-mismatch");
    const dependencies = row.kickoff.dependencies.map((dep) => ({ observationId: dep.observationId, captureId: dep.captureId,
      artifactId: dep.artifactId, sha256: dep.artifactSha256, availableAt: dep.availableAt, ingestedAt: dep.ingestedAt }))
      .sort((a, b) => compareText(a.observationId, b.observationId));
    const profile = row.kickoff.dependencies.find((dep) => dep.observationId === row.kickoff.observationId)?.profileId;
    if (proof.observationId !== row.kickoff.observationId || proof.profileId !== profile ||
        canonical(proof.dependencies) !== canonical(dependencies) ||
        canonical(proof.decisions.map((decision) => decision.id)) !== canonical(row.kickoff.decisionId === null ? [] : [row.kickoff.decisionId])) {
      refuse("training-shard-kickoff-mismatch");
    }
  });
  const counts = (["training", "evaluation"] as const).map((partition) => {
    const members = rows.filter((row) => row.slot.partition === partition);
    return { partition, slots: members.length, targetEvents: new Set(members.map((row) => row.slot.gameId)).size,
      usableFeatures: members.filter((row) => row.feature.state === "usable").length,
      missingFeatures: members.filter((row) => row.feature.state === "missing").length,
      unavailableFeatures: members.filter((row) => row.feature.state === "unavailable").length,
      expiredFeatures: members.filter((row) => row.feature.state === "expired").length,
      usableLabels: members.filter((row) => row.label.state === "usable").length,
      missingLabels: members.filter((row) => row.label.state === "missing").length };
  });
  const proof = { version: "qb-training-shard-proof-v1" as const, status: "verified-only" as const, fittingReady: false as const,
    populationCoverage: "unqualified" as const, request: input, inventorySnapshotAt: inventory.snapshotAt, verifiedAt,
    selectionSha256: digest(canonical({ inventorySha256: inventory.inventorySha256, datasetId: input.datasetId, rows })),
    rows, kickoffs, counts };
  if (Buffer.byteLength(canonical(proof)) > TRAINING_BOUNDS.pageBytes) refuse("training-page-byte-bounds-refused");
  return structuredClone({ ...proof, proofSha256: digest(canonical(proof)) });
};
export type TrainingShardProof = ReturnType<typeof trainingShardProof>;
