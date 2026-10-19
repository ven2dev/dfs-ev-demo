import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { cleanupDeletedObjects, deleteSources } from "../../src/featureStore/governance.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";

test("#174 shared removal pages progress and final-reference deletion re-arms completed work", { timeout: 120000 }, async () => {
  const started = performance.now();
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs138-removal-queue-")));
  const store = await openLocalObjectStore(root);
  const details: Record<string, unknown> = {};
  let verdict = "fail";
  let failure: string | undefined;
  try {
    await withFeatureStoreDatabase(async ({ writer, reader }) => {
      const objects = Array.from({ length: 1026 }, (_, n) => {
        const bytes = Buffer.from(`synthetic-queue-boundary-${n}`);
        return { bytes, key: objectKey("raw", bytes), hash: sha256(bytes), size: bytes.length };
      }).sort((a, b) => a.key.localeCompare(b.key));
      for (const object of objects) await store.putIfAbsent(object.key, object.bytes);
      const shared = objects.slice(0, 1025);
      const target = objects[1025]; // Later than every shared address in the SQL ordering.
      const job = await startJob(writer, { kind: "normalize", codeSha: "b".repeat(40),
        policySha256: sha256(Buffer.from("queue-policy")), inputSetSha256: sha256(Buffer.from("queue-fixture")) });
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        SELECT profile,'synthetic','stats',$1,'{}' FROM unnest(ARRAY['queue-first','queue-last']) profile`, [NORMALIZER_VERSION]);
      const insert = async (profile: string, inputs: typeof objects) => (await writer.query<{ snapshot_id: string; object_key: string }>(`
        INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
          decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
        SELECT $1,$2,o.hash,o.size,o.key,'text/csv',o.hash,o.hash,0,'2021-01-01','2021-01-01','retrospective'
        FROM jsonb_to_recordset($3) AS o(hash text,size integer,key text) RETURNING snapshot_id,object_key`,
      [profile, job.jobId, JSON.stringify(inputs.map(({ hash, size, key }) => ({ hash, size, key })))])).rows;
      const firstReferences = await insert("queue-first", objects);
      const lastReferences = await insert("queue-last", shared);
      await finishJob(writer, job.jobId, { counts: { objects: objects.length, snapshots: 2051 } });
      for (let n = 0; n < firstReferences.length; n += 1024)
        await deleteSources(writer, firstReferences.slice(n, n + 1024).map(row => row.snapshot_id), "synthetic first references", 0);
      const pendingCount = async () => (await reader.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM fs138.object_removals WHERE completed_at IS NULL")).rows[0].n;
      assert.equal(await pendingCount(), 1026);
      const firstPage = await cleanupDeletedObjects(writer, store);
      assert.equal(firstPage.shared.length, 1024);
      assert.deepEqual(firstPage.removed, []);
      const secondPage = await cleanupDeletedObjects(writer, store);
      details.pageProgress = { sharedObjects: 1025, laterDeletableObjects: 1,
        firstPage: { shared: firstPage.shared.length, removed: firstPage.removed.length },
        secondPage: { shared: secondPage.shared.length, removed: secondPage.removed.length } };
      assert(secondPage.removed.includes(target.key), "later deletable object starved behind the shared page");
      assert.equal(secondPage.shared.length, 1);
      assert.equal(await pendingCount(), 0);
      assert.equal(await store.head(target.key), null);
      for (const object of shared) assert(await store.head(object.key));
      assert.deepEqual(await cleanupDeletedObjects(writer, store), { removed: [], shared: [] });
      const outcomes = async () => (await reader.query(`SELECT outcome,count(*)::integer AS n
        FROM fs138.object_removals WHERE completed_at IS NOT NULL GROUP BY outcome ORDER BY outcome`)).rows;
      assert.deepEqual(await outcomes(), [{ outcome: "removed", n: 1 }, { outcome: "shared-retained", n: 1025 }]);

      for (const sql of ["SELECT fs138.removal_recheck($1)", "SELECT fs138.ack_removal($1)", "SELECT fs138.requeue_removed_object($1)"])
        await assert.rejects(reader.query(sql, [shared[0].key]), { code: "42501" });
      await assert.rejects(writer.query("UPDATE fs138.object_removals SET completed_at=NULL"), { code: "42501" });
      details.permissions = { nonPipelineApiRefusals: 3, directWriterUpdateRefused: true };

      // A rolled-back shared resolution remains pending and can be retried.
      await writer.query("SELECT fs138.requeue_removed_object($1)", [shared[0].key]);
      await writer.query("BEGIN");
      assert.equal((await writer.query("SELECT fs138.removal_recheck($1) AS allowed", [shared[0].key])).rows[0].allowed, false);
      assert.equal((await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [shared[0].key])).rows[0].outcome, "shared-retained");
      await writer.query("ROLLBACK");
      assert.equal(await pendingCount(), 1);
      assert.deepEqual(await cleanupDeletedObjects(writer, store), { removed: [], shared: [shared[0].key] });
      details.rollback = { sharedResolutionRolledBack: true, pendingRetryCompleted: true };

      const events = new Map<string, string>();
      for (let n = 0; n < lastReferences.length; n += 1024) {
        const batch = lastReferences.slice(n, n + 1024);
        const receipt = await deleteSources(writer, batch.map(row => row.snapshot_id), "synthetic final shared references", 0);
        for (const row of batch) events.set(row.object_key, receipt.event_id);
      }
      assert.equal(await pendingCount(), 1025);
      const rearmed = (await reader.query<{ object_key: string; event_id: string; outcome: string | null }>(`
        SELECT object_key,event_id,outcome FROM fs138.object_removals WHERE completed_at IS NULL`)).rows;
      for (const row of rearmed) { assert.equal(row.outcome, null); assert.equal(row.event_id, events.get(row.object_key)); }
      const finalFirstPage = await cleanupDeletedObjects(writer, store);
      const finalSecondPage = await cleanupDeletedObjects(writer, store);
      assert.equal(finalFirstPage.removed.length, 1024);
      assert.equal(finalSecondPage.removed.length, 1);
      assert.equal(finalFirstPage.shared.length + finalSecondPage.shared.length, 0);
      assert.equal(await pendingCount(), 0);
      assert.deepEqual(await outcomes(), [{ outcome: "removed", n: 1026 }]);
      assert.equal((await store.list("raw")).length, 0);
      details.finalReferences = { rearmed: rearmed.length, latestEventMatches: true, completionAndOutcomeReset: true,
        cleanupPageRemovals: [finalFirstPage.removed.length, finalSecondPage.removed.length], pending: 0, objectsRemaining: 0 };

      // Upload-before-publication can recreate tombstoned bytes. Its failure
      // handler re-arms both completion fields, preserving idempotent cleanup.
      await store.putIfAbsent(target.key, target.bytes);
      await assert.rejects(writer.query("SELECT fs138.lock_object_for_publication($1)", [target.key]), /object-address-deleted/);
      await writer.query("SELECT fs138.requeue_removed_object($1)", [target.key]);
      assert.equal((await reader.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [target.key])).rows[0].outcome, null);
      assert.deepEqual((await cleanupDeletedObjects(writer, store)).removed, [target.key]);
      assert.equal(await store.head(target.key), null);
      assert.deepEqual(await cleanupDeletedObjects(writer, store), { removed: [], shared: [] });
      details.recreatedTombstone = { publicationRefused: true, rearmedAndRemoved: true, repeatedCleanupEmpty: true };
    });
    verdict = "pass";
  } catch (error) { failure = String(error); throw error; }
  finally {
    await rm(root, { recursive: true, force: true });
    if (process.env.FEATURE_STORE_QUEUE_EVIDENCE_PATH)
      await writeFile(process.env.FEATURE_STORE_QUEUE_EVIDENCE_PATH, JSON.stringify({ issue: 138, pr: 174,
        fixture: "synthetic local ObjectStore; 1025 shared addresses plus one later deletable address",
        recordedAt: new Date().toISOString(), verdict, elapsedMs: performance.now() - started, details, failure }, null, 2) + "\n");
  }
});
