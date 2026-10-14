import { normalizeTrainingShardRequest, type TrainingShardRequest } from "./trainingShards.ts";
import type { TrainingDatasetManifest } from "./trainingDatasets.ts";
import type { SourceConsumerRecord, SourceFinalLabelBody } from "./sourceConsumers.ts";
import { TRAINING_BOUNDS, type TrainingSelection } from "./training.ts";
import { canonical, compareText, digest, exact, gameIdentity, instant, playerIdentity, refuse } from "./validation.ts";

export type TrainingReadLimits = { rows: number; bytes: number };
export const normalizeTrainingReadLimits = (input: TrainingReadLimits) => {
  exact(input, ["rows", "bytes"]);
  if (!Number.isInteger(input.rows) || input.rows < 1 || input.rows > TRAINING_BOUNDS.pageRows ||
      !Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > TRAINING_BOUNDS.pageBytes) refuse("training-page-bounds-refused");
  return { ...input };
};
export const assertTrainingResponseBytes = (result: unknown, limit: number) => {
  if (Buffer.byteLength(canonical(result)) > limit) refuse("training-page-byte-bounds-refused");
};
export type TrainingPageRequest = TrainingShardRequest & {
  manifestSha256: string; cursor: string | null; limits: TrainingReadLimits;
};
type CursorBody = { version: "qb-dataset-cursor-v1"; datasetId: string; manifestSha256: string;
  afterOrdinal: number; limits: TrainingReadLimits };
export const normalizeTrainingPageRequest = (input: TrainingPageRequest) => {
  exact(input, ["version", "fittingRunId", "inventorySha256", "datasetId", "manifestSha256", "cursor", "limits"]);
  const { manifestSha256, cursor, limits, ...shard } = input;
  if (typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)) refuse("training-digest-refused");
  if (cursor !== null && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor))) refuse("training-page-cursor-refused");
  return { ...normalizeTrainingShardRequest(shard), manifestSha256, cursor, limits: normalizeTrainingReadLimits(limits) };
};
const encodeCursor = (body: CursorBody) => Buffer.from(canonical({ body, sha256: digest(canonical(body)) })).toString("base64url");
const cursorOrdinal = (request: TrainingPageRequest, manifest: TrainingDatasetManifest) => {
  if (request.cursor === null) return -1;
  let envelope: { body: CursorBody; sha256: string };
  try { envelope = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); }
  catch { return refuse("training-page-cursor-refused"); }
  exact(envelope, ["body", "sha256"]);
  exact(envelope.body, ["version", "datasetId", "manifestSha256", "afterOrdinal", "limits"]);
  const body = envelope.body;
  if (body.version !== "qb-dataset-cursor-v1" || body.datasetId !== request.datasetId ||
      body.manifestSha256 !== request.manifestSha256 || canonical(body.limits) !== canonical(request.limits) ||
      !Number.isInteger(body.afterOrdinal) || !manifest.rows.some((row) => row.ordinal === body.afterOrdinal) ||
      !manifest.rows.some((row) => row.ordinal > body.afterOrdinal) || envelope.sha256 !== digest(canonical(body)) ||
      encodeCursor(body) !== request.cursor) refuse("training-page-cursor-refused");
  return body.afterOrdinal;
};
// A cursor is a membership address with a corruption checksum, not a capability
// or a caller-supplied verification certificate. Every access verifies SQL and
// private evidence afresh. Valid addresses may seek within the same manifest.
export const trainingPageMembers = (input: TrainingPageRequest, manifest: TrainingDatasetManifest) => {
  const request = normalizeTrainingPageRequest(input);
  if (manifest.datasetId !== request.datasetId || manifest.fittingRunId !== request.fittingRunId ||
      manifest.inventorySha256 !== request.inventorySha256 || manifest.manifestSha256 !== request.manifestSha256) refuse("training-page-manifest-mismatch");
  const after = cursorOrdinal(request, manifest);
  const remaining = manifest.rows.filter((row) => row.ordinal > after);
  const rows = remaining.slice(0, request.limits.rows);
  const nextCursor = remaining.length > rows.length ? encodeCursor({ version: "qb-dataset-cursor-v1", datasetId: request.datasetId,
    manifestSha256: request.manifestSha256, afterOrdinal: rows.at(-1)!.ordinal, limits: request.limits }) : null;
  return { request, rows, nextCursor };
};
export const trainingDatasetPage = (input: TrainingPageRequest, manifest: TrainingDatasetManifest,
  records: ReadonlyMap<string, SourceConsumerRecord | null>, accessAt: string) => {
  const members = trainingPageMembers(input, manifest);
  const rows = members.rows.map((row) => {
    const feature = row.selection.featureId ? records.get(row.selection.featureId) : null;
    const label = row.selection.labelId ? records.get(row.selection.labelId) : null;
    if (row.feature.state === "usable" && (!feature || feature.body.kind !== "feature" || feature.bodySha256 !== row.feature.reference?.bodySha256) ||
        row.label.state === "usable" && (!label || label.body.kind !== "label" || label.bodySha256 !== row.label.reference?.bodySha256)) refuse("training-page-evidence-mismatch");
    return { ...row,
      feature: { ...row.feature, bundle: row.feature.state === "usable" && feature?.body.kind === "feature" ? feature.body.bundle : null,
        manifest: row.feature.state === "usable" && feature?.body.kind === "feature" ? feature.body.manifest : null },
      label: { ...row.label, outcome: row.label.state === "usable" && label?.body.kind === "label" ? label.body : null,
        participation: row.label.state === "usable" ? "market-compatible-observed" as const : "not-established" as const,
        finalization: row.label.state === "usable" ? "qualified-final" as const : "not-recorded" as const,
        settlement: "not-assessed" as const } };
  });
  const body = { version: "qb-training-page-v1" as const, datasetId: manifest.datasetId, manifestSha256: manifest.manifestSha256,
    inventorySha256: manifest.inventorySha256, inventorySnapshotAt: manifest.inventorySnapshotAt, rows, nextCursor: members.nextCursor,
    datasetCounts: manifest.counts, fittingReady: false as const, populationCoverage: "unqualified" as const };
  return structuredClone({ ...body, pageSha256: digest(canonical(body)), accessAt });
};

