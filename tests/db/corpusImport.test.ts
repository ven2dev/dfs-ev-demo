import { expect, it } from "vitest";
import type { Client } from "pg";
import { buildCaptureEvent } from "../../src/lib/creatorCaptures.ts";
import type { DecisionEvent } from "../../src/lib/creatorDecisions.ts";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureCorpusImporterRole } from "../../scripts/creator-corpus/dbHarness.ts";
import { publishCorpusImport } from "../../scripts/creator-corpus/importPublisher.ts";
import type { CorpusDatabaseConfig } from "../../scripts/creator-corpus/importTarget.ts";
import type { CorpusImportSource } from "../../scripts/creator-corpus/importPlanner.ts";
import { buildReadinessGate } from "../../scripts/creator-corpus/readinessGate.ts";
import { generateCorpusReadinessReport, PICK_METRICS_PENDING } from "../../scripts/creator-corpus/readinessReport.ts";
import { NOW, discoveryFor, record, vid } from "../../scripts/creator-corpus/testSupport.ts";
import { createScratchHarness } from "./scratch.mjs";

const decision = (n: number): DecisionEvent => ({
  videoId: vid(n),
  decision: "include",
  reason: "Synthetic owner decision",
  ruleVersion: "v1",
  decidedAt: "2026-10-07T11:00:00.000Z",
});

const source = (version = 1): CorpusImportSource => {
  const discovery = discoveryFor([record(1), record(2)]);
  const captures = [buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "capture",
    text: "synthetic transcript ".repeat(20), publishedDate: "2025-10-09", captionKind: "uploaded" }, NOW)];
  if (version > 1) captures.push(buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "replace",
    text: "corrected synthetic transcript ".repeat(20), publishedDate: "2025-10-09", captionKind: "uploaded",
    reason: "Synthetic correction" }, NOW));
  return {
    captures,
    decisions: { "creator-a": version > 2 ? [decision(1), decision(2)] : [decision(1)] },
    discovery,
    registration: discovery.registration,
    gate: buildReadinessGate({ keys: discovery.creators.map((creator) => creator.key), saltHex: "f".repeat(64),
      registeredAt: "2026-10-06T01:00:00.000Z", endSeason: 2026, endWeek: 4, ruleVersion: "v1" }),
    fingerprints: {
      registration: "a".repeat(64), gate: "b".repeat(64), captures: String(version).repeat(64),
      decisions: (version > 2 ? "4" : "d").repeat(64), discovery: "e".repeat(64),
    },
    now: NOW,
  };
};

const withImporterDatabase = async (run: (owner: Client, config: CorpusDatabaseConfig) => Promise<void>) => {
  const harness = await createScratchHarness(process.env);
  try {
    const files = await checkMigrationArtifacts();
    const contracts = await loadCatalogContracts(files);
    await harness.withDatabase(async (owner: Client, expected: Record<string, unknown>) => {
      await ensureCorpusImporterRole(owner);
      await runScratchMigrations(owner, { expected, files, assertTarget: harness.assertTarget,
        verify: createCatalogVerifier(contracts) });
      await owner.query("ALTER ROLE corpus_importer LOGIN PASSWORD 'corpus-test-only'");
      try {
        await run(owner, { ...expected, user: "corpus_importer", password: "corpus-test-only",
          application_name: "corpus-import-test" } as CorpusDatabaseConfig);
      } finally {
        await owner.query("ALTER ROLE corpus_importer NOLOGIN");
      }
    });
  } finally {
    await harness.close();
  }
};

it("corpus importer publishes one atomic snapshot, appends only owner tails and reruns as a no-op", async () => {
  await withImporterDatabase(async (owner, config) => {
    expect(await publishCorpusImport({ config, loadSource: async () => source(1) })).toMatchObject({
      outcome: "append", capturesAppended: 1, decisionsAppended: 1, apiSnapshotsReplaced: 2,
    });
    expect(await publishCorpusImport({ config, loadSource: async () => source(1) })).toMatchObject({ outcome: "no-op", importId: "1" });
    expect(await publishCorpusImport({ config, loadSource: async () => source(2) })).toMatchObject({
      outcome: "append", capturesAppended: 1, decisionsAppended: 0, apiSnapshotsReplaced: 0,
    });
    const counts = (await owner.query(`SELECT
      (SELECT count(*)::integer FROM corpus_imports) AS imports,
      (SELECT count(*)::integer FROM corpus_capture_events) AS captures,
      (SELECT count(*)::integer FROM corpus_decision_events) AS decisions,
      (SELECT count(*)::integer FROM corpus_api_videos) AS videos`)).rows[0];
    expect(counts).toEqual({ imports: 2, captures: 2, decisions: 1, videos: 3 });
  });
});

