// #127 disposable spike. This module is never imported by the application.
import { Client } from "pg";
import type { PrivateArtifactStore } from "../../../src/lib/predictive/artifacts.ts";
import { createTrainingOperation, TRAINING_TIME_BOUNDS } from "../../../src/lib/predictive/trainingOperation.ts";
import type { TrainingDatasetManifest, TrainingDatasetRequest } from "../../../src/lib/predictive/trainingDatasets.ts";
import type { SourceConsumerRecord } from "../../../src/lib/predictive/sourceConsumers.ts";
import type { FittingRunRequest } from "../../../src/lib/predictive/training.ts";
import type { TrainingRunInventory } from "../../../src/lib/predictive/trainingRuns.ts";
import { trainingDatasetPage, trainingLabelRows, normalizeTrainingHistoricalLabelRequest, TRAINING_LABEL_SELECTION_SQL,
  checkTrainingLabelMetadata, type TrainingPageRequest, type TrainingHistoricalLabelRequest,
  type TrainingLabelMetadata } from "../../../src/lib/predictive/trainingReads.ts";
import { canonical, digest, refuse } from "../../../src/lib/predictive/validation.ts";

type Blob = TrainingDatasetManifest["closure"]["blobs"][number];
type Target = { expected: object; assertTarget: (config: object) => void };
type Context = { manifest: TrainingDatasetManifest; records: SourceConsumerRecord[] };

