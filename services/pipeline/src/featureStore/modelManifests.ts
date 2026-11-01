import assert from "node:assert/strict";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY, type CodeIdentity } from "./derived.ts";
import { EMPIRICAL_ADAPTER } from "./empiricalAdapter.ts";
import { connectionInterrupted } from "./connections.ts";
import { sha256, type ObjectInfo, type ObjectStore } from "./objectStore.ts";
import { readQbArtifact, readQbInputPins, withPinnedQbReport, type Artifact, type PreparedQbReport } from "./qbReports.ts";

export const MODEL_PREREGISTRATION = {
  commit: "6aa7953dfd0df0c9bf879c2be64e94eaa2c55a3f", path: "docs/feature-store-spike-preregistration.md",
  sha256: "dc6bf2e044bcbdd6de4b1d6f91db9c623f630ad1eaf7bf1b8abdfe1f3c05c97d",
} as const;
const versions = { model: MODEL_VERSION, adapter: EMPIRICAL_ADAPTER,
  feature: FEATURE_VERSION, label: LABEL_VERSION, history: HISTORY_POLICY };
const supportedModes: QbEvidenceMode[] = ["strict-point-in-time-v1", "retrospective-reconstruction-v1"];
type ObjectPin = { slot: "descriptor" | QbEvidenceMode; datasetId: string | null;
  objectKey: string; fileSha256: string; byteSize: number };
const checkObject = (object: ObjectInfo | null, pin: ObjectPin) => {
  assert(object && object.key === pin.objectKey && object.sha256 === pin.fileSha256 && object.byteSize === pin.byteSize,
    "model-object-missing-or-mismatched");
};
const checkCode = (code: CodeIdentity) => {
  assert(code && /^[a-f0-9]{40}$/.test(code.gitSha) && /^[a-f0-9]{64}$/.test(code.contentSha256),
    "model-code-identity-refused");
  assert.deepEqual(Object.keys(code).sort(), ["contentSha256", "gitSha"], "model-code-identity-refused");
};