it("corpus importer verifies the connected local role before loading any private source", async () => {
  await withImporterDatabase(async (_owner, config) => {
    let loaded = false;
    const wrong = { ...config, user: "dfs_ev_test", password: "dfs_ev_test" } as CorpusDatabaseConfig;
    await expect(publishCorpusImport({ config: wrong, loadSource: async () => { loaded = true; return source(1); } }))
      .rejects.toMatchObject({ code: "connected-corpus-target-refused" });
    expect(loaded).toBe(false);
  });
});

it("corpus importer fails on lock contention and rolls back a later publication error without partial rows", async () => {
  await withImporterDatabase(async (owner, config) => {
    await owner.query("SELECT pg_advisory_lock(606090,1)");
    try {
      await expect(publishCorpusImport({ config, loadSource: async () => source(1) }))
        .rejects.toMatchObject({ code: "corpus-import-lock-busy" });
    } finally {
      await owner.query("SELECT pg_advisory_unlock(606090,1)");
    }
    await publishCorpusImport({ config, loadSource: async () => source(1) });
    await owner.query(`CREATE FUNCTION corpus_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await owner.query(`CREATE TRIGGER corpus_test_failure BEFORE INSERT ON corpus_decision_events
      FOR EACH ROW EXECUTE FUNCTION corpus_test_failure()`);
    await expect(publishCorpusImport({ config, loadSource: async () => source(3) }))
      .rejects.toMatchObject({ code: "corpus-import-database-failure" });
    expect((await owner.query("SELECT count(*)::integer AS count FROM corpus_imports")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::integer AS count FROM corpus_capture_events")).rows[0].count).toBe(1);
    expect((await owner.query("SELECT count(*)::integer AS count FROM corpus_decision_events")).rows[0].count).toBe(1);
  });
});

it("corpus readiness reads one consistent local projection and keeps coverage dimensions separate", async () => {
  await withImporterDatabase(async (owner, config) => {
    await publishCorpusImport({ config, loadSource: async () => source(1) });
    const before = (await owner.query(`SELECT
      (SELECT count(*)::integer FROM corpus_imports) AS imports,
      (SELECT count(*)::integer FROM corpus_capture_events) AS captures,
      (SELECT count(*)::integer FROM corpus_decision_events) AS decisions,
      (SELECT count(*)::integer FROM corpus_api_videos) AS videos`)).rows[0];
    const report = await generateCorpusReadinessReport({
      config,
      now: NOW,
      loadPrivateGateRecord: async () => ({
        formatVersion: 1,
        eligibleCreatorKeys: ["creator-a", "creator-b"],
        saltHex: "f".repeat(64),
      }),
    });
    expect(report.corpus).toMatchObject({
      registeredCreatorCount: 2,
      identifiedCreatorCount: 2,
      creatorCoverage: "complete",
      videos: { total: 3, included: 1, needsReview: 2, excluded: 0, unknown: 0 },
      captureRate: { capturedIncludedVideos: 1, includedVideos: 1, percentage: 100 },
      publicUseClearance: { status: "not-cleared", clearedVideos: 0, corpusVideos: 3, percentage: 0 },
    });
    expect(report.creators.find((creator) => creator.creatorKey === "creator-a")?.videos[0]).toMatchObject({
      inclusion: "present", captureAvailability: "captured", apiFreshness: "fresh",
      publicUseClearance: "not-cleared",
    });
    expect(report.pickLevelMetrics.market).toBe(PICK_METRICS_PENDING);
    expect(report.downstream.modelReadiness).toBe("blocked");
    await expect(generateCorpusReadinessReport({
      config,
      now: NOW,
      loadPrivateGateRecord: async () => ({
        formatVersion: 1,
        eligibleCreatorKeys: ["creator-a", "creator-b"],
        saltHex: "e".repeat(64),
      }),
    })).rejects.toMatchObject({ code: "readiness-gate-verification-failed" });
    expect((await owner.query(`SELECT
      (SELECT count(*)::integer FROM corpus_imports) AS imports,
      (SELECT count(*)::integer FROM corpus_capture_events) AS captures,
      (SELECT count(*)::integer FROM corpus_decision_events) AS decisions,
      (SELECT count(*)::integer FROM corpus_api_videos) AS videos`)).rows[0]).toEqual(before);
  });
});
