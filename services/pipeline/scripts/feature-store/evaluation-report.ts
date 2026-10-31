import type { Client } from "pg";
import type { evaluateQbBaseline, QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { readQbInputPins, withPinnedQbReport, type Artifact } from "../../src/featureStore/qbReports.ts";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";

export type { Artifact } from "../../src/featureStore/qbReports.ts";

// Preserve #164's existing private staging/final-rights behavior. #165 calls the
// same preparation/scorer without this wrapper, enrolling before its first PUT.
export const completeQbReport = async (client: Pick<Client, "query">, store: ObjectStore,
  inputPins: Artifact, mode: QbEvidenceMode) => {
  const started = performance.now();
  const pins = await readQbInputPins(store, inputPins);
  let staged: { artifact: Artifact; created: boolean } | undefined;
  try {
    const guarded = await withPinnedQbReport(client, store, inputPins, pins, mode, pins.code, async prepared => {
      const startedWrite = performance.now();
      const uploaded = await store.putIfAbsent(prepared.artifact.objectKey, prepared.bytes);
      staged = { artifact: prepared.artifact, created: uploaded.created };
      return { artifact: prepared.artifact, logicalSha256: prepared.logicalSha256, report: prepared.report,
        timingMs: { ...prepared.timingMs, objectWrite: performance.now() - startedWrite } };
    });
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 10_000) throw new Error("completed-report-deadline-exceeded");
    return { ...guarded.value, rightsScope: "research" as const,
      authorization: guarded.authorization, delivery: guarded.delivery, elapsedMs };
  } catch (error) {
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
