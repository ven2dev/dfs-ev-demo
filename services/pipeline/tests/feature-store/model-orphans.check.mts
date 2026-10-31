import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { completeQbReport } from "../../scripts/feature-store/evaluation-report.ts";
import { measureQbModelPublication } from "../../scripts/feature-store/model-publication-measure.ts";
import { datasetContentSha256, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { discardUnpublishedReport, MODEL_ORPHAN_RETIREMENT_SECONDS, sweepOrphanObjects } from "../../src/featureStore/governance.ts";
import { MODEL_PREREGISTRATION, publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import type { Artifact, QbInputPins } from "../../src/featureStore/qbReports.ts";

type Database = Pick<Client, "query">;
const code = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from("#165 local orphan fixture")) };
const mode = "strict-point-in-time-v1";
const probes: { name: string; verdict: string; details: unknown }[] = [];
const evidence: Record<string, unknown> = { issue: 165, step: 3, recordedAt: new Date().toISOString(), runtime: process.version,
  fixture: "synthetic zero-example dataset; real PostgreSQL pipeline LOGINs, transactions and local immutable ObjectStore", probes };
const intercept = (client: Database, after: (sql: string, result: unknown) => Promise<void>): Database =>
  new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      const result = await Reflect.apply(target.query, target, args);
      await after(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text, result);
      return result;
    };
  } });