export const createVerifiedTrainingSpike = async (client: Client, target: Target, artifacts: PrivateArtifactStore) => {
  target.assertTarget(target.expected);
  const backend = (await client.query("SELECT pg_backend_pid() AS pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()"))
    .rows[0] as { pid: number; started: string };
  let busy = false, retired = false;
  const operation = async <T>(preparing: boolean, work: (control: ReturnType<typeof createTrainingOperation>) => Promise<T>) => {
    if (retired) refuse("predictive-session-retired");
    if (busy) refuse("predictive-session-busy");
    busy = true;
    const control = createTrainingOperation({}, preparing ? TRAINING_TIME_BOUNDS.preparationMs : TRAINING_TIME_BOUNDS.readMs, async () => {
      retired = true;
      const cancellation = new Client({ ...target.expected, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2000 });
      try {
        await cancellation.connect();
        target.assertTarget(target.expected);
        await cancellation.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
          WHERE pid=$1 AND backend_start=$2::timestamptz AND datname=current_database() AND usename=session_user`, [backend.pid, backend.started]);
      } finally { try { await cancellation.end(); } finally { await client.end(); } }
    });
    try { return await control.wait(() => work(control)); }
    finally { await control.dispose(); busy = false; }
  };
  const verifyFiles = async (blobs: Blob[], control: ReturnType<typeof createTrainingOperation>) => {
    const files = new Map(blobs.map((blob) => [blob.storageRef, blob]));
    if (files.size !== blobs.length) refuse("spike-file-list-ambiguous");
    if (blobs.reduce((n, blob) => n + Number(blob.byteSize), 0) > 20_000_000) refuse("source-verification-byte-bounds-refused");
    for (const blob of files.values()) {
      if (blob.mediaType === "application/gzip") await control.wait(() => artifacts.database.readBinary(blob.storageRef, blob.sha256, Number(blob.byteSize), { signal: control.signal }));
      else await control.wait(() => artifacts.database.read(blob.storageRef, blob.sha256, Number(blob.byteSize), { signal: control.signal }));
    }
  };
  const snapshot = async <T>(control: ReturnType<typeof createTrainingOperation>, work: () => Promise<T>) => {
    await control.wait(() => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    try {
      const value = await work();
      await control.wait(() => client.query("COMMIT"));
      return value;
    } catch (error) { if (!retired) await client.query("ROLLBACK"); throw error; }
  };
  const finalDatasetCheck = async (id: string, hash: string, control: ReturnType<typeof createTrainingOperation>) => {
    const current = (await control.wait(() => client.query("SELECT public.spike127_dataset_read($1)->>'manifestSha256' AS hash", [id]))).rows[0].hash;
    if (current !== hash) refuse("training-page-manifest-mismatch");
  };
  const prepareDataset = (request: TrainingDatasetRequest) => operation(true, async (control) => {
    // A write transaction covers certificate union, dataset membership and pin.
    // Rollback on a failed file hash leaves no sealed manifest behind.
    await control.wait(() => client.query("BEGIN"));
    let manifest: TrainingDatasetManifest;
    try {
      manifest = (await control.wait(() => client.query("SELECT public.spike127_seal($1) AS result", [request]))).rows[0].result;
      await verifyFiles(manifest.closure.blobs, control);
      await finalDatasetCheck(manifest.datasetId, manifest.manifestSha256, control);
      await control.wait(() => client.query("COMMIT"));
    } catch (error) { if (!retired) await client.query("ROLLBACK"); throw error; }
    // Delivery check uses a NEW snapshot, so a concurrent committed revocation
    // cannot be hidden by the preparation transaction's earlier view.
    await finalDatasetCheck(manifest.datasetId, manifest.manifestSha256, control);
    return manifest;
  });
  const readPage = (input: TrainingPageRequest, rowLimit = input.limits.rows) => operation(false, async (control) => {
    if (![16, 64, 256].includes(rowLimit) && rowLimit !== input.limits.rows) refuse("spike-page-bounds-refused");
    const context: Context = await snapshot(control, async () =>
      (await control.wait(() => client.query("SELECT public.spike127_page_context($1) AS result", [input.datasetId]))).rows[0].result);
    const records = new Map(context.records.map((record) => [record.id, record]));
    // The 256-row experiment composes the frozen 64-row pure formatter; it
    // changes neither the public request limit nor the numerical calculations.
    const parts: ReturnType<typeof trainingDatasetPage>[] = [];
    let cursor = input.cursor;
    do {
      const part = trainingDatasetPage({ ...input, cursor, limits: { ...input.limits, rows: Math.min(64, rowLimit) } }, context.manifest, records, new Date().toISOString());
      parts.push(part); cursor = part.nextCursor;
    } while (cursor && parts.reduce((n, part) => n + part.rows.length, 0) < rowLimit);
    await verifyFiles(context.manifest.closure.blobs, control);
    await finalDatasetCheck(input.datasetId, input.manifestSha256, control);
    const result = { ...parts[0], rows: parts.flatMap((part) => part.rows), nextCursor: parts.at(-1)!.nextCursor };
    // The aggregate has its own checksum; individual constituent checksums do
    // not purport to describe a 256-row public API response.
    const { pageSha256: _old, ...body } = result; void _old;
    if (Buffer.byteLength(canonical(body)) > input.limits.bytes) refuse("training-page-byte-bounds-refused");
    control.check();
    return { ...body, pageSha256: digest(canonical(body)) };
  });
  const readLabelsAt = (supplied: TrainingHistoricalLabelRequest) => operation(false, async (control) => {
    if (supplied.keys.length < 1 || supplied.keys.length > 256) refuse("training-label-bounds-refused");
    const chunks = [];
    for (let offset = 0; offset < supplied.keys.length; offset += 64) chunks.push(normalizeTrainingHistoricalLabelRequest({ ...supplied,
      keys: supplied.keys.slice(offset, offset + 64), limits: { ...supplied.limits, rows: Math.min(64, supplied.keys.length) } }));
    const { labelsAsOf, ...request } = { ...chunks[0], keys: chunks.flatMap((chunk) => chunk.keys).sort((a, b) => a.playerId.localeCompare(b.playerId) || a.gameId.localeCompare(b.gameId)) };
    if (new Set(request.keys.map((key) => canonical([key.playerId, key.gameId]))).size !== request.keys.length) refuse("training-duplicate-target");
    const data = await snapshot(control, async () => {
      const now = (await control.wait(() => client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS clock`))).rows[0].clock as string;
      if (Date.parse(labelsAsOf) > Date.parse(now)) refuse("training-future-cutoff");
      const metadata: TrainingLabelMetadata[] = checkTrainingLabelMetadata((await control.wait(() => client.query(TRAINING_LABEL_SELECTION_SQL,
        [JSON.stringify(request.keys), labelsAsOf, now]))).rows, request.keys.length);
      const ids = [...new Set(metadata.flatMap((row) => row.id ? [row.id] : []))];
      const context = (await control.wait(() => client.query("SELECT public.spike127_label_context($1,$2,$3) AS result", [ids, request.selection.profileIds, labelsAsOf]))).rows[0].result as
        { records: SourceConsumerRecord[]; blobs: Blob[]; removed: boolean };
      return { ids, metadata, context, now };
    });
    const records = new Map(data.context.records.map((record) => [record.id, record]));
    const rows = trainingLabelRows(request, labelsAsOf, data.metadata, records, data.context.removed);
    await verifyFiles(data.context.blobs, control);
    const removed = (await control.wait(() => client.query("SELECT public.spike127_label_access($1,$2,$3) AS removed",
      [data.ids, request.selection.profileIds, labelsAsOf]))).rows[0].removed;
    if (removed !== data.context.removed) refuse("training-label-evidence-removed");
    const body = { version: "qb-training-labels-v1", selection: request.selection, labelsAsOf, snapshotAt: data.now, rows,
      counts: { requested: rows.length, usable: rows.filter((row) => row.state === "usable").length, missing: rows.filter((row) => row.state === "missing").length },
      fittingReady: false, populationCoverage: "unqualified" };
    if (Buffer.byteLength(canonical(body)) > supplied.limits.bytes) refuse("training-page-byte-bounds-refused");
    control.check();
    return { ...body, responseSha256: digest(canonical(body)) };
  });
  const prepareFittingRun = (request: FittingRunRequest) => operation(true, async (control) =>
    (await control.wait(() => client.query("SELECT public.spike127_prepare_run($1) AS result", [request]))).rows[0].result as TrainingRunInventory);
  return { prepareFittingRun, prepareDataset, readDatasetPage: readPage, readLabelsAt };
};
