import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { cleanupDeletedObjects, deleteDatasets, requeueRemovedObject, sweepOrphanObjects,
  MODEL_ORPHAN_RETIREMENT_SECONDS } from "@dfs-ev/pipeline/feature-store/governance";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { governanceFixture, governanceIdentity, governanceExamples } from "./artifact-governance-fixture.ts";
import { deterministicReadWork } from "./artifact-read-work.ts";
import { assertCleanerTrace, cleanerTrace, measureCleanerWork, waitForCleanerLock } from "./artifact-cleaner-work.ts";

const probes: { name: string; verdict: string; details: unknown }[] = [];
const evidence: Record<string, unknown> = { issue: 166, step: 3, runtime: process.version,
  fixture: "synthetic dependency/queue controls, 0/2504 actual members, real restricted LOGINs and private local ObjectStore",
  qualification: "CI work/behavior only. Test-only observation/grace ages are shifted; database knowledge/event clocks are never backdated. #229 recovery handoff is excluded.", probes };

test("#166 model/audit mandatory removals, orphan deferral and CI cleaner budgets", { timeout: 120_000 }, async t => {
  const cache = new URL("../../../../node_modules/.cache/feature-store-166/", import.meta.url);
  await mkdir(cache, { recursive: true });
  const store = await openLocalObjectStore(await mkdtemp(new URL("step-3-", cache).pathname));
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, openWriter, createReaderConfig }) => {
      await admin.query("BEGIN");
      try {
        for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql"])
          await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const fixture = governanceFixture(writer, store);
      const publish = async (datasets: Parameters<typeof fixture.objects>[0], reports?: Parameters<typeof fixture.objects>[1]) => {
        const objects = await fixture.objects(datasets, reports);
        const run = (await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)", [governanceIdentity, JSON.stringify(objects)])).rows[0];
        return { runId: run.run_id as string, objects };
      };
      // Synthetic queue controls represent overlapping intents/failure states;
      // they do not claim byte-valid report-envelope or publication provenance.
      const controlEvent = (await admin.query(`INSERT INTO fs138.deletion_events(reason,grace_seconds,
        snapshot_ids,feature_ids,label_ids,dataset_ids) VALUES('synthetic queue control',0,'{}','{}','{}','{}') RETURNING event_id`)).rows[0].event_id;
      const queue = (address: string, seconds = 0) => admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
        VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3))`, [address, controlEvent, seconds]);
      const state = async (address: string) => (await writer.query("SELECT * FROM fs138.object_removals WHERE object_key=$1", [address])).rows[0];
      const clock = async () => (await writer.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); probes.push({ name, verdict: "pass", details }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });

      await check("CI: one page plus four statements per deletion; fixed server work at 0/2504 actual members", async () => {
        const source = await fixture.source(), rows = await governanceExamples(writer, source, 2504), results = [];
        for (const count of [0, 2504]) {
          const strict = await fixture.dataset([source.snapshot]);
          const retro = await fixture.dataset([source.snapshot], "retrospective-reconstruction-v1", count ? rows : []);
          const run = await publish([strict, retro]);
          assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.dataset_members WHERE dataset_id=$1", [retro.datasetId])).rows[0].n, count);
          await deleteDatasets(writer, [strict.datasetId, retro.datasetId], "cleaner budget", 0);
          const server = [];
          for (const object of run.objects) server.push({ slot: object.slot,
            ...await measureCleanerWork(writer, object.objectKey, true) });
          const trace = cleanerTrace(writer, store), result = await cleanupDeletedObjects(trace.client, trace.store);
          const expected = [strict.objectKey, retro.objectKey, ...run.objects.map(o => o.objectKey)].sort();
          assert.deepEqual(result.removed.sort(), expected); assertCleanerTrace(trace, 5);
          for (const key of expected) { assert.equal(await store.head(key), null); assert.equal((await state(key)).outcome, "removed"); }
          results.push({ datasetRows: count, candidates: 5, pageStatements: 1, statementsPerDeletion: 4,
            totalStatements: trace.statements.length, objectDeletes: trace.deletes.length, otherObjectWork: trace.work, server });
        }
        for (let n = 0; n < 3; n++) {
          assert.equal(results[0].server[n].slot, results[1].server[n].slot);
          for (const boundary of ["recheck", "ack"] as const)
            assert.deepEqual(deterministicReadWork(results[0].server[n][boundary]!),
              deterministicReadWork(results[1].server[n][boundary]!), "all-table DML and example counters independent of dataset rows");
        }
        return results;
      });
      await check("only live runs retain shared bytes; last-reference deletion re-arms the greatest grace", async () => {
        const a = await fixture.source(), b = await fixture.source(), da = await fixture.dataset([a.snapshot]);
        const db = await fixture.dataset([b.snapshot], "retrospective-reconstruction-v1"), shared = await fixture.report(db);
        const affected = await publish([da, db], [await fixture.report(da), shared]), live = await publish([db], [shared]);
        await deleteDatasets(writer, [da.datasetId], "one dependent run", 0);
        const server = await measureCleanerWork(writer, shared.objectKey, false, true);
        const firstTrace = cleanerTrace(writer, store), first = await cleanupDeletedObjects(firstTrace.client, firstTrace.store);
        assertCleanerTrace(firstTrace, 3, 1); assert(first.shared.includes(shared.objectKey));
        assert.equal((await state(shared.objectKey)).outcome, "shared-retained"); assert(await store.head(shared.objectKey));
        const emptyTrace = cleanerTrace(writer, store); await cleanupDeletedObjects(emptyTrace.client, emptyTrace.store); assertCleanerTrace(emptyTrace, 0);
        const final = await deleteDatasets(writer, [db.datasetId], "last live run", 86400), deadline = (await state(shared.objectKey)).remove_after;
        assert.equal((await state(shared.objectKey)).completed_at, null); assert.equal((await state(shared.objectKey)).outcome, null);
        const repeat = await deleteDatasets(writer, [db.datasetId], "shorter retry cannot shorten grace", 0);
        assert((await state(shared.objectKey)).remove_after >= deadline);
        const notDue = cleanerTrace(writer, store); await cleanupDeletedObjects(notDue.client, notDue.store); assertCleanerTrace(notDue, 0);
        await assert.rejects(writer.query("SELECT fs138.ack_removal($1)", [shared.objectKey]), { code: "23514" });
        await admin.query("UPDATE fs138.object_removals SET remove_after=clock_timestamp()-interval '1 second' WHERE event_id=$1", [repeat.event_id]);
        const last = await cleanupDeletedObjects(writer, store); assert(last.removed.includes(shared.objectKey));
        assert.equal(await store.head(shared.objectKey), null); assert.equal((await state(shared.objectKey)).outcome, "removed");
        const invalidated = (await writer.query("SELECT run_id,invalidated_at FROM fs138.model_runs WHERE run_id=ANY($1)", [[affected.runId, live.runId]])).rows;
        assert(invalidated.every(r => r.invalidated_at));
        return { affectedRun: affected.runId, survivorUntilFinalDeletion: live.runId, sharedAddress: shared.objectKey,
          sharedCompletedDurably: true, finalEvent: final.event_id, repeatEvent: repeat.event_id,
          greatestGracePreserved: true, invalidatedReferencesDoNotRetain: true, recheckServerWork: server };
      });
      await check("observed model/audit bytes are swept after grace while pending; mandatory completion follows 24h retirement", async () => {
        assert.equal(MODEL_ORPHAN_RETIREMENT_SECONDS, 86400);
        const objects = await Promise.all((["models", "audits"] as const).map(namespace => fixture.persist(namespace, { recovery: randomUUID() })));
        for (const object of objects) {
          await writer.query("SELECT fs138.enroll_model_objects($1)", [[object.objectKey]]); await queue(object.objectKey);
          assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,300) AS allowed", [object.objectKey])).rows[0].allowed, false);
          await measureCleanerWork(writer, object.objectKey, false);
          await assert.rejects(writer.query("SELECT fs138.ack_removal($1)", [object.objectKey]), { code: "23514" });
        }
        const beforeGrace = cleanerTrace(writer, store); await cleanupDeletedObjects(beforeGrace.client, beforeGrace.store); assertCleanerTrace(beforeGrace, 0);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '301 seconds' WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)]);
        await admin.query("UPDATE fs138.object_removals SET remove_after=clock_timestamp()+interval '1 hour' WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)]);
        const futureMandatory = await sweepOrphanObjects(writer, store, 300);
        for (const object of objects) {
          assert(!futureMandatory.removed.includes(object.objectKey)); assert(await store.head(object.objectKey));
          assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,300) AS allowed", [object.objectKey])).rows[0].allowed, false);
        }
        await admin.query("UPDATE fs138.object_removals SET remove_after=clock_timestamp()-interval '1 second' WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)]);
        for (const object of objects) assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,300) AS allowed", [object.objectKey])).rows[0].allowed, true);
        const swept = await sweepOrphanObjects(writer, store, 300), bytesRemovedAt = await clock();
        for (const object of objects) {
          assert(swept.removed.includes(object.objectKey)); assert.equal(await store.head(object.objectKey), null);
          assert.equal((await state(object.objectKey)).outcome, null); assert.equal((await state(object.objectKey)).completed_at, null);
          await requeueRemovedObject(writer, object.objectKey);
        }
        await sweepOrphanObjects(writer, store, 300);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.orphan_observations WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)])).rows[0].n, 2);
        const whileObserved = cleanerTrace(writer, store); await cleanupDeletedObjects(whileObserved.client, whileObserved.store); assertCleanerTrace(whileObserved, 0);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '86401 seconds' WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)]);
        await sweepOrphanObjects(writer, store, 300); const observationsRetiredAt = await clock();
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.orphan_observations WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)])).rows[0].n, 0);
        let missingByteDeletes = 0;
        const lastTrace = cleanerTrace(writer, { ...store, delete: async key => {
          assert.equal(await store.head(key), null); missingByteDeletes++; await store.delete(key);
        } });
        const completed = await cleanupDeletedObjects(lastTrace.client, lastTrace.store), queueCompletedAt = await clock();
        assertCleanerTrace(lastTrace, 2); assert.equal(missingByteDeletes, 2);
        for (const object of objects) { assert(completed.removed.includes(object.objectKey)); assert.equal((await state(object.objectKey)).outcome, "removed"); }
        assert(bytesRemovedAt <= observationsRetiredAt && observationsRetiredAt <= queueCompletedAt);
        return { addresses: objects.map(o => o.objectKey), retirementWindowSeconds: MODEL_ORPHAN_RETIREMENT_SECONDS,
          orphanGraceSeconds: 300, bytesRemovedAt, observationsRetiredAt, queueCompletedAt,
          laterMandatoryDeadlineRespected: true, laterOrphanDeadlineRespected: true,
          mandatoryDeletesWhileObserved: 0, ackWhileObservedRefused: true, observationKeptUntilRetirement: true,
          idempotentMissingByteDeletes: missingByteDeletes, repeatedDeleteErrors: 0,
          limitation: "Pending can outlast bytes through the 24h retirement window; this is not #229 late-PUT recovery." };
      });
      await check("recheck after an address-lock wait defers newly visible observations without completing the removal", async () => {
        const object = await fixture.persist("models", { wait: randomUUID() }); await queue(object.objectKey);
        const cleaner = await openWriter(), pid = (await cleaner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await admin.query("BEGIN"); await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,138))", [object.objectKey]);
        const trace = cleanerTrace(cleaner, store), pending = cleanupDeletedObjects(trace.client, trace.store)
          .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        try {
          await waitForCleanerLock(admin, pid);
          // Test-only overlap control; no ownership handoff is implemented.
          await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp())", [object.objectKey]);
        } finally { await admin.query("COMMIT"); }
        const result = await pending; if (result.error) throw result.error;
        assertCleanerTrace(trace, 0, 1); assert(await store.head(object.objectKey));
        assert.equal((await state(object.objectKey)).outcome, null); assert.equal((await state(object.objectKey)).completed_at, null);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '86401 seconds' WHERE object_key=$1", [object.objectKey]);
        await sweepOrphanObjects(writer, store, 300); await sweepOrphanObjects(writer, store, 300); await cleanupDeletedObjects(writer, store);
        return { actualLockWait: true, freshObservationRespected: true, mandatoryDeletes: 0, acks: 0, noDurableCompletionWhileObserved: true };
      });
      await check("cleaner-first publication refuses tombstones and publication-first deletion includes the committed run", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]);
        const report = await fixture.persist("audits", { cleanupFirst: randomUUID() }); await queue(report.objectKey);
        const objects = await fixture.objects([data], [report]), publisher = await openWriter();
        const publisherPid = (await publisher.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
        const cleaning = cleanupDeletedObjects(writer, { ...store, delete: async key => { paused.resolve(); await resume.promise; await store.delete(key); } });
        const outcome = cleaning.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        await Promise.race([paused.promise, outcome.then(r => { throw r.error ?? new Error("cleaner failed to pause"); })]);
        const publishing = publisher.query("SELECT * FROM fs138.publish_model_run($1,$2)", [governanceIdentity, JSON.stringify(objects)])
          .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        try { await waitForCleanerLock(admin, publisherPid); } finally { resume.resolve(); }
        const cleaned = await outcome; if (cleaned.error) throw cleaned.error;
        assert.equal((await publishing).error?.code, "P1662");
        const other = await openWriter(), otherPid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await writer.query("BEGIN"); const run = await publish([data]);
        const deleting = deleteDatasets(other, [data.datasetId], "publication wins first", 0)
          .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        try { await waitForCleanerLock(admin, otherPid); } finally { await writer.query("COMMIT"); }
        const deleted = await deleting; if (deleted.error) throw deleted.error;
        assert(deleted.value?.run_ids.includes(run.runId));
        await cleanupDeletedObjects(writer, store);
        for (const object of run.objects) assert.equal(await store.head(object.objectKey), null);
        return { cleanerFirstPublicationSqlstate: "P1662", publicationFirstRunInDeletionReceipt: true, bothActualLockWaits: true, modelAndReportRemoved: true };
      });
      await check("unlink-before-ack failures and real disconnects resume with idempotent missing-byte deletion", async () => {
        const cases = [];
        for (const namespace of ["models", "audits"] as const) for (const failure of ["exception", "disconnect"] as const) {
          const object = await fixture.persist(namespace, { failure, nonce: randomUUID() }); await queue(object.objectKey);
          const cleaner = await openWriter(); cleaner.on("error", () => {});
          const pid = (await cleaner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const trace = cleanerTrace(cleaner, { ...store, delete: async key => {
            await store.delete(key);
            if (failure === "disconnect") { await admin.query("SELECT pg_terminate_backend($1)", [pid]); throw new Error("Connection terminated"); }
            throw new Error("crash after unlink");
          } });
          await assert.rejects(cleanupDeletedObjects(trace.client, trace.store), failure === "disconnect" ? /cleanup-connection-interrupted-replace/ : /crash after unlink/);
          assert.equal(trace.deletes.length, 1); assert.equal(trace.statements.some(sql => sql.includes("ack_removal")), false);
          assert.equal(trace.statements.includes("ROLLBACK"), failure === "exception");
          assert.equal(await store.head(object.objectKey), null); assert.equal((await state(object.objectKey)).completed_at, null);
          const retry = cleanerTrace(writer, store); await cleanupDeletedObjects(retry.client, retry.store); assertCleanerTrace(retry, 1);
          assert.equal((await state(object.objectKey)).outcome, "removed");
          cases.push({ namespace, failure, unlinkBeforeAck: true, pendingAfterFailure: true, retryDeletes: 1, retrySql: 4 });
        }
        return cases;
      });
      await check("lost COMMIT response keeps completion; explicit model/audit requeue retains tombstones and grace", async () => {
        const cases = [];
        for (const namespace of ["models", "audits"] as const) {
          const bytes = Buffer.from(JSON.stringify({ requeue: randomUUID() }) + "\n"), key = `${namespace}/${sha256(bytes)}`;
          await store.putIfAbsent(key, bytes); await queue(key);
          const cleaner = await openWriter(), statements: string[] = [];
          const lostReply = new Proxy(cleaner, { get(target, property) {
            if (property !== "query") return Reflect.get(target, property, target);
            return async (...args: unknown[]) => {
              const sql = String(args[0]); statements.push(sql); const result = await Reflect.apply(target.query, target, args);
              if (sql === "COMMIT") { await target.end(); throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" }); }
              return result;
            };
          } });
          await assert.rejects(cleanupDeletedObjects(lostReply, store), /cleanup-connection-interrupted-replace/);
          assert(!statements.includes("ROLLBACK")); assert.equal((await state(key)).outcome, "removed");
          const noRepeat = cleanerTrace(writer, store); await cleanupDeletedObjects(noRepeat.client, noRepeat.store); assertCleanerTrace(noRepeat, 0);
          const previous = await state(key); await store.putIfAbsent(key, bytes);
          await assert.rejects(writer.query("SELECT fs138.lock_object_for_publication($1)", [key]), { code: "P1662" });
          const noAutomaticLane = cleanerTrace(writer, store); await cleanupDeletedObjects(noAutomaticLane.client, noAutomaticLane.store); assertCleanerTrace(noAutomaticLane, 0);
          assert(await store.head(key));
          await requeueRemovedObject(writer, key); const rearmed = await state(key);
          assert.equal(rearmed.outcome, null); assert.equal(rearmed.completed_at, null);
          assert.equal(rearmed.event_id, previous.event_id); assert.deepEqual(rearmed.remove_after, previous.remove_after);
          const explicit = cleanerTrace(writer, store); await cleanupDeletedObjects(explicit.client, explicit.store); assertCleanerTrace(explicit, 1);
          assert.equal(await store.head(key), null);
          await assert.rejects(writer.query("SELECT fs138.lock_object_for_publication($1)", [key]), { code: "P1662" });
          cases.push({ namespace, lostCommitDidNotRepeatDelete: true, explicitRequeueRemovedBytes: true,
            tombstoneAndGracePreserved: true, completedRecoveryLaneAbsentAsAgreed: true });
        }
        return cases;
      });
      await check("real reader/outsider LOGINs cannot clean or requeue; invalid writer addresses fail atomically", async () => {
        const object = await fixture.persist("audits", { permission: randomUUID() }); await queue(object.objectKey);
        const before = await state(object.objectKey); let refusals = 0;
        const config = await createReaderConfig(); await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
        const outsider = new Client(config); await outsider.connect();
        try {
          for (const client of [reader, outsider]) for (const name of ["removal_recheck", "ack_removal", "requeue_removed_object"])
            { await assert.rejects(client.query(`SELECT fs138.${name}($1)`, [object.objectKey]), { code: "42501" }); refusals++; }
        } finally { await outsider.end(); }
        await assert.rejects(writer.query("UPDATE fs138.object_removals SET completed_at=NULL"), { code: "42501" }); refusals++;
        for (const name of ["removal_recheck", "ack_removal", "requeue_removed_object"])
          for (const key of [null, "audits/bad", `unknown/${"a".repeat(64)}`, `models/${"A".repeat(64)}`])
            { await assert.rejects(writer.query(`SELECT fs138.${name}($1)`, [key]), { code: "23514" }); refusals++; }
        assert.deepEqual(await state(object.objectKey), before);
        const absent = `models/${"e".repeat(64)}`; await requeueRemovedObject(writer, absent); assert.equal(await state(absent), undefined);
        await cleanupDeletedObjects(writer, store);
        return { actualLoginRefusalsAndBadAddressRefusals: refusals, directMutationRefused: true, unknownRequeueDoesNotCreateOwnership: true };
      });
      await check("bounded pages skip 1025 observed addresses, complete 1025 shared attempts and reach later removable bytes", async () => {
        const source = await fixture.source(), data = await fixture.dataset([source.snapshot]);
        const observed = Array.from({ length: 1025 }, (_, n) => `audits/${n.toString(16).padStart(64, "0")}`);
        await admin.query("INSERT INTO fs138.orphan_observations SELECT unnest($1::text[]),clock_timestamp()", [observed]);
        await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
          SELECT unnest($1::text[]),$2,clock_timestamp()`, [observed, controlEvent]);
        const objectSets = Array.from({ length: 1025 }, (_, n) => {
          const descriptor = sha256(Buffer.from(`page-descriptor-${n}`)), report = sha256(Buffer.from(`page-report-${n}`));
          return [{ slot: "descriptor", datasetId: null, objectKey: `models/${descriptor}`, fileSha256: descriptor, byteSize: 1 },
            { slot: data.mode, datasetId: data.datasetId, objectKey: `audits/${report}`, fileSha256: report, byteSize: 1 }];
        });
        // Valid publication metadata controls only. Retained files need no GET
        // or DELETE in this test; no report-envelope provenance claim is made.
        await writer.query("SELECT fs138.publish_model_run($1,objects) FROM jsonb_array_elements($2) objects", [governanceIdentity, JSON.stringify(objectSets)]);
        const shared = objectSets.map(objects => objects[1].objectKey);
        await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
          SELECT unnest($1::text[]),$2,clock_timestamp()`, [shared, controlEvent]);
        const target = await fixture.persist("models", { laterThanAuditAddresses: randomUUID() }); await queue(target.objectKey);
        const first = cleanerTrace(writer, store), firstPage = await cleanupDeletedObjects(first.client, first.store);
        assertCleanerTrace(first, 0, 1024); assert.equal(firstPage.shared.length, 1024);
        const second = cleanerTrace(writer, store), secondPage = await cleanupDeletedObjects(second.client, second.store);
        assertCleanerTrace(second, 1, 1); assert.deepEqual(secondPage.removed, [target.objectKey]);
        assert.equal(await store.head(target.objectKey), null);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.object_removals WHERE object_key=ANY($1) AND outcome='shared-retained'", [shared])).rows[0].n, 1025);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.object_removals WHERE object_key=ANY($1) AND completed_at IS NULL", [observed])).rows[0].n, 1025);
        const empty = cleanerTrace(writer, store); await cleanupDeletedObjects(empty.client, empty.store); assertCleanerTrace(empty, 0);
        return { observedAddressesDeferredBeforeLimit: observed.length, sharedAttemptsCompleted: shared.length,
          firstPageCandidates: 1024, secondPageCandidates: 2, laterRemovableObjectReached: true,
          observedMandatoryDeletesOrAcks: 0, repeatedPageSql: 1 };
      });
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.failure = String(error); throw error; }
  finally {
    const paths = ["packages/db/proposals/166_artifact_governance.sql", "services/pipeline/src/featureStore/governance.ts",
      "services/pipeline/tests/feature-store/artifact-governance-fixture.ts", "services/pipeline/tests/feature-store/artifact-cleaner-work.ts",
      "services/pipeline/tests/feature-store/artifact-read-work.ts", "services/pipeline/tests/feature-store/artifact-cleaner.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS166_CLEANER_EVIDENCE) await writeFile(process.env.FS166_CLEANER_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});