test("#165 scoped orphan cleanup, publication races and interrupted connections", { timeout: 120_000 }, async t => {
  const directory = new URL("../../../../node_modules/.cache/feature-store-165/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const root = await realpath(await mkdtemp(new URL("165-orphan-tests-", directory).pathname));
  const store = await openLocalObjectStore(root);
  evidence.storageRoot = root;
  const persist = async (value: unknown): Promise<Artifact> => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n"), digest = sha256(bytes);
    const artifact = { objectKey: `audits/${digest}`, sha256: digest, byteSize: bytes.byteLength };
    await store.putIfAbsent(artifact.objectKey, bytes); return artifact;
  };
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, openWriter }) => {
      const check = async (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); probes.push({ name, verdict: "pass", details }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const proposal = await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/165_model_manifests.sql")), "utf8");
      await admin.query(proposal);
      const cleaner = await openWriter();
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES('orphan-fixture','synthetic','stats','test','{}')`);
      await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        VALUES('orphan-fixture',ARRAY['research'],'2020-01-01','synthetic local research only')`);
      const job = (await writer.query(`INSERT INTO fs138.job_runs(kind,code_sha,policy_sha256,input_set_sha256)
        VALUES('model',$1,$2,$2) RETURNING job_id`, [code.gitSha, code.contentSha256])).rows[0].job_id;
      const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
        decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
        VALUES('orphan-fixture',$1,$2,1,$3,'text/csv',$2,$2,0,'2020-01-01','2020-01-01','retrospective') RETURNING snapshot_id`,
      [job, code.contentSha256, `raw/${code.contentSha256}`])).rows[0].snapshot_id;
      const spec: DatasetSpec = { mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
        featuresAsOf: new Date().toISOString(), labelsAsOf: new Date().toISOString(), includeRetrospective: false, includeSuperseded: true };
      const contentSha256 = datasetContentSha256(spec, []);
      const bytes = Buffer.from(JSON.stringify({ format: "qb-passing-yards-dataset-v1", code, spec, rows: [], contentSha256 }) + "\n");
      const fileSha256 = sha256(bytes), key = `datasets/${fileSha256}`;
      await store.putIfAbsent(key, bytes);
      const datasetId = (await writer.query(`INSERT INTO fs138.dataset_manifests(code_sha,implementation_sha256,spec,input_sha256,
        file_sha256,object_key,byte_size,row_count,exclusions,rights_receipt,content_sha256)
        VALUES($1,$2,$3,$2,$4,$5,$6,0,'{}','{}',$7) RETURNING dataset_id`,
      [code.gitSha, code.contentSha256, spec, fileSha256, key, bytes.byteLength, contentSha256])).rows[0].dataset_id;
      await writer.query("INSERT INTO fs138.dataset_inputs VALUES($1,$2)", [datasetId, snapshot]);
      const pins: QbInputPins = { format: "qb-evaluation-input-pins-v1", rightsScope: "research",
        designation: "uncalibrated-interim-hit-rate", preregistration: { ...MODEL_PREREGISTRATION, approved: true }, code,
        versions: { model: MODEL_VERSION, adapter: EMPIRICAL_ADAPTER, feature: FEATURE_VERSION, label: LABEL_VERSION, history: HISTORY_POLICY },
        populationDiagnostics: [], populationArtifact: await persist({ format: "qb-evaluation-observed-stats-v1", rows: [] }),
        modes: [{ mode, spec, dataset: { datasetId, objectKey: key, fileSha256, byteSize: bytes.byteLength, contentSha256, rowCount: 0 },
          coverageArtifact: await persist({ format: "qb-evaluation-coverage-v1", mode, rows: [] }) }] };
      const input = await persist(pins), unregistered = [input, pins.populationArtifact, pins.modes[0].coverageArtifact];
      const options = () => ({ code: { ...code, contentSha256: sha256(Buffer.from(randomUUID())) }, modes: [mode] as const });
      const observations = async () => (await writer.query("SELECT object_key FROM fs138.orphan_observations ORDER BY object_key")).rows.map(r => r.object_key as string);
      const counts = async () => (await admin.query(`SELECT (SELECT count(*)::integer FROM fs138.model_runs) AS runs,
        (SELECT count(*)::integer FROM fs138.model_run_datasets) AS datasets,(SELECT count(*)::integer FROM fs138.model_artifacts) AS artifacts`)).rows[0];
      const waitFor = async (pid: number, condition: "Lock" | "gone") => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const state = (await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
          if (condition === "gone" ? !state : state?.wait_event_type === "Lock") return;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail(`backend-${pid}-did-not-reach-${condition}`);
      };
      const failedUpload = async (settings: ReturnType<typeof options>, afterPut: boolean, failAt = 2) => {
        const addresses: string[] = [];
        await assert.rejects(publishQbModelRun(writer, { ...store, putIfAbsent: async (address, payload) => {
          addresses.push(address);
          if (!afterPut && addresses.length === failAt) throw new Error("synthetic-upload-stop");
          const result = await store.putIfAbsent(address, payload);
          if (afterPut && addresses.length === failAt) throw new Error("synthetic-upload-stop");
          return result;
        } }, input, settings), /synthetic-upload-stop/);
        return addresses;
      };

      await check("failed #164 delivery preserves a byte-identical report already committed by #165", async () => {
        const before = await counts();
        let staged = "", committed: Awaited<ReturnType<typeof publishQbModelRun>> | undefined;
        await assert.rejects(completeQbReport(reader, { ...store, putIfAbsent: async (address, payload) => {
          const result = await store.putIfAbsent(address, payload);
          assert(result.created); staged = address;
          committed = await publishQbModelRun(writer, store, input, { code, modes: [mode] });
          assert.equal(committed.reports[0].objectKey, staged);
          await admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
            VALUES('orphan-fixture','{}','2020-01-01','deny #164 final delivery after #165 commits')`);
          return result;
        } }, input, mode, cleaner), /current-rights/);
        assert(committed); assert.equal((await counts()).runs, before.runs + 1);
        assert(await store.head(staged), "failed #164 cleanup cannot unlink a committed #165 report");
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.model_artifacts WHERE object_key=$1", [staged])).rows[0].n, 1);
        const blocker = await openWriter(), cleanerPid = (await cleaner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("BEGIN");
        await blocker.query("SELECT fs138.lock_object_for_publication($1)", [staged]);
        const pending = discardUnpublishedReport(cleaner, store, staged);
        try { await waitFor(cleanerPid, "Lock"); }
        finally { await blocker.query("COMMIT"); }
        await pending; assert(await store.head(staged));
        await admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
          VALUES('orphan-fixture',ARRAY['research'],'2020-01-01','restore synthetic fixture')`);
        return { identicalAddress: true, actualCommitBeforeFailure: true, committedBytesPreserved: true, actualCleanupLockWait: true };
      });
      await check("enrollment survives a crash before upload and retry completes atomically", async () => {
        const settings = options(), before = await counts();
        const attempted = await failedUpload(settings, false, 1), enrolled = await observations();
        assert.equal(enrolled.length, 2); assert.equal(attempted.length, 1);
        for (const address of enrolled) assert.equal(await store.head(address), null);
        assert.deepEqual(await counts(), before);
        const result = await publishQbModelRun(writer, store, input, settings);
        assert.equal(result.descriptor.objectKey, attempted[0]); assert.deepEqual(await observations(), []);
        return { enrolledBeforeBytes: 2, retryCommitted: true };
      });
      await check("a retry renews expired grace before upload even with a sweep before publication", async () => {
        const settings = options(), before = await counts();
        await failedUpload(settings, false, 1);
        const addresses = await observations(); assert.equal(addresses.length, 2);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '2 days' WHERE object_key=ANY($1)", [addresses]);
        let swept = false;
        const client = new Proxy(writer, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return async (...args: unknown[]) => {
            if (args[0] === "BEGIN") {
              for (const address of addresses) assert(await store.head(address), "sweep runs after the retry uploads");
              assert.deepEqual((await sweepOrphanObjects(cleaner, store, 300)).removed, []); swept = true;
            }
            return Reflect.apply(target.query, target, args);
          };
        } });
        const result = await publishQbModelRun(client, store, input, settings);
        assert(swept); assert.equal((await counts()).runs, before.runs + 1);
        assert.deepEqual(await observations(), []); assert(await store.head(result.descriptor.objectKey));
        return { oldObservationExpired: true, sweptAfterRetryUpload: true, retryCommitted: true };
      });
      await check("scoped sweep honors grace, reclaims interrupted uploads and preserves private and shared objects", async () => {
        const settings = options(), addresses = await failedUpload(settings, true);
        assert.equal(addresses.length, 2);
        const before = await counts();
        assert.deepEqual((await sweepOrphanObjects(cleaner, store, 86400)).removed, []);
        // Age only test cleanup observations; no knowledge/publication clock is forged.
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '2 days' WHERE object_key=ANY($1)", [addresses]);
        const swept = await sweepOrphanObjects(cleaner, store, 300);
        assert.deepEqual(swept.removed.sort(), [...addresses].sort());
        for (const address of addresses) assert.equal(await store.head(address), null);
        for (const artifact of unregistered) assert(await store.head(artifact.objectKey));
        // Keep observations: an upload already in flight can finish after sweep.
        assert.deepEqual(await observations(), [...addresses].sort());
        const first = await publishQbModelRun(writer, store, input, settings);
        const repeat = await publishQbModelRun(writer, store, input, settings);
        assert.equal(first.existingPublication, false); assert.equal(repeat.existingPublication, true);
        assert.equal(repeat.runId, first.runId);
        assert.equal((await counts()).runs, before.runs + 1); assert.deepEqual(await observations(), []);
        assert.deepEqual((await sweepOrphanObjects(cleaner, store, 0)).removed, []);
        assert(await store.head(repeat.descriptor.objectKey));
        return { graceRefused: true, reclaimed: addresses.length, privateArtifactsPreserved: unregistered.length,
          sharedReferencesPreserved: true, lateUploadEnrollmentRetained: true };
      });
      await check("cleaner wins before BEGIN and publisher refuses missing bytes with fixed failure work", async () => {
        const before = await counts(); let swept: string[] = [];
        const client = new Proxy(writer, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return async (...args: unknown[]) => {
            if (args[0] === "BEGIN") swept = (await sweepOrphanObjects(cleaner, store, 0)).removed;
            return Reflect.apply(target.query, target, args);
          };
        } });
        await assert.rejects(measureQbModelPublication(client, store, input, options()), error => {
          const e = error as Error & { work: { publicationStatements: number; transactionHeads: number; objectDeletes: number } };
          assert.match(e.message, /model-object-missing-or-mismatched/); assert.equal(e.work.publicationStatements, 4);
          assert.equal(e.work.transactionHeads, 1); assert.equal(e.work.objectDeletes, 0); return true;
        });
        assert.equal(swept.length, 2); assert.deepEqual(await counts(), before);
        return { cleanerRemoved: swept.length, partialRows: false, failureStatements: 4 };
      });
      await check("publisher wins address lock and cleaner waits then preserves newly committed references", async () => {
        const pid = (await cleaner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        let pending: Promise<{ removed: string[] }> | undefined;
        const client = intercept(writer, async sql => {
          if (!sql.includes("guard_model_publication")) return;
          pending = sweepOrphanObjects(cleaner, store, 0);
          await waitFor(pid, "Lock");
        });
        const result = await publishQbModelRun(client, store, input, options());
        assert(pending); const cleaned = await pending;
        const addresses = [result.descriptor.objectKey, ...result.reports.map(r => r.objectKey)];
        for (const address of addresses) { assert(!cleaned.removed.includes(address)); assert(await store.head(address)); }
        return { actualCleanerLockWait: true, committedObjectsPreserved: addresses.length };
      });
      await check("cleaner finishing during an upload leaves late bytes enrolled for the next sweep", async () => {
        const addresses: string[] = []; let removedDuringUpload = 0;
        const before = await counts();
        await assert.rejects(publishQbModelRun(writer, { ...store, putIfAbsent: async (address, payload) => {
          addresses.push(address);
          if (addresses.length === 2) removedDuringUpload = (await sweepOrphanObjects(cleaner, store, 0)).removed.length;
          const result = await store.putIfAbsent(address, payload);
          if (addresses.length === 2) throw new Error("synthetic-late-upload-stop");
          return result;
        } }, input, options()), /synthetic-late-upload-stop/);
        assert.equal(removedDuringUpload, 1); assert(await store.head(addresses[1]));
        const next = await sweepOrphanObjects(cleaner, store, 0);
        assert(next.removed.includes(addresses[1])); assert.deepEqual(await counts(), before);
        return { removedDuringUpload, lateBytesReclaimed: true };
      });
      await check("post-insert rollback and wrong transaction HEAD metadata expose no partial manifests", async () => {
        const before = await counts();
        const broken = intercept(writer, async sql => {
          if (sql.includes("publish_model_run")) throw new Error("synthetic-after-insert-stop");
        });
        await assert.rejects(measureQbModelPublication(broken, store, input, options()), error => {
          const e = error as Error & { work: { publicationStatements: number; transactionStatements: number } };
          assert.match(e.message, /synthetic-after-insert-stop/); assert.equal(e.work.publicationStatements, 5);
          assert.equal(e.work.transactionStatements, 4); return true;
        });
        assert.deepEqual(await counts(), before);
        let metadataRefusals = 0;
        for (const field of ["key", "sha256", "byteSize"] as const) {
          let heads = 0;
          await assert.rejects(publishQbModelRun(writer, { ...store, head: async address => {
            const metadata = await store.head(address);
            return ++heads > 2 && metadata ? { ...metadata, [field]: field === "byteSize" ? metadata.byteSize + 1 : "wrong" } : metadata;
          } }, input, options()), /model-object-missing-or-mismatched/);
          metadataRefusals++;
        }
        assert.deepEqual(await counts(), before);
        await sweepOrphanObjects(cleaner, store, 0);
        return { rollbackAfterInsert: true, metadataRefusals, partialRows: false };
      });
      await check("real backend termination after insert rolls back; enrollment survives for reclamation", async () => {
        const other = await openWriter(); other.on("error", () => {});
        const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, before = await counts();
        const terminated = intercept(other, async sql => {
          if (!sql.includes("publish_model_run")) return;
          assert((await admin.query("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows[0].terminated);
          await waitFor(pid, "gone"); throw new Error("Connection terminated");
        });
        await assert.rejects(publishQbModelRun(terminated, store, input, options()), /model-connection-interrupted-replace/);
        assert.deepEqual(await counts(), before);
        const reclaimed = await sweepOrphanObjects(cleaner, store, 0); assert.equal(reclaimed.removed.length, 2);
        return { actualBackendTerminated: true, partialRows: false, reclaimed: reclaimed.removed.length };
      });
      await check("retry after a lost COMMIT response returns the original run and preserves committed bytes", async () => {
        const other = await openWriter(), before = await counts(); let committed = false;
        const lostResponse = intercept(other, async sql => {
          if (sql !== "COMMIT") return;
          committed = true; await other.end(); throw new Error("Connection closed");
        });
        const settings = options();
        await assert.rejects(publishQbModelRun(lostResponse, store, input, settings), /model-connection-interrupted-replace/);
        assert(committed); assert.equal((await counts()).runs, before.runs + 1);
        const original = (await writer.query(`SELECT * FROM fs138.model_runs
          WHERE identity->'code'->>'contentSha256'=$1`, [settings.code.contentSha256])).rows[0];
        // A fresh effective rights decision authorizes retry but must not replace
        // the first publication's stored clock or receipt.
        await admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
          VALUES('orphan-fixture',ARRAY['research'],'2020-01-01','authorize retry after lost acknowledgement')`);
        const retry = await publishQbModelRun(writer, store, input, settings);
        assert.equal(retry.existingPublication, true); assert.equal(retry.runId, original.run_id);
        assert.deepEqual(retry.recordedAt, original.recorded_at); assert.deepEqual(retry.rightsReceipt, original.rights_receipt);
        assert.equal((await counts()).runs, before.runs + 1);
        const addresses = (await writer.query(`SELECT a.object_key FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
          WHERE r.identity->'code'->>'contentSha256'=$1 ORDER BY a.object_key`, [settings.code.contentSha256])).rows.map(r => r.object_key);
        assert.equal(addresses.length, 2);
        const swept = await sweepOrphanObjects(cleaner, store, 0);
        for (const address of addresses) { assert(!swept.removed.includes(address)); assert(await store.head(address)); }
        return { actualCommitWithAcknowledgementWithheld: true, committedObjectsPreserved: addresses.length,
          retryReturnedOriginalRun: true, retryExistingPublication: true, originalClockAndRightsReceiptPreserved: true };
      });
      await check("cleaner disconnect after unlink is idempotent and unregistered audits require no SQL rechecks", async () => {
        const addresses = await failedUpload(options(), true), other = await openWriter();
        other.on("error", () => {});
        const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        let unlinked = false;
        await assert.rejects(sweepOrphanObjects(other, { ...store, delete: async address => {
          await store.delete(address); unlinked = true;
          await admin.query("SELECT pg_terminate_backend($1)", [pid]); await waitFor(pid, "gone");
          throw new Error("Connection terminated");
        } }, 0), /orphan-connection-interrupted-replace/);
        assert(unlinked);
        const retry = await sweepOrphanObjects(cleaner, store, 0);
        for (const address of addresses) assert.equal(await store.head(address), null);
        const rechecks: string[] = [];
        const observed = new Proxy(cleaner, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return (...args: unknown[]) => {
            if (String(args[0]).includes("orphan_recheck")) rechecks.push((args[1] as string[])[0]);
            return Reflect.apply(target.query, target, args);
          };
        } });
        await sweepOrphanObjects(observed, store, 0);
        for (const artifact of unregistered) {
          assert(!rechecks.includes(artifact.objectKey)); assert(await store.head(artifact.objectKey));
        }
        return { realCleanerDisconnect: true, retryRemoved: retry.removed.length,
          unregisteredAuditRechecks: 0, privateArtifactsPreserved: unregistered.length };
      });
      await check("publisher and both orphan/report cleanup paths classify socket and SQLSTATE failures consistently", async () => {
        const settings = options();
        await failedUpload(settings, true);
        let refusals = 0;
        for (const code of ["ECONNRESET", "EPIPE", "08006"]) {
          for (const operation of ["publisher", "orphan", "report"] as const) {
            const client = await openWriter(), calls: string[] = [];
            const broken = new Proxy(client, { get(target, property) {
              if (property !== "query") return Reflect.get(target, property, target);
              return (...args: unknown[]) => {
                const sql = String(args[0]); calls.push(sql);
                if (sql === "BEGIN") throw Object.assign(new Error("synthetic transport failure"), { code });
                return Reflect.apply(target.query, target, args);
              };
            } });
            try {
              const run = operation === "publisher" ? publishQbModelRun(broken, store, input, settings)
                : operation === "orphan" ? sweepOrphanObjects(broken, store, 0)
                : discardUnpublishedReport(broken, store, unregistered[0].objectKey);
              await assert.rejects(run, /connection-interrupted-replace/);
              assert(!calls.includes("ROLLBACK"), "a dropped connection cannot be reused for rollback"); refusals++;
            } finally { await client.end(); }
          }
        }
        await sweepOrphanObjects(cleaner, store, 0);
        return { codedFailures: refusals, sameClassifier: true };
      });
      await check("registered-address sweep keeps an absent in-flight PUT and reclaims it after completion", async () => {
        const settings = options(), before = await counts();
        let putStarted!: () => void, finishPut!: () => void, address = "";
        const started = new Promise<void>(resolve => { putStarted = resolve; });
        const finish = new Promise<void>(resolve => { finishPut = resolve; });
        const pending = publishQbModelRun(writer, { ...store, putIfAbsent: async (key, payload) => {
          address = key; putStarted(); await finish;
          await store.putIfAbsent(key, payload); throw new Error("synthetic-crash-after-late-put");
        } }, input, settings).then(() => assert.fail("publication cannot complete"), error => error);
        await started;
        const addresses = await observations(); assert(addresses.includes(address));
        // Past the 300 s deletion grace, inside the 24 h recovery window.
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '10 minutes' WHERE object_key=ANY($1)", [addresses]);
        const seen: string[] = [];
        try {
          const swept = await sweepOrphanObjects(cleaner, { ...store,
            list: async namespace => { assert(!["models", "audits"].includes(namespace)); return store.list(namespace); },
            head: async key => { seen.push(key); return store.head(key); } });
          assert.deepEqual(swept.removed, []);
          assert(seen.includes(address), "registered absent address receives a HEAD without storage listing");
          assert((await observations()).includes(address)); assert.equal(await store.head(address), null);
        } finally { finishPut(); }
        assert.match(String(await pending), /synthetic-crash-after-late-put/);
        assert(await store.head(address));
        assert((await sweepOrphanObjects(cleaner, store)).removed.includes(address));
        assert.equal(await store.head(address), null); assert((await observations()).includes(address));
        assert.deepEqual(await counts(), before);
        return { sweptWhilePutInFlight: true, removedBeforePut: 0, registeredAbsentAddressVisited: true,
          latePutReclaimed: true, recoveryRecordPreserved: true, retirementSeconds: MODEL_ORPHAN_RETIREMENT_SECONDS };
      });
      await check("absent recovery records retire after the configured window from last enrollment", async () => {
        assert.equal(MODEL_ORPHAN_RETIREMENT_SECONDS, 24 * 60 * 60);
        const settings = options(); await failedUpload(settings, false, 1);
        const addresses = await observations();
        for (const address of addresses) assert.equal(await store.head(address), null);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '23 hours' WHERE object_key=ANY($1)", [addresses]);
        assert.deepEqual((await sweepOrphanObjects(cleaner, store)).removed, []);
        assert.deepEqual(await observations(), addresses, "default retirement preserves records inside 24 h");
        // Configurable windows are measured from last enrollment, not last sweep.
        await sweepOrphanObjects(cleaner, store, 300, 22 * 60 * 60);
        assert.deepEqual(await observations(), []);
        await failedUpload(options(), false, 1);
        await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '25 hours'");
        assert.deepEqual((await sweepOrphanObjects(cleaner, store)).removed, []);
        assert.deepEqual(await observations(), []);
        for (const artifact of unregistered) assert(await store.head(artifact.objectKey));
        return { defaultRetirementSeconds: MODEL_ORPHAN_RETIREMENT_SECONDS, retainedAt23Hours: true,
          configurableWindowHonored: true, absentAt25HoursRetired: true, privateObjectsPreserved: true };
      });
      evidence.database = (await admin.query("SELECT version() AS version")).rows[0].version;
      evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
    });
  } catch (error) { evidence.verdict = "fail"; evidence.failure = String(error); throw error; }
  finally {
    const paths = ["services/pipeline/src/featureStore/governance.ts", "services/pipeline/src/featureStore/modelManifests.ts",
      "services/pipeline/tests/feature-store/model-orphans.check.mts", "packages/db/proposals/165_model_manifests.sql"];
    evidence.codeHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS165_ORPHAN_EVIDENCE) await writeFile(process.env.FS165_ORPHAN_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});
