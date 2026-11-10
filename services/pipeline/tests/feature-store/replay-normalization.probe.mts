import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { stageReplayNormalization } from "../../scripts/feature-store/replay-normalized.ts";
import { readReplayBaseline, restoreReplayMetadata } from "../../scripts/feature-store/replay-restore.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";

test("stages the pinned normalized graph only after verified per-object parity", { timeout: 120_000 }, async () => {
  parseReplayDatabaseTarget(process.env);
  const root = process.env.FS244_OBJECT_ROOT;
  assert.ok(root, "set FS244_OBJECT_ROOT to the pinned local fixture");
  const { records, baselineHashes } = await readReplayBaseline();
  const store = await openLocalObjectStore(await realpath(root));
  const summary = await withFeatureStoreDatabase(async (db) => {
    await restoreReplayMetadata(db.admin, records);
    // These are synthetic research grants for the disposable qualification.
    await db.writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
      SELECT profile_id, ARRAY['research'], now()-interval '1 minute', 'synthetic replay qualification'
      FROM fs138.source_profiles`);
    const objectReads: string[] = [];
    const measured = { ...store, getVerified: (key: string, maxBytes: number) => {
      objectReads.push(key);
      return store.getVerified(key, maxBytes);
    } };
    const schedule = records.norm_schedule[0];
    const badSchedule = { ...schedule, home_score: Number(schedule.home_score ?? 0) + 1 };
    const mismatch = {
      ...records, source_snapshots: records.source_snapshots.filter(({ snapshot_id }) => snapshot_id === schedule.snapshot_id),
      norm_schedule: [badSchedule, ...records.norm_schedule.slice(1)],
    };
    await assert.rejects(stageReplayNormalization(db, db.reader, measured, mismatch), /replay-normalized-value-mismatch/);
    assert.equal((await db.reader.query("SELECT count(*)::int AS n FROM fs138.norm_schedule")).rows[0].n, 0);
    assert.equal(objectReads.splice(0).length, 1);

    const before = { ...db.queryCounts };
    const result = await stageReplayNormalization(db, db.reader, measured, records);
    assert.equal(db.queryCounts.reader - before.reader, 1);
    assert.equal(db.queryCounts.writer - before.writer, 16);
    assert.equal(result.withdrawn, 0);
    assert.equal(result.verifiedObjects, 16);
    assert.equal(result.verifiedWireBytes, 246304787);
    assert.equal(result.normalizedRows, 103468);
    assert.equal(objectReads.length, 16);
    assert.equal(new Set(objectReads).size, 16);
    return { normalizedParity: result.normalizedParity, verifiedObjects: result.verifiedObjects,
      verifiedWireBytes: result.verifiedWireBytes, normalizedRows: result.normalizedRows,
      sourceRightsQueries: 1, typedLoadStatements: 16, mismatchRefusedBeforeStaging: true };
  });
  const receipt = { issue: 244, checkpoint: 2, baselineHashes, ...summary,
    scratchCleanup: true, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  if (process.env.FS244_PROBE_RECEIPT) {
    await writeFile(process.env.FS244_PROBE_RECEIPT, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({ verifiedObjects: receipt.verifiedObjects, verifiedWireBytes: receipt.verifiedWireBytes,
    normalizedRows: receipt.normalizedRows, mismatchRefusedBeforeStaging: receipt.mismatchRefusedBeforeStaging }));
});
