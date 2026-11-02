import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { readModelArtifacts, withModelArtifacts, ArtifactGovernanceError,
  type ModelArtifactSlot, type ModelReadRequest } from "@dfs-ev/pipeline/feature-store/model-artifacts";
import { deleteDatasets, deleteSources, cleanupDeletedObjects } from "@dfs-ev/pipeline/feature-store/governance";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { governanceIdentity, governanceFixture, governanceExamples } from "./artifact-governance-fixture.ts";
import { installReadWorkOracle, measureReadWork, assertReadWork, deterministicReadWork, readCounterDelta, type ReadCounters } from "./artifact-read-work.ts";

const slots = ["descriptor", "strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const;
const probes: { name: string; verdict: string; details: unknown }[] = [];
const evidence: Record<string, unknown> = { issue: 166, step: 2, runtime: process.version,
  fixture: "synthetic 0/2504 actual members, same lineage, real restricted LOGINs, private local ObjectStore",
  qualification: "CI behavior and work budgets only; final retained-fixture per-block speed gate remains step 4", probes };
const refusal = (code: string) => (error: unknown) => error instanceof ArtifactGovernanceError && error.code === code;
const countedStore = (store: ObjectStore) => {
  const work = { gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0 };
  return { work, store: { ...store,
    get: async (key: string) => { work.gets++; return store.get(key); },
    head: async (key: string) => { work.heads++; return store.head(key); },
    putIfAbsent: async (key: string, bytes: Uint8Array) => { work.puts++; return store.putIfAbsent(key, bytes); },
    delete: async (key: string) => { work.deletes++; return store.delete(key); },
    list: async (...args: Parameters<ObjectStore["list"]>) => { work.lists++; return store.list(...args); },
  } };
};

test("#166 two-query model delivery, private calculation and database-side CI budgets", { timeout: 120_000 }, async t => {
  const cache = new URL("../../../../node_modules/.cache/feature-store-166/", import.meta.url);
  await mkdir(cache, { recursive: true });
  const store = await openLocalObjectStore(await mkdtemp(new URL("step-2-", cache).pathname));
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, openWriter, createReaderConfig, queryCounts }) => {
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
      const world = async () => {
        const source = await fixture.source(), strict = await fixture.dataset([source.snapshot]);
        const retro = await fixture.dataset([source.snapshot], "retrospective-reconstruction-v1");
        return { source, strict, retro, ...await publish([strict, retro]) };
      };
      const rights = (profile: string, allowed: boolean, expired = false) => writer.query(`INSERT INTO fs138.rights_decisions
        (profile_id,allowed_uses,valid_from,valid_until,rationale) VALUES($1,$2,clock_timestamp()-interval '2 seconds',
        CASE WHEN $3 THEN clock_timestamp()-interval '1 second' ELSE NULL END,'#166 read control')`,
      [profile, allowed ? ["research"] : [], expired]);
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); probes.push({ name, verdict: "pass", details }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });

      await check("CI: exactly two SQL statements, selected GETs only and equal server work for 0/2504 members", async () => {
        const source = await fixture.source(), rows = await governanceExamples(writer, source, 2504);
        const strict = await fixture.dataset([source.snapshot]);
        const emptyRetro = await fixture.dataset([source.snapshot], "retrospective-reconstruction-v1");
        const fullRetro = await fixture.dataset([source.snapshot], "retrospective-reconstruction-v1", rows);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.dataset_members WHERE dataset_id=$1", [fullRetro.datasetId])).rows[0].n, 2504);
        const runs = [
          { name: "single-0", rows: 0, ...await publish([strict]), all: slots.slice(0, 2) },
          { name: "single-2504", rows: 2504, ...await publish([fullRetro]), all: [slots[0], slots[2]] },
          { name: "pair-0", rows: 0, ...await publish([strict, emptyRetro]), all: [...slots] },
          { name: "pair-2504", rows: 2504, ...await publish([strict, fullRetro]), all: [...slots] },
        ];
        await installReadWorkOracle(admin);
        const results: { shape: string; datasetRows: number; selectedFiles: number; sql: number;
          objectWork: ReturnType<typeof countedStore>["work"]; q1: ReadCounters; q2: ReadCounters }[] = [];
        for (const run of runs) for (const selection of [[slots[0]], run.all]) {
          const counted = countedStore(store), start = queryCounts.reader;
          const result = await readModelArtifacts(reader, counted.store, { runId: run.runId, slots: selection });
          assert.equal(queryCounts.reader - start, 2);
          assert.deepEqual(counted.work, { gets: selection.length, heads: 0, puts: 0, deletes: 0, lists: 0 });
          assert.equal(result.value.run.runId, run.runId); assert.equal(result.value.files.length, selection.length);
          assert.equal(result.authorization.decisions.length, 1); assert.equal(result.delivery.decisions.length, 1);
          const q1 = await measureReadWork(reader, run.runId, selection, true);
          const q2 = await measureReadWork(reader, run.runId, selection, false);
          assertReadWork(q1); assertReadWork(q2);
          results.push({ shape: run.name, datasetRows: run.rows, selectedFiles: selection.length,
            sql: 2, objectWork: counted.work, q1, q2 });
        }
        for (const kind of ["single", "pair"]) for (const selection of [1, kind === "single" ? 2 : 3]) {
          const a = results.find(r => r.shape === `${kind}-0` && r.selectedFiles === selection)!;
          const b = results.find(r => r.shape === `${kind}-2504` && r.selectedFiles === selection)!;
          assert.deepEqual(deterministicReadWork(a.q1), deterministicReadWork(b.q1), "Q1 example scan/tuple and all-table DML budgets independent of rows");
          assert.deepEqual(deterministicReadWork(a.q2), deterministicReadWork(b.q2), "Q2 example scan/tuple and all-table DML budgets independent of rows");
        }
        return results;
      });
      await check("CI server oracle detects hidden example scans and definer DML", async () => {
        const results = [];
        for (const dml of [false, true]) {
          const { before, after } = (await reader.query<{ measured: { before: ReadCounters; after: ReadCounters } }>(
            "SELECT fs138.negative_read_work($1) AS measured", [dml])).rows[0].measured;
          const delta = readCounterDelta(before, after);
          assert.throws(() => assertReadWork(delta), dml ? /reader DML/ : /hidden example-table work/);
          if (!dml) assert.equal(delta.find(r => r.table === "feature_values")!.seq_tup_read, 2504);
          else assert.equal(delta.find(r => r.table === "orphan_observations")!.inserted, 1);
          results.push({ hiddenWork: dml ? "definer DML" : "example scan", detected: true });
        }
        return results;
      });
      await check("actual reader LOGIN has only the guarded surface; outsider cannot read or escalate", async () => {
        let refused = 0;
        for (const table of ["model_runs", "model_run_datasets", "model_artifacts"]) for (const verb of ["SELECT * FROM", "DELETE FROM"])
          { await assert.rejects(reader.query(`${verb} fs138.${table}`), { code: "42501" }); refused++; }
        for (const sql of ["SELECT fs138.delete_datasets('{}','reader',0)", "SELECT fs138.delete_sources('{}','reader',0)",
          "SELECT fs138.publish_model_run('{}','[]')", "SELECT fs138.enroll_model_objects('{}')", "SET ROLE fs138_pipeline_writer"])
          { await assert.rejects(reader.query(sql), { code: "42501" }); refused++; }
        const config = await createReaderConfig(); await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
        const outsider = new Client(config); await outsider.connect();
        try { await assert.rejects(outsider.query("SELECT fs138.authorize_model_read($1,$2,true)", [randomUUID(), [slots[0]]]), { code: "42501" }); refused++; }
        finally { await outsider.end(); }
        const login = (await reader.query("SELECT session_user,current_user")).rows[0]; assert.equal(login.session_user, login.current_user);
        return { ...login, refused };
      });
      await check("bad request, unknown run/slot and repeatable snapshots fail closed before any GET", async () => {
        const run = await world(), counted = countedStore(store), before = queryCounts.reader;
        for (const request of [{ runId: "bad", slots: [slots[0]] }, { runId: run.runId, slots: [] },
          { runId: run.runId, slots: ["raw"] }, { runId: run.runId, slots: [slots[0], slots[0]] },
          { runId: run.runId, slots: null }, { runId: run.runId, slots: "descriptor" }])
          await assert.rejects(readModelArtifacts(reader, counted.store, request as ModelReadRequest), refusal("model-read-request-refused"));
        assert.equal(queryCounts.reader, before);
        await assert.rejects(readModelArtifacts(reader, counted.store, { runId: randomUUID(), slots: [slots[0]] }), refusal("model-read-missing"));
        for (const selection of [null, [], [slots[0], null], [slots[0], slots[0]], ["raw"]])
          await assert.rejects(reader.query("SELECT fs138.authorize_model_read($1,$2,true)", [run.runId, selection]), { code: "P1663" });
        const single = await publish([run.strict]);
        await assert.rejects(readModelArtifacts(reader, counted.store, { runId: single.runId, slots: [slots[2]] }), refusal("model-read-missing"));
        await reader.query("SET default_transaction_isolation='repeatable read'");
        try { await assert.rejects(readModelArtifacts(reader, counted.store, { runId: run.runId, slots }), refusal("model-read-session-refused")); }
        finally { await reader.query("SET default_transaction_isolation='read committed'"); }
        assert.equal(counted.work.gets, 0);
        return { malformedRequestSql: 0, missingSlotOrRunTyped: true, repeatableSnapshotRefused: true, gets: 0 };
      });
      await check("initial missing/expired/revoked rights and source/dataset/run status refuse before bytes", async () => {
        const cases = [];
        for (const reason of ["missing-rights", "expired-rights", "revoked-rights", "source", "dataset", "run"] as const) {
          const run = await world();
          if (reason === "missing-rights") await admin.query("DELETE FROM fs138.rights_decisions WHERE profile_id=$1", [run.source.profile]);
          else if (reason === "expired-rights") await rights(run.source.profile, true, true);
          else if (reason === "revoked-rights") await rights(run.source.profile, false);
          else if (reason === "source") await deleteSources(writer, [run.source.snapshot], "before read", 0);
          else if (reason === "dataset") await deleteDatasets(writer, [run.strict.datasetId], "before read", 0);
          else {
            const event = (await deleteDatasets(writer, [(await fixture.dataset([run.source.snapshot])).datasetId], "run status control", 0)).event_id;
            await admin.query("UPDATE fs138.model_runs SET invalidated_at=clock_timestamp(),deletion_event_id=$2 WHERE run_id=$1", [run.runId, event]);
          }
          const counted = countedStore(store), start = queryCounts.reader;
          const code = reason.endsWith("rights") ? "model-current-rights-refused" : "model-read-status-refused";
          await assert.rejects(readModelArtifacts(reader, counted.store, { runId: run.runId, slots }), refusal(code));
          assert.equal(queryCounts.reader - start, 1); assert.equal(counted.work.gets, 0);
          cases.push({ reason, code, sql: 1, gets: 0 });
        }
        return cases;
      });
      await check("descriptor-only reads authorize every cited dataset, including unselected report lineage", async () => {
        const a = await fixture.source(), b = await fixture.source();
        const da = await fixture.dataset([a.snapshot]), db = await fixture.dataset([b.snapshot], "retrospective-reconstruction-v1");
        const run = await publish([da, db]); await rights(b.profile, false);
        const counted = countedStore(store);
        await assert.rejects(readModelArtifacts(reader, counted.store, { runId: run.runId, slots: [slots[0]] }), refusal("model-current-rights-refused"));
        assert.equal(counted.work.gets, 0);
        return { sourcesAuthorized: 2, requestedFiles: 1, unselectedLineageRefused: true, gets: 0 };
      });
      await check("revocation and both deletion APIs during each GET or calculation withhold the result", async () => {
        const cases = [];
        for (const kind of ["rights", "source", "dataset"] as const) for (let point = 0; point < 4; point++) {
          const run = await world(); let gets = 0, delivered = false, calculated = false;
          const change = async () => {
            if (kind === "rights") await rights(run.source.profile, false);
            else if (kind === "source") await deleteSources(writer, [run.source.snapshot], "during read", 300);
            else await deleteDatasets(writer, [run.strict.datasetId], "during read", 300);
          };
          const start = queryCounts.reader;
          const promise = withModelArtifacts(reader, { get: async key => {
            const bytes = await store.get(key); if (gets++ === point) await change(); return bytes;
          } }, { runId: run.runId, slots }, async () => {
            calculated = true; if (point === 3) await change(); return "private-result";
          }).then(result => { delivered = true; return result; });
          await assert.rejects(promise, refusal(kind === "rights" ? "model-current-rights-refused" : "model-read-status-refused"));
          assert.equal(delivered, false); assert.equal(calculated, true); assert.equal(gets, 3); assert.equal(queryCounts.reader - start, 2);
          cases.push({ kind, during: point === 3 ? "calculation" : `GET-${point + 1}`, sql: 2, gets, delivered });
        }
        return cases;
      });
      await check("paused GET and calculation hold no transaction or coordination locks; deletion commits concurrently", async () => {
        const cases = [], pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        for (const point of ["get", "calculation"]) {
          const run = await world(), paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
          let first = true;
          const pause = async () => { paused.resolve(); await resume.promise; };
          const pending = withModelArtifacts(reader, { get: async key => {
            const bytes = await store.get(key); if (point === "get" && first) { first = false; await pause(); } return bytes;
          } }, { runId: run.runId, slots }, async () => { if (point === "calculation") await pause(); return "withheld"; });
          const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
          await Promise.race([paused.promise, outcome.then(result => { throw result.error ?? new Error("read finished without pausing"); })]);
          const concurrent = await openWriter();
          try {
            const activity = (await admin.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
            assert.equal(activity.state, "idle"); assert.equal(activity.xact_start, null);
            const locks = (await admin.query("SELECT locktype,mode FROM pg_locks WHERE pid=$1", [pid])).rows;
            assert.deepEqual(locks, []);
            await concurrent.query("SET statement_timeout='2s'");
            await deleteDatasets(concurrent, [run.strict.datasetId], "while reader paused", 300);
            cases.push({ pausedAt: point, state: activity.state, transactionOpen: false, locks: 0, concurrentDeletionCommitted: true });
          } finally { resume.resolve(); }
          assert(refusal("model-read-status-refused")((await outcome).error));
        }
        return cases;
      });
      await check("shared-retained tombstones preserve unaffected existing-run delivery", async () => {
        const a = await fixture.source(), b = await fixture.source(), da = await fixture.dataset([a.snapshot]);
        const db = await fixture.dataset([b.snapshot], "retrospective-reconstruction-v1"), shared = await fixture.report(db);
        const affected = await publish([da, db], [await fixture.report(da), shared]), live = await publish([db], [shared]);
        await deleteSources(writer, [a.snapshot], "one dependent run", 0); await cleanupDeletedObjects(writer, store);
        assert.equal((await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [shared.objectKey])).rows[0].outcome, "shared-retained");
        await assert.rejects(readModelArtifacts(reader, store, { runId: affected.runId, slots: [slots[0]] }), refusal("model-read-status-refused"));
        const result = await readModelArtifacts(reader, store, { runId: live.runId, slots: [slots[0], slots[2]] });
        assert.equal(result.value.files.length, 2);
        return { invalidatedRunRefused: true, unaffectedRunDelivered: true, tombstonedSharedReportDelivered: true };
      });
      await check("missing/mismatched bytes, calculation failures and Q2 connection loss release no result", async () => {
        const run = await world(), request = { runId: run.runId, slots: [slots[0]] };
        let delivered = false, calculations = 0;
        for (const get of [async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, async () => Buffer.alloc(1)]) {
          const before = queryCounts.reader;
          await assert.rejects(withModelArtifacts(reader, { get }, request, () => { calculations++; return "secret"; })
            .then(value => { delivered = true; return value; }), refusal("model-artifact-unavailable"));
          assert.equal(queryCounts.reader - before, 1);
        }
        const calculationFailure = new Error("private calculation failed");
        await assert.rejects(withModelArtifacts(reader, store, request, () => { throw calculationFailure; }), error => error === calculationFailure);
        let calls = 0; const lost = new Error("Q2 socket lost");
        const failQ2 = { query: async (...args: unknown[]) => {
          if (++calls === 2) throw lost; return Reflect.apply(reader.query, reader, args);
        } } as Pick<Client, "query">;
        await assert.rejects(withModelArtifacts(failQ2, store, request, () => "secret").then(value => { delivered = true; return value; }), error => error === lost);
        assert.equal(delivered, false); assert.equal(calculations, 0); assert.equal(calls, 2);
        return { delivered, missingOrMismatchedBeforeCalculation: true, failedCalculationWithheld: true, lostQ2Withheld: true };
      });
      await check("caller/callback mutation cannot change the final authorization identity; context work composes once", async () => {
        const run = await world(), selection: ModelArtifactSlot[] = [slots[0]];
        const request: ModelReadRequest = { runId: run.runId, slots: selection };
        const start = queryCounts.reader;
        await assert.rejects(withModelArtifacts(reader, store, request, async input => {
          request.runId = randomUUID(); request.slots = [];
          selection.length = 0;
          input.run.runId = randomUUID(); input.artifacts.length = 0;
          // Placeholder for #167's one context lookup, inside this guard.
          await reader.query("SELECT 1 AS context_control");
          await rights(run.source.profile, false); return "private context calculation";
        }), refusal("model-current-rights-refused"));
        assert.equal(queryCounts.reader - start, 3);
        await rights(run.source.profile, true);
        const begin = queryCounts.reader;
        const allowed = await withModelArtifacts(reader, store, { runId: run.runId, slots: [slots[0]] }, async input => {
          const context = (await reader.query("SELECT 7 AS context_control")).rows[0].context_control;
          return { context, bytes: input.files[0].bytes.length };
        });
        assert.equal(queryCounts.reader - begin, 3); assert.equal(allowed.value.context, 7); assert(allowed.value.bytes > 0);
        return { boundaryAuthorizationSql: 2, explicitContextControlSql: 1, mutatedIdentityNotUsed: true,
          revokedResultWithheld: true, authorizedCalculationDelivered: true };
      });
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.failure = String(error); throw error; }
  finally {
    const paths = ["packages/db/proposals/166_artifact_governance.sql", "services/pipeline/src/featureStore/modelArtifacts.ts",
      "services/pipeline/src/featureStore/artifactGovernanceErrors.ts", "services/pipeline/package.json",
      "services/pipeline/tests/feature-store/artifact-governance-fixture.ts", "services/pipeline/tests/feature-store/artifact-read-work.ts",
      "services/pipeline/tests/feature-store/model-artifacts.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS166_READ_EVIDENCE) await writeFile(process.env.FS166_READ_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});
