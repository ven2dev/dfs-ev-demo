import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { withFeatureStoreDatabase } from "./harness.ts";
import { EVALUATION_ROOT, evaluationCodeIdentity, prepareEvaluationFixture } from "./evaluation-fixture.ts";
import { measureQbModelPublication } from "./model-publication-measure.ts";
import { modelPublicationCodeIdentity } from "./model-publication-identity.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

// Disposable local fixture only: harness target registration excludes hosted DBs.
// All drafts/evidence and private fixture bytes survive a workstation restart.
const directory = new URL("node_modules/.cache/feature-store-165/", EVALUATION_ROOT);
await mkdir(directory, { recursive: true });
const root = await realpath(await mkdtemp(new URL("165-real-publication-", directory).pathname));
const store = await openLocalObjectStore(root);
const inputSource = await evaluationCodeIdentity(), source = await modelPublicationCodeIdentity();
const receipt: Record<string, unknown> = { issue: 165, step: 2, recordedAt: new Date().toISOString(),
  runtime: process.version, storageRoot: root, ...source, inputGeneration: inputSource,
  fixture: "16 retained exact #138 wire files, fresh real clocks, 2504 retrospective and zero strict PIT examples",
  limitation: "behavior and deterministic work proof only; elapsed times are informational; final relative ABBA speed gate remains step 4",
  verdict: "running" };
try {
  await withFeatureStoreDatabase(async context => {
    await context.admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/165_model_manifests.sql")), "utf8"));
    const fixture = await prepareEvaluationFixture(context, store, inputSource.code, event => console.log(JSON.stringify(event)));
    const measured = await measureQbModelPublication(context.writer, store, fixture.inputPinsArtifact, { code: source.code });
    assert.deepEqual(measured.work, { preparationStatements: 6, publicationStatements: 5, transactionStatements: 4,
      preflightHeads: 3, transactionHeads: 3, objectReads: 6, transactionObjectReads: 0,
      uploads: 3, transactionUploads: 0, hashes: 14, transactionHashes: 0, objectDeletes: 0 });
    const descriptor = JSON.parse((await store.get(measured.result.descriptor.objectKey)).toString());
    assert.deepEqual(descriptor.identity, measured.result.identity);
    const envelopes = [];
    for (const pin of measured.result.reports) {
      const bytes = await store.get(pin.objectKey), envelope = JSON.parse(bytes.toString());
      const selected = fixture.prepared.find(p => p.mode === pin.slot)!;
      assert.equal(sha256(bytes), pin.fileSha256); assert.equal(bytes.byteLength, pin.byteSize);
      assert.deepEqual(envelope.dataset, selected.dataset);
      assert.deepEqual(envelope.code, source.code);
      assert.equal(envelope.report.evidenceMode, pin.slot);
      assert.equal(envelope.report.folds.length, selected.dataset.rowCount);
      assert.equal(envelope.logicalSha256, sha256(Buffer.from(JSON.stringify(envelope.report))), "logical-report-digest-mismatch");
      assert.deepEqual(descriptor.reports.find((r: { mode: string }) => r.mode === pin.slot), {
        mode: pin.slot, datasetId: pin.datasetId, objectKey: pin.objectKey, sha256: pin.fileSha256,
        byteSize: pin.byteSize, logicalSha256: envelope.logicalSha256 });
      envelopes.push({ mode: pin.slot, ...pin, logicalSha256: envelope.logicalSha256,
        examples: envelope.report.folds.length, historicalAvailability: envelope.report.historicalAvailability,
        flags: envelope.report.flags });
    }
    const sqlPins = (await context.writer.query(`SELECT dataset_id,evidence_mode,file_sha256,content_sha256,row_count
      FROM fs138.model_run_datasets WHERE run_id=$1 ORDER BY evidence_mode`, [measured.result.runId])).rows;
    for (const p of sqlPins) {
      const actual = fixture.prepared.find(r => r.mode === p.evidence_mode)!;
      assert.equal(p.dataset_id, actual.dataset.datasetId); assert.equal(p.file_sha256, actual.dataset.fileSha256);
      assert.equal(p.content_sha256, actual.dataset.contentSha256); assert.equal(p.row_count, actual.dataset.rowCount);
    }
    receipt.database = (await context.admin.query("SELECT version() AS version")).rows[0].version;
    receipt.inputPinsArtifact = fixture.inputPinsArtifact;
    receipt.publication = measured.result; receipt.work = measured.work; receipt.events = measured.events;
    receipt.envelopes = envelopes; receipt.sqlPins = sqlPins;
    receipt.verdict = "pass";
  });
} catch (error) { receipt.verdict = "fail"; receipt.error = String(error); process.exitCode = 1; }
finally {
  assert.deepEqual(await evaluationCodeIdentity(), inputSource, "input-source-changed-during-measurement");
  const after = await modelPublicationCodeIdentity();
  assert.deepEqual(after, source, "source-changed-during-measurement");
  await writeFile(process.env.FS165_REAL_EVIDENCE ?? new URL("165-real-publication.json", directory),
    JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify({ verdict: receipt.verdict, storageRoot: root }));
