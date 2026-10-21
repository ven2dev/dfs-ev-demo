import assert from "node:assert/strict";
import type { Client } from "pg";
import { evaluateQbBaseline, serializeQbEvaluation, type QbCoverage, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { withDatasetRead } from "../../src/featureStore/datasets.ts";
import { objectKey, sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import type { CoverageRow, PinnedDataset, prepareEvaluationFixture } from "./evaluation-fixture.ts";

type Pins = Awaited<ReturnType<typeof prepareEvaluationFixture>>["pins"];
export type Artifact = { objectKey: string; sha256: string; byteSize: number };
const coverageRow = (row: CoverageRow): QbCoverage => ({
  playerId: row.player_id, gameId: row.game_id, season: row.season, sampleSize: row.sample_size,
  featureAvailable: row.feature_state === "usable", labelAvailable: row.label_state === "usable",
  featureReasons: row.feature_reasons, labelReasons: row.label_reasons, historyGaps: row.history_gaps,
  flags: row.flags, zeroAttempts: row.zero_attempts, policyExclusions: [],
});

// The immutable pin artifact binds both the scored cohort and its unavailable
// coverage. This is a trusted local research job, never a public report reader.
// Private staging finishes before the final SQL check; only then is its address
// returned. Later delivery of an archived report needs fresh dataset rights.
export const completeQbReport = async (client: Pick<Client, "query">, store: ObjectStore,
  inputPins: Artifact, mode: QbEvidenceMode) => {
  const started = performance.now();
  const pinsBytes = await store.get(inputPins.objectKey);
  assert.equal(sha256(pinsBytes), inputPins.sha256, "input-pin-artifact-mismatch");
  const pins = JSON.parse(pinsBytes.toString()) as Pins;
  assert.equal(pins.format, "qb-evaluation-input-pins-v1");
  assert.equal(pins.rightsScope, "research");
  const selected = pins.modes.find(row => row.mode === mode);
  assert(selected, "pinned-evidence-mode-missing");
  let staged: { artifact: Artifact; created: boolean } | undefined;
  try {
    const guarded = await withDatasetRead(client, store, selected.dataset.datasetId, async bytes => {
      assert.equal(sha256(bytes), selected.dataset.fileSha256, "pinned-dataset-file-mismatch");
      const dataset = JSON.parse(bytes.toString()) as PinnedDataset;
      assert.equal(dataset.contentSha256, selected.dataset.contentSha256);
      assert.deepEqual(dataset.spec, selected.spec);
      assert.equal(dataset.rows.length, selected.dataset.rowCount);
      const coverageBytes = await store.get(selected.coverageArtifact.objectKey);
      assert.equal(sha256(coverageBytes), selected.coverageArtifact.sha256, "pinned-coverage-mismatch");
      const ledger = JSON.parse(coverageBytes.toString()) as { mode: QbEvidenceMode; rows: CoverageRow[] };
      assert.equal(ledger.mode, mode);
      const calculationStarted = performance.now();
      const report = evaluateQbBaseline(dataset.rows, { mode, historyPolicy: dataset.spec.historyPolicy,
        coverage: ledger.rows.map(coverageRow) });
      const calculated = performance.now();
      const logical = serializeQbEvaluation(report);
      const logicalSha256 = sha256(Buffer.from(logical));
      const full = Buffer.from(JSON.stringify({ format: "qb-research-report-envelope-v1", rightsScope: "research",
        inputPins, code: pins.code, versions: pins.versions, dataset: selected.dataset,
        coverageArtifact: selected.coverageArtifact, populationDiagnostics: pins.populationDiagnostics,
        populationArtifact: pins.populationArtifact, logicalSha256, report: JSON.parse(logical) }) + "\n");
      const serialized = performance.now();
      const key = objectKey("audits", full);
      const uploaded = await store.putIfAbsent(key, full);
      const artifact = { objectKey: key, sha256: sha256(full), byteSize: full.byteLength };
      staged = { artifact, created: uploaded.created };
      return { artifact, logicalSha256, report,
        timingMs: { calculation: calculated - calculationStarted, serialization: serialized - calculated,
          objectWrite: performance.now() - serialized } };
    });
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 10_000) throw new Error("completed-report-deadline-exceeded");
    return { ...guarded.value, rightsScope: "research" as const,
      authorization: guarded.authorization, delivery: guarded.delivery, elapsedMs };
  } catch (error) {
    // Withhold failed new staging artifacts. An existing successful report is
    // retained, bound to its original dataset, rather than deleted by a retry.
    if (staged?.created) await store.delete(staged.artifact.objectKey);
    throw error;
  }
};

// Keep the case/calibration detail in ObjectStore. These summaries retain all
// season/sample groups, exclusions and score denominators in compact receipts.
export const summarizeQbReport = (report: ReturnType<typeof evaluateQbBaseline>) => ({
  evidenceMode: report.evidenceMode, designation: report.designation, historicalAvailability: report.historicalAvailability,
  folds: report.folds.length, cases: report.cases.length, warmup: report.warmup, walkForward: report.walkForward,
  marketComparison: report.marketComparison,
  groups: report.groups.map(g => ({ season: g.season, stratum: g.sampleStratum, coverage: g.coverage,
    players: g.distinctScoredPlayers, games: g.distinctScoredGames, rps: g.rps,
    combined: g.combinedThresholdScores,
    thresholds: g.thresholds.map(t => ({ threshold: t.threshold, count: t.count, brierThreeClass: t.brierThreeClass,
      brierBinaryOver: t.brierBinaryOver, logLoss: t.logLoss, infiniteLogLoss: t.infiniteLogLoss,
      extremes: t.extremeProbabilities })) })),
});