export type TrainingLabelKey = { playerId: string; gameId: string; seasonType: "REG" | "POST"; labelRef: string | null };
export type TrainingLabelRequest = {
  version: "qb-training-read-v1";
  selection: Pick<TrainingSelection, "market" | "stat" | "labelVersion" | "profileIds">;
  keys: TrainingLabelKey[]; limits: TrainingReadLimits;
};
export type TrainingHistoricalLabelRequest = TrainingLabelRequest & { labelsAsOf: string };
export const normalizeTrainingLabelRequest = (input: TrainingLabelRequest) => {
  exact(input, ["version", "selection", "keys", "limits"]);
  exact(input.selection, ["market", "stat", "labelVersion", "profileIds"]);
  if (input.version !== "qb-training-read-v1" || input.selection.market !== "player_pass_yds" ||
      input.selection.stat !== "passing_yards" || input.selection.labelVersion !== "source-final-label-v1") refuse("training-version-refused");
  const profiles = input.selection.profileIds;
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > TRAINING_BOUNDS.profiles || new Set(profiles).size !== profiles.length ||
      profiles.some((id) => typeof id !== "string" || !/^[\x21-\x7e]{1,256}$/.test(id) || id.includes("|"))) refuse("training-profile-bounds-refused");
  const limits = normalizeTrainingReadLimits(input.limits);
  if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > limits.rows) refuse("training-label-bounds-refused");
  const targets = new Set<string>();
  for (const key of input.keys) {
    exact(key, ["playerId", "gameId", "seasonType", "labelRef"]); playerIdentity(key.playerId); gameIdentity(key.gameId);
    if (!["REG", "POST"].includes(key.seasonType) || key.labelRef !== null &&
        (typeof key.labelRef !== "string" || !key.labelRef.trim() || key.labelRef.length > 256 || /[\u0000-\u001f\u007f|]/.test(key.labelRef))) refuse("training-label-key-refused");
    const target = canonical([key.playerId, key.gameId]);
    if (targets.has(target)) refuse("training-duplicate-target"); targets.add(target);
  }
  return { ...structuredClone(input), limits, selection: { ...input.selection, profileIds: [...profiles].sort(compareText) },
    keys: structuredClone(input.keys).sort((a,b) => compareText(a.playerId,b.playerId) || compareText(a.gameId,b.gameId)) };
};
export const normalizeTrainingHistoricalLabelRequest = (input: TrainingHistoricalLabelRequest) => {
  exact(input, ["version", "selection", "keys", "limits", "labelsAsOf"]);
  const { labelsAsOf, ...request } = input; instant(labelsAsOf);
  return { ...normalizeTrainingLabelRequest(request), labelsAsOf };
};
export type TrainingLabelMetadata = { ordinal: number; id: string | null; supersededAsOf: boolean; supersededAtSnapshot: boolean };
export const checkTrainingLabelMetadata = (metadata: TrainingLabelMetadata[], count: number) => {
  if (metadata.length !== count || metadata.some((row,i) => row.ordinal !== i ||
      row.id !== null && (typeof row.id !== "string" || !row.id) ||
      typeof row.supersededAsOf !== "boolean" || typeof row.supersededAtSnapshot !== "boolean")) refuse("training-label-lineage-ambiguous");
  return metadata;
};
// Determine global lineage heads before profile filtering: a changed-profile
// successor must never resurrect an older value. Exact refs are validated later.
export const TRAINING_LABEL_SELECTION_SQL = `WITH requested AS (
  SELECT (ordinality-1)::integer AS ordinal,value AS key FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY)
SELECT r.ordinal,c.id,
  EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=c.id AND n.recorded_at<=$2::timestamptz) AS "supersededAsOf",
  EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=c.id AND n.recorded_at<=$3::timestamptz) AS "supersededAtSnapshot"
FROM requested r LEFT JOIN LATERAL (
  SELECT x.id FROM public.predictive_source_consumers x WHERE r.key->>'labelRef' IS NOT NULL AND x.id=r.key->>'labelRef'
  UNION ALL
  (SELECT x.id FROM public.predictive_source_consumers x WHERE r.key->>'labelRef' IS NULL AND x.kind='label'
    AND x.player_id=r.key->>'playerId' AND x.game_id=(r.key->>'gameId')::uuid AND x.recorded_at<=$2::timestamptz
    AND NOT EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=x.id AND n.recorded_at<=$2::timestamptz)
    ORDER BY x.recorded_at DESC,x.id COLLATE "C" DESC LIMIT 2)
) c ON true ORDER BY r.ordinal`;
export const trainingLabelRows = (request: TrainingLabelRequest, labelsAsOf: string, metadata: TrainingLabelMetadata[],
  records: ReadonlyMap<string, SourceConsumerRecord | null>, retainedEvidenceRemoved: boolean) => {
  checkTrainingLabelMetadata(metadata, request.keys.length);
  return request.keys.map((key,ordinal) => {
    const selected = metadata[ordinal], record = selected.id ? records.get(selected.id) : null;
    if (selected.id && !record) refuse("training-label-evidence-removed");
    if (record && (record.kind !== "label" || record.body.kind !== "label" || record.body.playerId !== key.playerId ||
        record.body.gameId !== key.gameId || instant(record.recordedAt) > instant(labelsAsOf) || instant(record.body.manifest.cutoff) > instant(labelsAsOf))) {
      refuse("training-label-reference-mismatch");
    }
    const compatible = record?.body.kind === "label" && record.body.version === request.selection.labelVersion &&
      record.body.stat === request.selection.stat && record.body.seasonType === key.seasonType &&
      canonical(record.body.manifest.profileIds) === canonical(request.selection.profileIds);
    if (record && !compatible && key.labelRef !== null) refuse("training-label-reference-mismatch");
    const reason = compatible ? null : record ? "label-profile-or-version-mismatch" : key.labelRef !== null ? "label-reference-missing-or-removed" :
      retainedEvidenceRemoved ? "retained-evidence-removed" : "label-not-recorded";
    return { ordinal, key, state: compatible ? "usable" as const : "missing" as const, reason,
      reference: compatible && record ? { id: record.id, predecessorId: record.predecessorId, recordedAt: record.recordedAt,
        bodySha256: record.bodySha256, executionDigest: record.executionDigest, inputDigest: record.body.inputDigest } : null,
      outcome: compatible ? record!.body as SourceFinalLabelBody : null,
      supersededAsOf: compatible ? selected.supersededAsOf : false, supersededAtSnapshot: compatible ? selected.supersededAtSnapshot : false,
      participation: compatible ? "market-compatible-observed" as const : "not-established" as const,
      finalization: compatible ? "qualified-final" as const : "not-recorded" as const, settlement: "not-assessed" as const };
  });
};
