import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { deleteDatasets, deleteSources, cleanupDeletedObjects, sweepOrphanObjects } from "@dfs-ev/pipeline/feature-store/governance";
import { ArtifactGovernanceError, publishQbModelRun } from "@dfs-ev/pipeline/feature-store/model-manifests";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { artifactGovernanceError } from "../../src/featureStore/artifactGovernanceErrors.ts";
import { governanceFixture, governanceCode, governanceIdentity } from "./artifact-governance-fixture.ts";

const evidence: { issue: number; step: number; runtime: string; fixture: string; probes: { name: string; verdict: string; details: unknown }[];
  verdict?: string; failure?: string; sourceHashes?: Record<string, string> } = {
  issue: 166, step: 1, runtime: process.version, fixture: "synthetic dependency controls, actual restricted LOGINs and private local ObjectStore",
  probes: [],
};

test("#166 proposal lifecycle and source/explicit dataset deletion", { timeout: 120_000 }, async t => {
  const cache = new URL("../../../../node_modules/.cache/feature-store-166/", import.meta.url);
  await mkdir(cache, { recursive: true });
  const store = await openLocalObjectStore(await mkdtemp(new URL("step-1-", cache).pathname));
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, openWriter, createReaderConfig }) => {
      await admin.query("BEGIN");
      try {
        for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql"])
          await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const fixture = governanceFixture(writer, store);
      const publish = async (pins: Awaited<ReturnType<typeof fixture.objects>>, client = writer) =>
        (await client.query("SELECT * FROM fs138.publish_model_run($1,$2)", [governanceIdentity, JSON.stringify(pins)])).rows[0];
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); evidence.probes.push({ name, verdict: "pass", details }); }
        catch (error) { evidence.probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const status = async (id: string) => (await writer.query("SELECT * FROM fs138.model_runs WHERE run_id=$1", [id])).rows[0];
      await check("source closure invalidates exactly dependent runs and enqueues all their pins", async () => {
        const a = await fixture.source(), b = await fixture.source();
        const da = await fixture.dataset([a.snapshot], "retrospective-reconstruction-v1"), db = await fixture.dataset([b.snapshot]);
        const objects = await fixture.objects([da, db]), run = await publish(objects);
        const survivor = await publish(await fixture.objects([db]));
        const before = await status(run.run_id);
        const originalPins = (await writer.query("SELECT * FROM fs138.model_run_datasets WHERE run_id=$1 ORDER BY dataset_id", [run.run_id])).rows;
        const originalArtifacts = (await writer.query("SELECT * FROM fs138.model_artifacts WHERE run_id=$1 ORDER BY slot", [run.run_id])).rows;
        const receipt = await deleteSources(writer, [a.snapshot], "source withdrawn", 0);
        assert.deepEqual(receipt.dataset_ids, [da.datasetId]); assert.deepEqual(receipt.run_ids, [run.run_id]);
        const after = await status(run.run_id);
        assert(after.invalidated_at); assert.equal(after.deletion_event_id, receipt.event_id);
        for (const field of ["run_id", "descriptor_sha256", "identity", "recorded_at", "rights_receipt"])
          assert.deepEqual(after[field], before[field]);
        assert.deepEqual((await writer.query("SELECT * FROM fs138.model_run_datasets WHERE run_id=$1 ORDER BY dataset_id", [run.run_id])).rows, originalPins);
        assert.deepEqual((await writer.query("SELECT * FROM fs138.model_artifacts WHERE run_id=$1 ORDER BY slot", [run.run_id])).rows, originalArtifacts);
        assert.equal((await status(survivor.run_id)).invalidated_at, null);
        const queued = (await writer.query("SELECT object_key FROM fs138.object_removals WHERE event_id=$1 ORDER BY object_key", [receipt.event_id])).rows.map(r => r.object_key);
        assert.deepEqual(queued, [a.artifact.objectKey, da.objectKey, ...objects.map(o => o.objectKey)].sort());
        assert.equal((await writer.query("SELECT deleted_at FROM fs138.source_snapshots WHERE snapshot_id=$1", [b.snapshot])).rows[0].deleted_at, null);
        await assert.rejects(publish(objects), { code: "P1661" });
        const repeat = await deleteSources(writer, [a.snapshot], "repeat", 300);
        assert.notEqual(repeat.event_id, receipt.event_id);
        assert.deepEqual((await status(run.run_id)).invalidated_at, after.invalidated_at);
        assert.equal((await status(run.run_id)).deletion_event_id, receipt.event_id);
        for (const sql of ["UPDATE fs138.model_runs SET invalidated_at=NULL,deletion_event_id=NULL WHERE run_id=$1",
          "UPDATE fs138.model_runs SET identity=jsonb_set(identity,'{code,gitSha}',to_jsonb(repeat('b',40))) WHERE run_id=$1"])
          await assert.rejects(admin.query(sql, [run.run_id]), /model-publication-immutable/);
        return { dependentRun: run.run_id, survivor: survivor.run_id, receipt, queued, firstInvalidationPreserved: true };
      });
      await check("explicit dataset deletion preserves sources, other datasets and derived values", async () => {
        const source = await fixture.source(), example = await fixture.example(source);
        const a = await fixture.dataset([source.snapshot], undefined, [example]), b = await fixture.dataset([source.snapshot], undefined, [example]);
        const run = await publish(await fixture.objects([a])), unrelated = await publish(await fixture.objects([b]));
        const before = (await writer.query("SELECT count(*)::integer AS n FROM fs138.feature_values")).rows[0].n;
        const receipt = await deleteDatasets(writer, [a.datasetId], "one dataset", 0);
        assert.deepEqual(receipt.dataset_ids, [a.datasetId]); assert.deepEqual(receipt.run_ids, [run.run_id]);
        assert.deepEqual(receipt.snapshot_ids, []); assert.deepEqual(receipt.feature_ids, []); assert.deepEqual(receipt.label_ids, []);
        assert.equal((await writer.query("SELECT deleted_at FROM fs138.source_snapshots WHERE snapshot_id=$1", [source.snapshot])).rows[0].deleted_at, null);
        assert.equal((await status(unrelated.run_id)).invalidated_at, null);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.feature_values")).rows[0].n, before);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.outcome_labels WHERE label_id=$1", [example.labelId])).rows[0].n, 1);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.norm_player_game_stats WHERE snapshot_id=$1", [source.snapshot])).rows[0].n, 1);
        assert.deepEqual((await writer.query("SELECT dataset_id FROM fs138.dataset_members WHERE dataset_id=ANY($1)", [[a.datasetId, b.datasetId]])).rows,
          [{ dataset_id: b.datasetId }]);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.object_removals WHERE object_key=$1", [source.artifact.objectKey])).rows[0].n, 0);
        return { receipt, unrelatedRun: unrelated.run_id, sourceKept: true, actualMembersBefore: 2,
          actualMembersAfter: 1, featureAndLabelKept: true, normalizedRowKept: true };
      });
      await check("source deletion follows membership lineage and removes actual derived/provider rows only in its scope", async () => {
        const a = await fixture.source(), b = await fixture.source();
        const ea = await fixture.example(a), eb = await fixture.example(b);
        // A deliberately incomplete dataset_inputs control proves the legacy
        // membership-union route independently of the direct source-pin route.
        const da = await fixture.dataset([b.snapshot], undefined, [ea]), db = await fixture.dataset([b.snapshot], undefined, [eb]);
        const affected = await publish(await fixture.objects([da])), survivor = await publish(await fixture.objects([db]));
        const receipt = await deleteSources(writer, [a.snapshot], "member source withdrawn", 0);
        assert.deepEqual(receipt.feature_ids, [ea.featureId]); assert.deepEqual(receipt.label_ids, [ea.labelId]);
        assert.deepEqual(receipt.dataset_ids, [da.datasetId]); assert.deepEqual(receipt.run_ids, [affected.run_id]);
        assert.equal((await status(survivor.run_id)).invalidated_at, null);
        assert.deepEqual((await writer.query("SELECT feature_id FROM fs138.feature_values WHERE feature_id=ANY($1)", [[ea.featureId, eb.featureId]])).rows,
          [{ feature_id: eb.featureId }]);
        assert.deepEqual((await writer.query("SELECT label_id FROM fs138.outcome_labels WHERE label_id=ANY($1)", [[ea.labelId, eb.labelId]])).rows,
          [{ label_id: eb.labelId }]);
        assert.deepEqual((await writer.query("SELECT snapshot_id FROM fs138.norm_player_game_stats WHERE snapshot_id=ANY($1)", [[a.snapshot, b.snapshot]])).rows,
          [{ snapshot_id: b.snapshot }]);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.dataset_members WHERE dataset_id=$1", [da.datasetId])).rows[0].n, 0);
        assert.deepEqual((await writer.query("SELECT source_manifest FROM fs138.source_snapshots WHERE snapshot_id=$1", [a.snapshot])).rows[0].source_manifest, {});
        return { receipt, survivorRun: survivor.run_id, membershipUnionProved: true, actualRowsRemoved: 3, unrelatedRowsKept: 3 };
      });
      await check("writer/reader LOGINs cannot directly mutate registry or call private closure; outsider cannot govern", async () => {
        let refusals = 0;
        for (const client of [reader, writer]) for (const sql of [
          "UPDATE fs138.model_runs SET invalidated_at=clock_timestamp()", "DELETE FROM fs138.model_runs",
          "UPDATE fs138.model_artifacts SET byte_size=0", "UPDATE fs138.model_run_datasets SET row_count=0",
          "SELECT fs138.invalidate_dataset_dependents('{}','{}','{}','{}','forged',0)",
        ]) { await assert.rejects(client.query(sql), { code: "42501" }); refusals++; }
        for (const sql of ["SELECT fs138.delete_datasets('{}','reader',0)", "SELECT fs138.delete_sources('{}','reader',0)",
          "SELECT * FROM fs138.model_runs", "SET ROLE fs138_pipeline_writer"])
          { await assert.rejects(reader.query(sql), { code: "42501" }); refusals++; }
        const config = await createReaderConfig(); assert(/^fs138_job_[a-f0-9]+$/.test(config.user!));
        await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
        const outsider = new Client(config); await outsider.connect();
        try {
          for (const sql of ["SELECT fs138.delete_datasets('{}','outsider',0)", "SELECT fs138.delete_sources('{}','outsider',0)"])
            { await assert.rejects(outsider.query(sql), { code: "42501" }); refusals++; }
        } finally { await outsider.end(); }
        return { refusals, realReader: (await reader.query("SELECT session_user")).rows[0].session_user, realOutsider: config.user };
      });
      await check("bad/mixed target sets roll back receipts, status and queue atomically", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]);
        const run = await publish(await fixture.objects([data]));
        const counts = async () => (await writer.query(`SELECT (SELECT count(*) FROM fs138.deletion_events) AS events,
          (SELECT count(*) FROM fs138.object_removals) AS queued`)).rows[0];
        const before = await counts(); let refused = 0;
        for (const api of ["delete_sources", "delete_datasets"]) {
          const id = api === "delete_sources" ? source.snapshot : data.datasetId;
          for (const ids of [null, [], [id, id], [id, null], [id, randomUUID()], Array.from({ length: 1025 }, () => randomUUID())]) {
            await assert.rejects(writer.query(`SELECT * FROM fs138.${api}($1,'bad target',0)`, [ids]), { code: "23514" }); refused++;
          }
          for (const grace of [null, -1, 86401, Infinity, NaN]) {
            await assert.rejects(writer.query(`SELECT * FROM fs138.${api}($1,'bad grace',$2)`, [[id], grace]), { code: "23514" }); refused++;
          }
          for (const reason of [null, "", "x".repeat(513)]) {
            await assert.rejects(writer.query(`SELECT * FROM fs138.${api}($1,$2,0)`, [[id], reason]), { code: "23514" }); refused++;
          }
        }
        assert.deepEqual(await counts(), before); assert.equal((await status(run.run_id)).invalidated_at, null);
        await writer.query("BEGIN"); await deleteDatasets(writer, [data.datasetId], "rollback", 0); await writer.query("ROLLBACK");
        assert.deepEqual(await counts(), before); assert.equal((await status(run.run_id)).invalidated_at, null);
        return { refused, explicitRollbackRestoredAll: true };
      });
      await check("publication samples rights after address waits and refuses invalidation before existing-run reuse", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]), objects = await fixture.objects([data]);
        const first = await publish(objects), retry = await publish(objects);
        assert.equal(retry.run_id, first.run_id); assert.equal(retry.existing_publication, true);
        assert.deepEqual(retry.rights_receipt, first.rights_receipt); assert.deepEqual(retry.recorded_at, first.recorded_at);
        await deleteDatasets(writer, [data.datasetId], "invalidate", 0);
        await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
          VALUES($1,'{}',clock_timestamp(),'denied retry')`, [source.profile]);
        await assert.rejects(publish(objects), { code: "P1665" });
        await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
          VALUES($1,ARRAY['research'],clock_timestamp(),'authorized refusal')`, [source.profile]);
        await assert.rejects(publish(objects), { code: "P1661" });
        const live = await fixture.dataset([source.snapshot]), blocked = await fixture.objects([live]), blocker = await openWriter();
        const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("BEGIN"); await blocker.query("SELECT fs138.lock_object_for_publication($1)", [blocked[0].objectKey]);
        const pending = publish(blocked).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        try {
          await waitForLock(admin, pid);
          await admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
            VALUES($1,'{}',clock_timestamp(),'revoked while blocked')`, [source.profile]);
        } finally { await blocker.query("COMMIT"); }
        assert.equal((await pending).error.code, "P1665");
        return { liveRetryReturnedOriginal: true, deniedInvalidatedRetry: "P1665", authorizedInvalidatedRetry: "P1661", refusedAfterLockWait: true };
      });
      for (const kind of ["source", "dataset"] as const) for (const order of ["publication-first", "deletion-first"] as const)
        await check(`${kind} deletion / ${order} commits serialize without escaping the run closure`, async () => {
          const source = await fixture.source(), data = await fixture.dataset([source.snapshot]), objects = await fixture.objects([data]);
          const other = await openWriter(), pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const remove = (client: Client) => kind === "source" ? deleteSources(client, [source.snapshot], "race", 0)
            : deleteDatasets(client, [data.datasetId], "race", 0);
          await writer.query("BEGIN");
          if (order === "publication-first") {
            const run = await publish(objects);
            const pending = remove(other).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
            try { await waitForLock(admin, pid); } finally { await writer.query("COMMIT"); }
            const result = await pending; if (result.error) throw result.error;
            assert(result.value?.run_ids?.includes(run.run_id)); assert((await status(run.run_id)).invalidated_at);
          } else {
            await remove(writer);
            const pending = publish(objects, other).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
            try { await waitForLock(admin, pid); } finally { await writer.query("COMMIT"); }
            assert.equal((await pending).error.code, "P1661");
          }
          return { actualLockWait: true, kind, order, noEscapingPublication: true };
        });
      await check("pipeline retry has typed invalidation before scoring or uploads", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]), input = await fixture.inputPins([data]);
        const first = await publishQbModelRun(writer, store, input, { code: governanceCode, modes: [data.mode] });
        await deleteDatasets(writer, [data.datasetId], "pipeline retry", 0);
        let puts = 0;
        await assert.rejects(publishQbModelRun(writer, { ...store, putIfAbsent: async (key, bytes) => {
          puts++; return store.putIfAbsent(key, bytes);
        } }, input, { code: governanceCode, modes: [data.mode] }), error =>
          error instanceof ArtifactGovernanceError && error.code === "model-publication-invalidated");
        assert.equal(puts, 0); assert((await status(first.runId)).invalidated_at);
        return { code: "model-publication-invalidated", uploads: puts };
      });
      await check("lost COMMIT reply returns no result and a fresh-connection retry reuses the original publication", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]), input = await fixture.inputPins([data]);
        const original = await openWriter(); let committed = false;
        const lostReply = { query: async (sql: string, values?: unknown[]) => {
          const result = await original.query(sql, values);
          if (sql === "COMMIT") { committed = true; throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" }); }
          return result;
        } } as Pick<Client, "query">;
        await assert.rejects(publishQbModelRun(lostReply, store, input, { code: governanceCode, modes: [data.mode] }),
          /model-connection-interrupted-replace/);
        assert(committed); await original.end();
        const before = (await writer.query(`SELECT r.* FROM fs138.model_runs r JOIN fs138.model_run_datasets d USING(run_id)
          WHERE d.dataset_id=$1`, [data.datasetId])).rows;
        assert.equal(before.length, 1);
        const retry = await publishQbModelRun(writer, store, input, { code: governanceCode, modes: [data.mode] });
        assert.equal(retry.existingPublication, true); assert.equal(retry.runId, before[0].run_id);
        assert.deepEqual(retry.recordedAt, before[0].recorded_at); assert.deepEqual(retry.rightsReceipt, before[0].rights_receipt);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.model_run_datasets WHERE dataset_id=$1", [data.datasetId])).rows[0].n, 1);
        return { lostCommitResultWithheld: true, existingPublication: true, runs: 1, firstReceiptPreserved: true };
      });
      await check("pre-BEGIN tombstone refusal is typed and SQLSTATE mapping preserves unrelated failures", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]), input = await fixture.inputPins([data]);
        const event = (await deleteDatasets(writer, [(await fixture.dataset([source.snapshot])).datasetId], "tombstone control", 0)).event_id;
        let enrolled = false, uploads = 0;
        const tombstoneAtPreflight = { ...store, head: async (key: string) => {
          if (key.startsWith("models/") && !enrolled) {
            await admin.query("INSERT INTO fs138.object_removals(object_key,event_id,remove_after) VALUES($1,$2,clock_timestamp())", [key, event]);
            enrolled = true;
          }
          return store.head(key);
        }, putIfAbsent: async (key: string, bytes: Uint8Array) => { uploads++; return store.putIfAbsent(key, bytes); } };
        await assert.rejects(publishQbModelRun(writer, tombstoneAtPreflight, input, { code: governanceCode, modes: [data.mode] }),
          error => error instanceof ArtifactGovernanceError && error.code === "model-object-deleted");
        assert(enrolled); assert.equal(uploads, 0);
        for (const [code, expected] of [["P1661", "model-publication-invalidated"], ["P1662", "model-object-deleted"], ["P1665", "model-current-rights-refused"]]) {
          const cause = { code, message: "arbitrary provider text" }, mapped = artifactGovernanceError(cause);
          assert(mapped instanceof ArtifactGovernanceError); assert.equal(mapped.code, expected); assert.equal(mapped.cause, cause);
        }
        for (const other of [new Error("model-object-deleted"), { code: "23514", message: "model-object-deleted" }, null])
          assert.equal(artifactGovernanceError(other), other);
        return { beforeBegin: true, code: "model-object-deleted", uploads, sqlstateMappings: 3, unrelatedFailuresPreserved: 3 };
      });
      await check("new queue rows protect live shared references and preserve observed-address ownership", async () => {
        const a = await fixture.source(), b = await fixture.source();
        const da = await fixture.dataset([a.snapshot], "retrospective-reconstruction-v1"), db = await fixture.dataset([b.snapshot]);
        const shared = await fixture.report(db);
        await publish(await fixture.objects([da, db], [await fixture.report(da), shared]));
        await publish(await fixture.objects([db], [shared]));
        await deleteDatasets(writer, [da.datasetId], "partial shared", 0); await cleanupDeletedObjects(writer, store);
        assert(await store.head(shared.objectKey));
        assert.equal((await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [shared.objectKey])).rows[0].outcome, "shared-retained");
        await deleteDatasets(writer, [db.datasetId], "last live reference", 0);
        assert.equal((await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [shared.objectKey])).rows[0].outcome, null);
        await cleanupDeletedObjects(writer, store); assert.equal(await store.head(shared.objectKey), null);
        const observed = await fixture.persist("audits", { uncommitted: randomUUID() });
        await writer.query("SELECT fs138.enroll_model_objects($1)", [[observed.objectKey]]);
        const event = (await deleteDatasets(writer, [db.datasetId], "observation control", 0)).event_id;
        await admin.query("INSERT INTO fs138.object_removals(object_key,event_id,remove_after) VALUES($1,$2,clock_timestamp())", [observed.objectKey, event]);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '301 seconds' WHERE object_key=$1", [observed.objectKey]);
        await cleanupDeletedObjects(writer, store); assert(await store.head(observed.objectKey));
        await sweepOrphanObjects(writer, store, 300); assert.equal(await store.head(observed.objectKey), null);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.orphan_observations WHERE object_key=$1", [observed.objectKey])).rows[0].n, 1);
        assert.equal((await writer.query("SELECT completed_at FROM fs138.object_removals WHERE object_key=$1", [observed.objectKey])).rows[0].completed_at, null);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '86401 seconds' WHERE object_key=$1", [observed.objectKey]);
        await sweepOrphanObjects(writer, store, 300); await cleanupDeletedObjects(writer, store);
        assert.equal((await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [observed.objectKey])).rows[0].outcome, "removed");
        return { sharedRetainedUntilLastLiveRun: true, orphanDeletedWhilePending: true, mandatoryCompletedOnlyAfterRetirement: true };
      });
    });
    evidence.verdict = evidence.probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.failure = String(error); throw error; }
  finally {
    const paths = ["packages/db/proposals/166_artifact_governance.sql", "services/pipeline/src/featureStore/governance.ts",
      "services/pipeline/src/featureStore/modelManifests.ts", "services/pipeline/src/featureStore/datasets.ts",
      "services/pipeline/src/featureStore/artifactGovernanceErrors.ts", "services/pipeline/tests/feature-store/artifact-governance-fixture.ts",
      "services/pipeline/tests/feature-store/artifact-governance.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS166_LIFECYCLE_EVIDENCE)
      await writeFile(process.env.FS166_LIFECYCLE_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});

const waitForLock = async (admin: Client, pid: number) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = (await admin.query("SELECT wait_event_type,pg_blocking_pids($1) AS blockers FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (state?.wait_event_type === "Lock" && state.blockers.length) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("expected database lock wait was not observed");
};
