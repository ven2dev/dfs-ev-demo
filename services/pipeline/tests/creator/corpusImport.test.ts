import { expect, it } from "vitest";
import type { Client } from "pg";
import { buildCaptureEvent } from "../../../../apps/web/src/lib/creatorCaptures.ts";
import type { DecisionEvent } from "../../../../apps/web/src/lib/creatorDecisions.ts";
import {
  CORPUS_LOCK_KEY,
  CORPUS_LOCK_NAMESPACE,
  publishCorpusImport,
} from "../../scripts/creator-corpus/importPublisher.ts";
import type { CorpusDatabaseConfig } from "../../scripts/creator-corpus/importTarget.ts";
import type { CorpusImportSource } from "../../scripts/creator-corpus/importPlanner.ts";
import { buildReadinessGate } from "../../scripts/creator-corpus/readinessGate.ts";
import { generateCorpusReadinessReport, PICK_METRICS_PENDING } from "../../scripts/creator-corpus/readinessReport.ts";
import { expireCorpusApiEvidence } from "../../scripts/creator-corpus/apiExpiry.ts";
import { NOW, discoveryFor, record, vid } from "../../scripts/creator-corpus/testSupport.ts";
import { withMigratedDatabase } from "@dfs-ev/db-tooling/test-support/migrated";

const decision = (n: number): DecisionEvent => ({
  videoId: vid(n),
  decision: "include",
  reason: "Synthetic owner decision",
  ruleVersion: "v1",
  decidedAt: "2026-10-07T11:00:00.000Z",
});

const source = (version = 1): CorpusImportSource => {
  const discovery = discoveryFor(version > 3
    ? [record(1, { durationSeconds: 2100 }), record(2), record(3)]
    : [record(1), record(2)]);
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
      decisions: (version > 2 ? "4" : "d").repeat(64), discovery: (version > 3 ? "5" : "e").repeat(64),
    },
    now: NOW,
  };
};

const withImporterDatabase = async (run: (owner: Client, config: CorpusDatabaseConfig) => Promise<void>) => {
  await withMigratedDatabase(process.env, async (owner, { expected }) => {
    await owner.query("ALTER ROLE corpus_importer LOGIN PASSWORD 'corpus-test-only'");
    try {
      await run(owner, { ...expected, user: "corpus_importer", password: "corpus-test-only",
        application_name: "corpus-import-test" } as CorpusDatabaseConfig);
    } finally {
      await owner.query("ALTER ROLE corpus_importer NOLOGIN");
    }
  });
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
    expect(await publishCorpusImport({ config, loadSource: async () => source(4) })).toMatchObject({
      outcome: "append", capturesAppended: 0, decisionsAppended: 1, apiSnapshotsReplaced: 1,
    });
    const counts = (await owner.query(`SELECT
      (SELECT count(*)::integer FROM corpus_imports) AS imports,
      (SELECT count(*)::integer FROM corpus_capture_events) AS captures,
      (SELECT count(*)::integer FROM corpus_decision_events) AS decisions,
      (SELECT count(*)::integer FROM corpus_api_videos) AS videos`)).rows[0];
    expect(counts).toEqual({ imports: 3, captures: 2, decisions: 2, videos: 4 });
    expect((await owner.query("SELECT duration_seconds FROM corpus_api_videos WHERE creator_key='creator-a' AND video_id=$1",
      [vid(1)])).rows[0].duration_seconds).toBe(2100);
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

it("corpus API expiry removes complete stale snapshots while preserving permanent owner history", async () => {
  await withImporterDatabase(async (owner, config) => {
    await publishCorpusImport({ config, loadSource: async () => source(1) });
    const atLimit = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(await expireCorpusApiEvidence({ config, now: atLimit })).toMatchObject({
      outcome: "expired", creatorsExpired: 0, videosDeleted: 0,
    });
    const expiredAt = new Date(atLimit.getTime() + 1);
    await expect(generateCorpusReadinessReport({
      config,
      now: expiredAt,
      loadPrivateGateRecord: async () => ({
        formatVersion: 1,
        eligibleCreatorKeys: ["creator-a", "creator-b"],
        saltHex: "f".repeat(64),
      }),
    })).rejects.toMatchObject({ code: "corpus-readiness-api-expiry-required" });
    await owner.query("SELECT pg_advisory_lock($1,$2)", [CORPUS_LOCK_NAMESPACE, CORPUS_LOCK_KEY]);
    try {
      await expect(expireCorpusApiEvidence({ config, now: expiredAt }))
        .rejects.toMatchObject({ code: "corpus-api-expiry-lock-busy" });
    } finally {
      await owner.query("SELECT pg_advisory_unlock($1,$2)", [CORPUS_LOCK_NAMESPACE, CORPUS_LOCK_KEY]);
    }
    expect(await expireCorpusApiEvidence({ config, now: expiredAt })).toMatchObject({
      outcome: "expired", creatorsExpired: 2, videosDeleted: 3,
    });
    expect((await owner.query(`SELECT
      (SELECT count(*)::integer FROM corpus_api_videos) AS videos,
      (SELECT count(*)::integer FROM corpus_capture_events) AS captures,
      (SELECT count(*)::integer FROM corpus_decision_events) AS decisions,
      (SELECT count(*)::integer FROM corpus_imports) AS imports,
      (SELECT count(*)::integer FROM corpus_gate_registrations) AS gates`)).rows[0]).toEqual({
      videos: 0, captures: 1, decisions: 1, imports: 1, gates: 1,
    });
    const report = await generateCorpusReadinessReport({
      config,
      now: expiredAt,
      loadPrivateGateRecord: async () => ({
        formatVersion: 1,
        eligibleCreatorKeys: ["creator-a", "creator-b"],
        saltHex: "f".repeat(64),
      }),
    });
    expect(report.corpus).toMatchObject({
      videos: { total: 1, included: 0, needsReview: 0, excluded: 0, unknown: 1 },
      slots: { total: 80, present: 0, needsReview: 0, missing: 80 },
      publicUseClearance: { status: "not-cleared", clearedVideos: 0, corpusVideos: 1, percentage: 0 },
    });
    expect(report.creators.map((creator) => [creator.creatorKey, creator.apiEvidence])).toEqual([
      ["creator-a", "unknown"], ["creator-b", "unknown"],
    ]);
  });
});
