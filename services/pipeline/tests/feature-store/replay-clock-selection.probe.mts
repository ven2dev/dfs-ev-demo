import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { readReplayBaseline, restoreReplayMetadata } from "../../scripts/feature-store/replay-restore.ts";
import { loadNormalizedRows } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { normalizeSource } from "../../src/featureStore/normalize.ts";
import { NORMALIZER_VERSION, type SourceAsset } from "../../src/featureStore/source.ts";

test("regenerated schedule rows under their restored owner are visible at the pinned checkpoint", async () => {
  parseReplayDatabaseTarget(process.env);
  const root = process.env.FS244_OBJECT_ROOT;
  assert.ok(root, "set FS244_OBJECT_ROOT to the pinned local fixture");
  const { records, baselineHashes } = await readReplayBaseline();
  const snapshot = records.source_snapshots.find(({ source_manifest }) => (source_manifest as SourceAsset).name === "games.csv.gz");
  const context = records.feature_values.find(({ season, evidence_mode }) => season === 2025 && evidence_mode === "retrospective-reconstruction-v1");
  assert.ok(snapshot && context);
  assert.ok(records.job_inputs.some(({ job_id, snapshot_id }) => job_id === context.job_id && snapshot_id === snapshot.snapshot_id));
  const expected = records.norm_schedule.filter(({ snapshot_id }) => snapshot_id === snapshot.snapshot_id);
  const owner = expected[0]?.job_id;
  assert.ok(typeof owner === "string");
  assert.ok(expected.every(({ job_id, normalizer_version }) => job_id === owner && normalizer_version === NORMALIZER_VERSION));

  const result = await withFeatureStoreDatabase(async (db) => {
    const restore = await restoreReplayMetadata(db.admin, records);
    const store = await openLocalObjectStore(await realpath(root));
    // Checkpoint 1 uses the existing raw normalizer, which verifies the manifest
    // digest itself. The VerifiedWire handoff belongs to checkpoint 2.
    const normalized = await normalizeSource(await store.get(String(snapshot.object_key)),
      snapshot.source_manifest as SourceAsset, AbortSignal.timeout(30_000));
    const byGame = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.game_id).localeCompare(String(b.game_id));
    const values = expected.map((row) => {
      const natural = { ...row, kickoff: new Date(String(row.kickoff)).toISOString() } as Record<string, unknown>;
      for (const field of ["snapshot_id", "job_id", "normalizer_version"]) delete natural[field];
      return natural;
    });
    assert.deepEqual(normalized.rows.sort(byGame), values.sort(byGame));
    const discover = async () => (await db.writer.query<{ selected: boolean }>(`
      SELECT EXISTS (SELECT FROM fs138.qb_job_snapshot_ids($1,$2,'features',$3) WHERE snapshot_id=$4) AS selected`,
    [context.season, context.checkpoint, NORMALIZER_VERSION, snapshot.snapshot_id])).rows[0].selected;
    assert.equal(await discover(), false);
    await loadNormalizedRows(db.writer, "schedules", String(snapshot.snapshot_id), owner, normalized.rows);
    assert.equal(await discover(), true);
    const replayCheckedAt = (await db.admin.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
    return { restore, pinnedCheckpoint: context.checkpoint, replayCheckedAt, normalizedRows: normalized.rows.length,
      selectedBeforeStage: false, selectedAfterStage: true };
  });
  const receipt = { issue: 244, checkpoint: 1, base: "4ce685a", baselineHashes, ...result, scratchCleanup: true };
  if (process.env.FS244_PROBE_RECEIPT) {
    await writeFile(process.env.FS244_PROBE_RECEIPT, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify(result));
});
