import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION } from "@dfs-ev/domain/qb-evaluation";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { PREREGISTRATION } from "../../scripts/feature-store/evaluation-fixture.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

const code = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from("synthetic #165 SQL fixture")) };
const identity = {
  format: "qb-model-run-v1", designation: "uncalibrated-interim-hit-rate", modelVersion: MODEL_VERSION,
  featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
  scoringPolicy: QB_EVALUATOR_VERSION, adapter: EMPIRICAL_ADAPTER,
  preregistration: { ...PREREGISTRATION, commit: "6aa7953dfd0df0c9bf879c2be64e94eaa2c55a3f" }, code,
};
const modes = ["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const;
type Mode = typeof modes[number];
type ObjectPin = { slot: "descriptor" | Mode; datasetId: string | null; objectKey: string; fileSha256: string; byteSize: number };
type Budget = { table: string; inserted: number; updated: number; deleted: number }[];
const writes = async (client: Pick<Client, "query">): Promise<Budget> =>
  (await client.query(`SELECT relname AS "table",n_tup_ins::integer AS inserted,n_tup_upd::integer AS updated,n_tup_del::integer AS deleted
    FROM pg_stat_xact_user_tables WHERE schemaname='fs138' AND (n_tup_ins+n_tup_upd+n_tup_del)>0 ORDER BY relname`)).rows;
const writeDelta = (before: Budget, after: Budget): Budget => after.map(row => {
  const previous = before.find(p => p.table === row.table);
  return { table: row.table, inserted: row.inserted - (previous?.inserted ?? 0),
    updated: row.updated - (previous?.updated ?? 0), deleted: row.deleted - (previous?.deleted ?? 0) };
}).filter(row => row.inserted + row.updated + row.deleted > 0);
const probes: { name: string; verdict: string; details: unknown }[] = [];
const evidence: Record<string, unknown> = { issue: 165, step: 1, runtime: process.version,
  fixture: "synthetic 0/2504-example pinned datasets; same source profile, real PostgreSQL clocks and LOGINs",
  scope: "proposal SQL contract and server DML work only; no ObjectStore orchestration or report-envelope provenance pass", probes };
const pin = (slot: ObjectPin["slot"], datasetId: string | null): ObjectPin => {
  const fileSha256 = sha256(Buffer.from(JSON.stringify({ slot, datasetId, token: randomUUID() })));
  return { slot, datasetId, fileSha256, objectKey: `${slot === "descriptor" ? "models" : "audits"}/${fileSha256}`, byteSize: 128 };
};

test("#165 immutable pipeline-only manifests and database-side work budgets", { timeout: 120_000 }, async t => {
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, openWriter }) => {
      const check = async (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); probes.push({ name, verdict: "pass", details }); }
          catch (error) {
            probes.push({ name, verdict: "fail", details: String(error) });
            await writer.query("ROLLBACK"); throw error;
          }
      });
      const proposal = await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/165_model_manifests.sql")), "utf8");
      evidence.proposalSha256 = sha256(Buffer.from(proposal));
      const paths = ["packages/db/proposals/165_model_manifests.sql", "packages/db/package.json",
        "services/pipeline/tests/feature-store/model-manifests.check.mts", "services/pipeline/scripts/feature-store/harness.ts"];
      evidence.codeHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
        [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
      evidence.database = (await admin.query("SELECT version() AS version")).rows[0].version;
      await check("proposal DDL rolls back and leaves the frozen main catalog untouched", async () => {
        await admin.query("BEGIN");
        try { await admin.query(proposal); } finally { await admin.query("ROLLBACK"); }
        assert.equal((await admin.query("SELECT to_regclass('fs138.model_runs') AS table")).rows[0].table, null);
        await admin.query(proposal);
        return { rollbackRemovedNewTables: true, proposalOnly: true };
      });
      // Fixture only: SQL-owned source and two pinned datasets, with 2504 actual
      // feature/label/member rows for the nonempty cohort. No fake row_count-only proof.
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES('model-fixture','synthetic','stats','synthetic-v1','{"scope":"local test only"}')`);
      const grant = (allowed: boolean) => writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        VALUES('model-fixture',$1::text[],'2020-01-01','synthetic local test only')`, [allowed ? ["research"] : []]);
      await grant(true);
      const job = (await writer.query(`INSERT INTO fs138.job_runs(kind,code_sha,policy_sha256,input_set_sha256)
        VALUES('model',$1,$2,$2) RETURNING job_id`, [code.gitSha, code.contentSha256])).rows[0].job_id;
      const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
        decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
        VALUES('model-fixture',$1,$2,1,$3,'text/csv',$2,$2,2504,'2020-01-01','2020-01-01','retrospective') RETURNING snapshot_id`,
      [job, code.contentSha256, `raw/${code.contentSha256}`])).rows[0].snapshot_id;
      const ids: string[] = [];
      for (const [index, mode] of modes.entries()) {
        const spec = { mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
          featuresAsOf: new Date().toISOString(), labelsAsOf: new Date().toISOString(), includeRetrospective: index === 1, includeSuperseded: true };
        const id = (await writer.query(`INSERT INTO fs138.dataset_manifests(code_sha,implementation_sha256,spec,input_sha256,file_sha256,
          object_key,byte_size,row_count,exclusions,rights_receipt,content_sha256)
          VALUES($1,$2,$3,$2,$4,$5,128,$6,'{}','{}',$4) RETURNING dataset_id`,
        [code.gitSha, code.contentSha256, spec, sha256(Buffer.from(mode)), `datasets/${sha256(Buffer.from(mode))}`, index === 0 ? 0 : 2504])).rows[0].dataset_id;
        ids.push(id);
        await writer.query("INSERT INTO fs138.dataset_inputs VALUES($1,$2)", [id, snapshot]);
      }
      await writer.query(`WITH features AS(
        INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,
          evidence_mode,state,reasons,flags,sample_size,history,history_gaps)
        SELECT $1,'test-qb-'||n,'test-game-'||n,'passing_yards',2022,'2022-01-01',clock_timestamp(),$2,$3,$4,'usable','{}',
          ARRAY['historical-availability-unverified'],2,'[{"gameId":"h1","kickoff":"2021-01-01","yards":100},{"gameId":"h2","kickoff":"2021-01-02","yards":200}]','[]'
        FROM generate_series(1,2504) n RETURNING feature_id,player_id,game_id
      ), labels AS(
        INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value)
        SELECT $1,player_id,game_id,'passing_yards',2022,clock_timestamp(),$5,$4,'usable','{}',ARRAY['historical-availability-unverified'],250
        FROM features RETURNING label_id,player_id
      ) INSERT INTO fs138.dataset_members SELECT $6,feature_id,label_id FROM features JOIN labels USING(player_id)`,
      [job, FEATURE_VERSION, HISTORY_POLICY, modes[1], LABEL_VERSION, ids[1]]);
      assert.deepEqual((await writer.query("SELECT d.row_count,count(m.feature_id)::integer AS actual FROM fs138.dataset_manifests d LEFT JOIN fs138.dataset_members m USING(dataset_id) GROUP BY d.dataset_id ORDER BY d.row_count")).rows,
        [{ row_count: 0, actual: 0 }, { row_count: 2504, actual: 2504 }]);
      const objectsFor = (indexes: number[]) => [pin("descriptor", null), ...indexes.map(i => pin(modes[i], ids[i]))];
      const publish = async (objects: ObjectPin[], value: unknown = identity) =>
        (await writer.query("SELECT * FROM fs138.publish_model_run($1::jsonb,$2::jsonb)", [JSON.stringify(value), JSON.stringify(objects)])).rows[0];
      const runCounts = async () => (await admin.query(`SELECT (SELECT count(*)::integer FROM fs138.model_runs) AS runs,
        (SELECT count(*)::integer FROM fs138.model_run_datasets) AS datasets,(SELECT count(*)::integer FROM fs138.model_artifacts) AS artifacts`)).rows[0];
      await check("manifest pins SQL-owned datasets, supported identities, DB clock and exact object metadata", async () => {
        const objects = objectsFor([0, 1]);
        const before = (await admin.query("SELECT clock_timestamp() AS now")).rows[0].now;
        const run = await publish(objects);
        const after = (await admin.query("SELECT clock_timestamp() AS now")).rows[0].now;
        assert.deepEqual(run.identity, identity); assert(run.recorded_at >= before && run.recorded_at <= after);
        assert.equal(run.rights_receipt.decisions.length, 1);
        const pins = (await writer.query("SELECT * FROM fs138.model_run_datasets WHERE run_id=$1 ORDER BY row_count", [run.run_id])).rows;
        assert.equal(pins.length, 2);
        for (const p of pins) {
          const d = (await writer.query("SELECT * FROM fs138.dataset_manifests WHERE dataset_id=$1", [p.dataset_id])).rows[0];
          assert.deepEqual(p.spec, d.spec); assert.equal(p.file_sha256, d.file_sha256); assert.equal(p.content_sha256, d.content_sha256);
          assert.equal(p.row_count, d.row_count); assert.equal(+p.dataset_recorded_at, +d.recorded_at);
        }
        const artifacts = (await writer.query("SELECT slot,dataset_id,object_key,file_sha256,byte_size FROM fs138.model_artifacts WHERE run_id=$1 ORDER BY slot", [run.run_id])).rows;
        assert.equal(artifacts.length, 3);
        for (const o of objects) assert.deepEqual(artifacts.find(a => a.slot === o.slot), { slot: o.slot, dataset_id: o.datasetId,
          object_key: o.objectKey, file_sha256: o.fileSha256, byte_size: o.byteSize });
        return { datasetPins: pins.length, artifacts: artifacts.length, dbClock: true, identityVerified: true };
      });
      await check("real non-pipeline LOGIN cannot read/publish/enroll/guard or mutate any manifest table", async () => {
        const login = (await reader.query("SELECT session_user,current_user,pg_has_role(session_user,'fs138_pipeline_writer','member') AS pipeline")).rows[0];
        assert.equal(login.session_user, login.current_user); assert.equal(login.pipeline, false);
        let refusals = 0;
        for (const table of ["model_runs", "model_run_datasets", "model_artifacts"]) for (const sql of [
          `SELECT * FROM fs138.${table}`, `INSERT INTO fs138.${table} DEFAULT VALUES`, `UPDATE fs138.${table} SET run_id=run_id`, `DELETE FROM fs138.${table}`,
        ]) { await assert.rejects(reader.query(sql), { code: "42501" }); refusals++; }
        for (const sql of ["SELECT fs138.publish_model_run('{}','[]')", "SELECT fs138.enroll_model_objects('{}')", "SELECT fs138.guard_model_publication('{}','{}')"])
          { await assert.rejects(reader.query(sql), { code: "42501" }); refusals++; }
        return { ...login, refusals };
      });
      await check("ordinary pipeline credentials cannot forge clocks or directly change immutable identities", async () => {
        let refusals = 0;
        for (const table of ["model_runs", "model_run_datasets", "model_artifacts"]) for (const sql of [
          `INSERT INTO fs138.${table} DEFAULT VALUES`, `UPDATE fs138.${table} SET run_id=run_id`, `DELETE FROM fs138.${table}`,
        ]) { await assert.rejects(writer.query(sql), { code: "42501" }); refusals++; }
        await assert.rejects(writer.query("INSERT INTO fs138.model_runs(identity,recorded_at,rights_receipt) VALUES($1,'2000-01-01','{}')", [identity]), { code: "42501" });
        return { refusals: refusals + 1 };
      });
      await check("unsupported identities, backdated extra fields and mismatched mode/key/size are refused atomically", async () => {
        const before = await runCounts(); let refusals = 0;
        for (const mutated of [{ ...identity, modelVersion: "unknown" }, { ...identity, recorded_at: "2000-01-01" },
          { ...identity, code: { gitSha: "bad", contentSha256: code.contentSha256 } }, { ...identity, scoringPolicy: "tuned-after-evaluation" },
          { ...identity, preregistration: { ...identity.preregistration, sha256: "0".repeat(64) } }]) {
          await assert.rejects(publish(objectsFor([1]), mutated), /model-identity/); refusals++;
        }
        const original = objectsFor([1]);
        for (const objects of [
          [original[0], { ...original[1], datasetId: ids[0] }],
          [{ ...original[0], objectKey: original[1].objectKey }, original[1]],
          [original[0], { ...original[1], byteSize: -1 }],
          [original[0], { ...original[1], byteSize: 1.5 }],
          [original[0], { ...original[1], fileSha256: "b".repeat(64) }],
          [original[0], { ...original[1], knownAt: "2000-01-01" }],
        ]) { await assert.rejects(publish(objects), /model-(?:artifacts|report-dataset-mode)-refused/); refusals++; }
        assert.deepEqual(await runCounts(), before); return { refusals, partialRows: false };
      });
      await check("missing, invalidated, unsupported datasets and current withdrawn inputs refuse publication", async () => {
        const before = await runCounts();
        await assert.rejects(publish([pin("descriptor", null), pin(modes[1], randomUUID())]), /model-dataset/);
        await admin.query("UPDATE fs138.dataset_manifests SET invalidated_at=clock_timestamp() WHERE dataset_id=$1", [ids[1]]);
        await assert.rejects(publish(objectsFor([1])), /model-dataset/);
        await admin.query("UPDATE fs138.dataset_manifests SET invalidated_at=NULL,spec=jsonb_set(spec,'{featureVersion}','\"unknown\"') WHERE dataset_id=$1", [ids[1]]);
        await assert.rejects(publish(objectsFor([1])), /model-dataset-version/);
        await admin.query("UPDATE fs138.dataset_manifests SET spec=jsonb_set(spec,'{featureVersion}',to_jsonb($2::text)) WHERE dataset_id=$1", [ids[1], FEATURE_VERSION]);
        await grant(false); await assert.rejects(publish(objectsFor([1])), /model-current-rights/); await grant(true);
        await admin.query("UPDATE fs138.source_snapshots SET deleted_at=clock_timestamp() WHERE snapshot_id=$1", [snapshot]);
        await assert.rejects(publish(objectsFor([1])), /source-deleted-or-missing/);
        await admin.query("UPDATE fs138.source_snapshots SET deleted_at=NULL WHERE snapshot_id=$1", [snapshot]);
        assert.deepEqual(await runCounts(), before); return { refusedStates: 5, partialRows: false };
      });
      await check("CI server-side row writes are exact and identical for 0 and 2504 real dataset members", async () => {
        const budgets: { rows: number; enrollment: Budget; publication: Budget }[] = [];
        for (const i of [0, 1]) {
          const objects = objectsFor([i]), addresses = objects.map(o => o.objectKey);
          // These are measurement transactions. The real orchestrator will HEAD
          // before enrollment, upload outside the publication transaction, then HEAD
          // inside publication. This step proves SQL's complete server DML budget.
          await writer.query("BEGIN");
          const beforeEnrollment = await writes(writer);
          await writer.query("SELECT fs138.enroll_model_objects($1)", [addresses]);
          const enrollment = writeDelta(beforeEnrollment, await writes(writer));
          assert.deepEqual(enrollment, [{ table: "orphan_observations", inserted: 2, updated: 0, deleted: 0 }]);
          await writer.query("COMMIT");
          await writer.query("BEGIN");
          try {
            const beforePublication = await writes(writer);
            await writer.query("SELECT fs138.guard_model_publication($1,$2)", [[ids[i]], addresses]);
            assert.deepEqual(writeDelta(beforePublication, await writes(writer)), [], "guard cannot hide DML inside a definer function");
            await publish(objects);
            const publication = writeDelta(beforePublication, await writes(writer));
            assert.deepEqual(publication, [
              { table: "model_artifacts", inserted: 2, updated: 0, deleted: 0 },
              { table: "model_run_datasets", inserted: 1, updated: 0, deleted: 0 },
              { table: "model_runs", inserted: 1, updated: 0, deleted: 0 },
              { table: "orphan_observations", inserted: 0, updated: 0, deleted: 2 },
            ]);
            budgets.push({ rows: i === 0 ? 0 : 2504, enrollment, publication });
            await writer.query("COMMIT");
          } catch (error) { await writer.query("ROLLBACK"); throw error; }
        }
        assert.deepEqual(budgets[0].publication, budgets[1].publication);
        assert.deepEqual(budgets[0].enrollment, budgets[1].enrollment);
        evidence.serverWork = budgets;
        return { measuredBy: "pg_stat_xact_user_tables on publishing LOGIN", budgets };
      });
      await check("direct SQL publication rechecks current rights after an address lock wait", async () => {
        const objects = objectsFor([1]), blocker = await openWriter();
        const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("BEGIN");
        await blocker.query("SELECT fs138.lock_object_for_publication($1)", [objects[0].objectKey]);
        const pending = publish(objects).then(value => ({ value, error: null }), error => ({ value: null, error }));
        let waiting = false;
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            const state = (await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
            if (state.wait_event_type === "Lock") { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert(waiting, "publication must actually wait behind the other address holder");
          await admin.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
            VALUES('model-fixture','{}','2020-01-01','synthetic revocation during address wait')`);
        } finally { await blocker.query("COMMIT"); }
        const outcome = await pending;
        assert.match(String(outcome.error), /model-current-rights-refused/);
        await grant(true);
        return { actualLockWait: waiting, revokedWhileWaiting: true, publicationRefused: true };
      });
      await check("server work oracle observes hidden writes even when one client calls a definer function", async () => {
        // A test-only negative control proves these counters see DML inside SQL
        // functions, rather than merely counting returned manifest rows.
        await admin.query(`CREATE FUNCTION fs138.work_budget_negative_control(id uuid) RETURNS void
          LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
          UPDATE fs138.dataset_members SET dataset_id=dataset_id WHERE dataset_id=id
          $$`);
        await writer.query("BEGIN");
        try {
          const before = await writes(writer);
          await writer.query("SELECT fs138.work_budget_negative_control($1)", [ids[1]]);
          assert.deepEqual(writeDelta(before, await writes(writer)), [
            { table: "dataset_members", inserted: 0, updated: 2504, deleted: 0 },
          ]);
        } finally {
          await writer.query("ROLLBACK");
          await admin.query("DROP FUNCTION fs138.work_budget_negative_control(uuid)");
        }
        return { observedHiddenUpdates: 2504, clientFunctionCalls: 1, changesRolledBack: true };
      });
      await check("rollback restores enrollment and removes all partially inserted manifest associations", async () => {
        const objects = objectsFor([0, 1]);
        await writer.query("SELECT fs138.enroll_model_objects($1)", [objects.map(o => o.objectKey)]);
        const before = await runCounts();
        await writer.query("BEGIN"); await publish(objects); await writer.query("ROLLBACK");
        assert.deepEqual(await runCounts(), before);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.orphan_observations WHERE object_key=ANY($1)", [objects.map(o => o.objectKey)])).rows[0].n, 3);
        return { partialRows: false, enrolledAddresses: 3 };
      });
      await check("guard alone preserves cleanup enrollment; unregistered audits are not claimed", async () => {
        const objects = objectsFor([1]);
        await writer.query("SELECT fs138.enroll_model_objects($1)", [objects.map(o => o.objectKey)]);
        await writer.query("BEGIN");
        await writer.query("SELECT fs138.guard_model_publication($1,$2)", [[ids[1]], objects.map(o => o.objectKey)]);
        await writer.query("COMMIT");
        for (const o of objects) assert((await writer.query("SELECT fs138.orphan_recheck($1,0) AS ok", [o.objectKey])).rows[0].ok);
        const unregistered = pin(modes[0], ids[0]);
        assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,0) AS ok", [unregistered.objectKey])).rows[0].ok, false);
        assert.equal((await writer.query("SELECT count(*)::integer AS n FROM fs138.orphan_observations WHERE object_key=$1", [unregistered.objectKey])).rows[0].n, 0);
        return { guardDoesNotLoseEnrollment: true, unregisteredAddressNotEnrolled: true };
      });
      await check("committed references protect shared addresses and real pipeline grant has no role ownership", async () => {
        const objects = objectsFor([1]); await publish(objects);
        for (const o of objects) {
          await writer.query("SELECT fs138.enroll_model_objects($1)", [[o.objectKey]]);
          assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,0) AS ok", [o.objectKey])).rows[0].ok, false);
        }
        const login = await openWriter();
        assert.equal((await login.query("SELECT rolsuper OR rolcreaterole OR rolcreatedb AS privileged FROM pg_roles WHERE rolname=session_user")).rows[0].privileged, false);
        return { protectedObjects: 2, loginPrivileged: false };
      });
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.failure = String(error); throw error; }
  finally {
    if (process.env.FS165_SQL_EVIDENCE) await writeFile(process.env.FS165_SQL_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});