// Trusted pipeline only. Preparation/scoring reads precede the normal five-statement
// publication boundary. No archived-report delivery or serving authorization.
// The caller supplies a dedicated idle connection and an actual source-byte
// identity (the local runner captures it); sharing a transaction would make
// enrollment rollback with publication and lose crash cleanup ownership.
export const publishQbModelRun = async (client: Pick<Client, "query">, store: ObjectStore,
  inputPins: Artifact, options: { code: CodeIdentity; modes?: readonly QbEvidenceMode[] }) => {
  const started = performance.now();
  // Own mutable caller inputs before the first await.
  const code = { ...options.code }, input = { ...inputPins };
  const modes = [...(options.modes ?? supportedModes)].sort();
  checkCode(code);
  assert(modes.length >= 1 && modes.length <= 2 && new Set(modes).size === modes.length
    && modes.every(mode => supportedModes.includes(mode)), "model-evidence-modes-refused");
  const pins = await readQbInputPins(store, input);
  checkCode(pins.code);
  assert.equal(pins.designation, "uncalibrated-interim-hit-rate");
  assert.deepEqual(pins.versions, versions, "model-input-versions-mismatch");
  assert.deepEqual(pins.preregistration, { ...MODEL_PREREGISTRATION, approved: true }, "model-preregistration-mismatch");
  assert(Array.isArray(pins.modes) && new Set(pins.modes.map(p => p.mode)).size === pins.modes.length,
    "model-duplicate-input-mode");
  const population = JSON.parse((await readQbArtifact(store, pins.populationArtifact)).toString());
  assert.equal(population.format, "qb-evaluation-observed-stats-v1", "model-population-format-mismatch");
  assert(Array.isArray(population.rows) && Array.isArray(pins.populationDiagnostics), "model-population-missing");
  const reports: PreparedQbReport[] = [];
  for (const mode of modes) {
    const prepared = await withPinnedQbReport(client, store, input, pins, mode, code, report => report);
    assert.equal(prepared.value.spec.featureVersion, FEATURE_VERSION);
    assert.equal(prepared.value.spec.labelVersion, LABEL_VERSION);
    assert.equal(prepared.value.spec.historyPolicy, HISTORY_POLICY);
    reports.push(prepared.value);
  }
  const identity = { format: "qb-model-run-v1", designation: "uncalibrated-interim-hit-rate",
    modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
    historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION, adapter: EMPIRICAL_ADAPTER,
    preregistration: MODEL_PREREGISTRATION, code };
  const descriptorBytes = Buffer.from(JSON.stringify({ format: "qb-model-descriptor-v1", rightsScope: "research",
    identity, inputPins: input, inputCode: pins.code,
    datasets: reports.map(r => ({ mode: r.mode, ...r.dataset, spec: r.spec })),
    reports: reports.map(r => ({ mode: r.mode, datasetId: r.dataset.datasetId,
      ...r.artifact, logicalSha256: r.logicalSha256 })) }) + "\n");
  const descriptorSha256 = sha256(descriptorBytes);
  const descriptor: ObjectPin = { slot: "descriptor", datasetId: null, objectKey: `models/${descriptorSha256}`,
    fileSha256: descriptorSha256, byteSize: descriptorBytes.byteLength };
  const objects: ObjectPin[] = [descriptor, ...reports.map(r => ({ slot: r.mode, datasetId: r.dataset.datasetId,
    objectKey: r.artifact.objectKey, fileSha256: r.artifact.sha256, byteSize: r.artifact.byteSize }))];
  const uploads = [descriptorBytes, ...reports.map(r => r.bytes)];
  const ids = reports.map(r => r.dataset.datasetId).sort(), addresses = objects.map(o => o.objectKey).sort();
  const guardParameters = [ids, addresses], publishParameters = [JSON.stringify(identity), JSON.stringify(objects)];
  const absent: string[] = [];
  for (const object of objects) {
    const current = await store.head(object.objectKey);
    if (current) checkObject(current, object);
    else absent.push(object.objectKey);
  }
  // Autocommit before all PUTs, including the empty reuse case. Objects that
  // remain present are not enrolled, preventing cleanup from claiming old evidence.
  await client.query("SELECT fs138.enroll_model_objects($1::text[])", [absent]);
  for (const [i, object] of objects.entries()) {
    const uploaded = await store.putIfAbsent(object.objectKey, uploads[i]);
    checkObject(uploaded.object, object);
    // #164 cleanup may delete preflight-present bytes before this PUT. Enroll
    // our re-created object before BEGIN so a rollback preserves crash cleanup.
    if (uploaded.created && !absent.includes(object.objectKey)) {
      await client.query("SELECT fs138.enroll_model_objects($1::text[])", [[object.objectKey]]);
    }
  }
  let inTransaction = false;
  const publicationStarted = performance.now();
  let run: { run_id: string; descriptor_sha256: string; identity: typeof identity; recorded_at: Date;
    rights_receipt: unknown; existing_publication: boolean };
  try {
    // Set first: if BEGIN's response is lost, the connection is discarded.
    inTransaction = true;
    await client.query("BEGIN");
    await client.query("SELECT fs138.guard_model_publication($1::uuid[],$2::text[])", guardParameters);
    for (const object of objects) checkObject(await store.head(object.objectKey), object);
    run = (await client.query<typeof run>("SELECT * FROM fs138.publish_model_run($1::jsonb,$2::jsonb)", publishParameters)).rows[0];
    assert(run, "model-publication-missing");
    assert.equal(run.descriptor_sha256, descriptor.fileSha256, "model-publication-descriptor-mismatch");
    await client.query("COMMIT");
    inTransaction = false;
  } catch (error) {
    // A lost COMMIT response has an unknown outcome. Withhold the result and
    // discard this connection; never delete bytes that may now be referenced.
    if (connectionInterrupted(error)) throw new Error("model-connection-interrupted-replace", { cause: error });
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new Error("model-connection-interrupted-replace", { cause: rollbackError }); }
    }
    // Enrollment is durable and remains available to the scoped orphan sweep.
    throw error;
  }
  return { runId: run.run_id, identity: run.identity, recordedAt: run.recorded_at, rightsReceipt: run.rights_receipt,
    existingPublication: run.existing_publication,
    descriptor, reports: objects.slice(1), rightsScope: "research" as const,
    timingMs: { publication: performance.now() - publicationStarted, endToEnd: performance.now() - started } };
};
