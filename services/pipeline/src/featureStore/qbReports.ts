import assert from "node:assert/strict";
import type { Client } from "pg";
import { evaluateQbBaseline, serializeQbEvaluation, type QbCoverage, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { withDatasetRead, type DatasetRow, type DatasetSpec } from "./datasets.ts";
import type { CodeIdentity } from "./derived.ts";
import { sha256, type ObjectStore } from "./objectStore.ts";

export type Artifact = { objectKey: string; sha256: string; byteSize: number };
export type DatasetPin = { datasetId: string; objectKey: string; fileSha256: string;
  contentSha256: string; byteSize: number; rowCount: number };
export type CoverageRow = { player_id: string; game_id: string; season: number; sample_size: number;
  feature_state: string; label_state: string | null; feature_reasons: string[]; label_reasons: string[];
  history_gaps: { gameId: string; reasons: string[] }[]; flags: string[]; zero_attempts: boolean | null };
export type QbInputPins = {
  format: string; rightsScope: string; designation: string;
  preregistration: { commit: string; path: string; sha256: string; approved: boolean };
  code: CodeIdentity; versions: { model: string; adapter: { id: string; version: string };
    feature: string; label: string; history: string };
  populationDiagnostics: unknown[]; populationArtifact: Artifact;
  modes: { mode: QbEvidenceMode; dataset: DatasetPin; spec: DatasetSpec; coverageArtifact: Artifact }[];
};

// Validate bytes only during preparation. Publication uses metadata-only HEADs.
export const readQbArtifact = async (store: ObjectStore, artifact: Artifact) => {
  assert.equal(artifact.objectKey, `audits/${artifact.sha256}`, "audit-address-mismatch");
  const bytes = await store.get(artifact.objectKey);
  assert.equal(bytes.byteLength, artifact.byteSize, "audit-size-mismatch");
  assert.equal(sha256(bytes), artifact.sha256, "audit-digest-mismatch");
  return bytes;
};
export const readQbInputPins = async (store: ObjectStore, inputPins: Artifact): Promise<QbInputPins> => {
  const pins = JSON.parse((await readQbArtifact(store, inputPins)).toString()) as QbInputPins;
  assert.equal(pins.format, "qb-evaluation-input-pins-v1");
  assert.equal(pins.rightsScope, "research");
  return pins;
};
const coverageRow = (row: CoverageRow): QbCoverage => ({
  playerId: row.player_id, gameId: row.game_id, season: row.season, sampleSize: row.sample_size,
  featureAvailable: row.feature_state === "usable", labelAvailable: row.label_state === "usable",
  featureReasons: row.feature_reasons, labelReasons: row.label_reasons, historyGaps: row.history_gaps,
  flags: row.flags, zeroAttempts: row.zero_attempts, policyExclusions: [],
});

// The callback lets the legacy #164 wrapper stage its report before the final
// rights check. #165 returns prepared bytes only and enrolls before any upload.
export const withPinnedQbReport = async <T>(client: Pick<Client, "query">, store: ObjectStore,
  inputPins: Artifact, pins: QbInputPins, mode: QbEvidenceMode, code: CodeIdentity,
  consume: (prepared: PreparedQbReport) => T | Promise<T>) => {
  const selected = pins.modes.find(row => row.mode === mode);
  assert(selected, "pinned-evidence-mode-missing");
  return withDatasetRead(client, store, selected.dataset.datasetId, async (bytes, manifest) => {
    const actual: DatasetPin = { datasetId: manifest.dataset_id, objectKey: manifest.object_key,
      fileSha256: manifest.file_sha256, contentSha256: manifest.content_sha256,
      byteSize: manifest.byte_size, rowCount: manifest.row_count };
    const expected = Object.fromEntries(Object.keys(actual).map(key => [key, selected.dataset[key as keyof DatasetPin]]));
    assert.deepEqual(actual, expected, "pinned-dataset-manifest-mismatch");
    assert.deepEqual(manifest.spec, selected.spec, "pinned-dataset-spec-mismatch");
    assert.equal(selected.spec.mode, mode, "pinned-dataset-mode-mismatch");
    assert.equal(bytes.byteLength, actual.byteSize, "pinned-dataset-size-mismatch");
    assert.equal(sha256(bytes), actual.fileSha256, "pinned-dataset-file-mismatch");
    const dataset = JSON.parse(bytes.toString()) as { format: string; code: CodeIdentity;
      contentSha256: string; spec: DatasetSpec; rows: DatasetRow[] };
    assert.equal(dataset.format, "qb-passing-yards-dataset-v1", "pinned-dataset-format-mismatch");
    assert.deepEqual(dataset.code, pins.code, "pinned-dataset-code-mismatch");
    assert.deepEqual(dataset.code, { gitSha: manifest.code_sha, contentSha256: manifest.implementation_sha256 },
      "pinned-dataset-manifest-code-mismatch");
    assert.equal(dataset.contentSha256, actual.contentSha256, "pinned-dataset-content-mismatch");
    assert.deepEqual(dataset.spec, selected.spec);
    assert.equal(dataset.rows.length, actual.rowCount);
    const ledger = JSON.parse((await readQbArtifact(store, selected.coverageArtifact)).toString()) as {
      format: string; mode: QbEvidenceMode; rows: CoverageRow[] };
    assert.equal(ledger.format, "qb-evaluation-coverage-v1", "pinned-coverage-format-mismatch");
    assert.equal(ledger.mode, mode, "pinned-coverage-mode-mismatch");
    const calculationStarted = performance.now();
    const report = evaluateQbBaseline(dataset.rows, { mode, historyPolicy: dataset.spec.historyPolicy,
      coverage: ledger.rows.map(coverageRow) });
    const calculated = performance.now();
    const logical = serializeQbEvaluation(report);
    const logicalSha256 = sha256(Buffer.from(logical));
    const full = Buffer.from(JSON.stringify({ format: "qb-research-report-envelope-v1", rightsScope: "research",
      inputPins, code, versions: pins.versions, dataset: selected.dataset,
      coverageArtifact: selected.coverageArtifact, populationDiagnostics: pins.populationDiagnostics,
      populationArtifact: pins.populationArtifact, logicalSha256, report: JSON.parse(logical) }) + "\n");
    const fileSha256 = sha256(full);
    return consume({ bytes: full, artifact: { objectKey: `audits/${fileSha256}`, sha256: fileSha256, byteSize: full.byteLength },
      dataset: actual, spec: selected.spec, mode, logicalSha256, report,
      timingMs: { calculation: calculated - calculationStarted, serialization: performance.now() - calculated } });
  });
};
export type PreparedQbReport = {
  bytes: Buffer; artifact: Artifact; dataset: DatasetPin; spec: DatasetSpec; mode: QbEvidenceMode;
  logicalSha256: string; report: ReturnType<typeof evaluateQbBaseline>;
  timingMs: { calculation: number; serialization: number };
};
