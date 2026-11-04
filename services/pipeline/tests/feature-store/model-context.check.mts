import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { resolveModelContext, ModelContextError, type ModelContextRequest } from "../../src/featureStore/modelContext.ts";
import { ArtifactGovernanceError } from "../../src/featureStore/modelArtifacts.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

const mode = "retrospective-reconstruction-v1" as const;
const refusal = (code: string) => (error: unknown) => error instanceof ModelContextError && error.code === code;

test("#231 metadata-only point-in-time context and narrow capability", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [];
  const evidence: Record<string, unknown> = { issue: 231, step: 1, fixture: "synthetic metadata/role controls; real database knowledge clocks", probes };
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, createReaderConfig }) => {
      for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "231_composite_authorization.sql"])
        await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
      const config = await createReaderConfig();
      // A genuine LOGIN; no owner-session SET ROLE shortcut. The granted
      // capability itself has non-inheriting/non-settable broad membership.
      await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
      await admin.query(`GRANT fs231_model_reader TO ${config.user} WITH INHERIT TRUE, SET FALSE`);
      const scoped = new Client(config); await scoped.connect();
      try {
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { probes.push({ name, verdict: "pass", details: await run() }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const clock = async () => (await admin.query("SELECT clock_timestamp()::text AS now")).rows[0].now as string;
      const job = async () => (await startJob(writer, { kind: "features", codeSha: "a".repeat(40),
        policySha256: sha256(Buffer.from("#231 synthetic context")), inputSetSha256: sha256(Buffer.from(randomUUID())) })).jobId;
      const sourceJob = await job(), digest = sha256(Buffer.from(randomUUID()));
      const profile = "context-" + randomUUID();
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES($1,'synthetic','stats','context-test','{}')`, [profile]);
      const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,
        media_type,decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
        VALUES($1,$2,$3::text,0,'raw/'||$3::text,'text/csv',$3::text,$3::text,0,clock_timestamp(),clock_timestamp(),'prospective') RETURNING snapshot_id`,
      [profile, sourceJob, digest])).rows[0].snapshot_id as string;
      await finishJob(writer, sourceJob, { counts: {} });
      type Seed = { player?: string; game?: string; n?: number; unavailable?: boolean; failed?: boolean;
        mode?: string; version?: string; policy?: string; supersedes?: string; checkpoint?: string; emptyLineage?: boolean; running?: boolean };
      const seed = async (options: Seed = {}) => {
        const jobId = await job(), n = options.n ?? 3, usable = !options.unavailable && n >= 2;
        const history = Array.from({ length: n }, (_, i) => ({ gameId: `prior-${i}`, kickoff: "2024-01-01T00:00:00Z", yards: 100 + i }));
        const f = (await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,
          feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
          VALUES($1,$2,$3,'passing_yards',2025,'2025-09-01',coalesce($4::timestamptz,clock_timestamp()),$5,$6,$7,$8,$9,'{}',$10,$11,'[]',$12)
          RETURNING feature_id,job_id,player_id,game_id,computed_at::text,checkpoint::text`,
        [jobId, options.player ?? randomUUID(), options.game ?? "synthetic-future-target", options.checkpoint ?? null,
          options.version ?? FEATURE_VERSION, options.policy ?? HISTORY_POLICY, options.mode ?? mode,
          usable ? "usable" : "unavailable", usable ? [] : [n < 2 ? "insufficient-history" : "newer-unavailable"], n,
          JSON.stringify(history), options.supersedes ?? null])).rows[0] as {
            feature_id: string; job_id: string; player_id: string; game_id: string; computed_at: string; checkpoint: string };
        if (!options.emptyLineage) await writer.query("INSERT INTO fs138.feature_inputs VALUES($1,$2)", [f.feature_id, snapshot]);
        if (!options.running) await finishJob(writer, jobId, { counts: {}, ...(options.failed ? { errorCode: "synthetic-failure" } : {}) });
        const request: ModelContextRequest = { playerId: f.player_id, gameId: f.game_id, knownAsOf: await clock(),
          featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: (options.mode ?? mode) as typeof mode };
        return { ...f, request };
      };

        await check("one metadata statement at every n=2..16; no label/training eligibility, histories or rights release", async () => {
          const counts = [];
          for (let n = 2; n <= 16; n++) {
            const f = await seed({ n }); let statements = 0;
            const observed = { query: async (...args: Parameters<Client["query"]>) => {
              statements++; return Reflect.apply(scoped.query, scoped, args);
            } } as Pick<Client, "query">;
            const result = await resolveModelContext(observed, f.request);
            assert.equal(statements, 1); assert.equal(result.feature.featureId, f.feature_id);
            assert.equal(result.feature.sampleSize, n); assert.deepEqual(result.snapshotIds, [snapshot]);
            assert.deepEqual(Object.keys(result).sort(), ["feature", "freshness", "request", "selection", "snapshotIds"]);
            assert.deepEqual(Object.keys(result.feature).sort(), ["checkpoint", "computedAt", "cutoff", "evidenceMode", "featureId",
              "featureVersion", "flags", "gameId", "historyPolicy", "jobId", "playerId", "sampleSize", "season", "stat"]);
            assert.equal(result.selection.lastValid, false); assert.equal(result.freshness.stale, false);
            counts.push({ n, statements, rightsChecks: 0, historyReads: 0 });
          }
          const forbidden = (await admin.query(`SELECT (SELECT count(*) FROM fs138.outcome_labels)::integer AS labels,
            (SELECT count(*) FROM fs138.dataset_members)::integer AS members,
            (SELECT count(*) FROM fs138.rights_decisions)::integer AS decisions`)).rows[0];
          assert.deepEqual(forbidden, { labels: 0, members: 0, decisions: 0 });
          return { counts, ...forbidden };
        });
        await check("exact player/game/version/policy/mode, successful jobs and real knowledge visibility", async () => {
          const a = await seed({ player: "QB-A", game: "same-game" }), b = await seed({ player: "QB-B", game: "same-game" });
          for (const f of [a, b]) assert.equal((await resolveModelContext(scoped, f.request)).feature.featureId, f.feature_id);
          await assert.rejects(resolveModelContext(scoped, { ...a.request, gameId: "other-game" }), refusal("model-context-unavailable"));
          const failed = await seed({ failed: true });
          await assert.rejects(resolveModelContext(scoped, failed.request), refusal("model-context-unavailable"));
          const strict = await seed({ player: a.player_id, game: a.game_id, mode: "strict-point-in-time-v1" });
          await seed({ player: a.player_id, game: a.game_id, version: "another-version" });
          await seed({ player: a.player_id, game: a.game_id, policy: "another-policy" });
          assert.equal((await resolveModelContext(scoped, { ...a.request, knownAsOf: await clock() })).feature.featureId, a.feature_id);
          assert.equal((await resolveModelContext(scoped, strict.request)).feature.featureId, strict.feature_id);
          const earlier = (await admin.query("SELECT ($1::timestamptz-interval '1 microsecond')::text AS at", [a.computed_at])).rows[0].at;
          await assert.rejects(resolveModelContext(scoped, { ...a.request, knownAsOf: earlier }), refusal("model-context-unavailable"));
          return { twoDistinctQbs: true, exactScope: true, failedJobRefused: true, realMicroseconds: true };
        });
        await check("latest valid at knownAsOf, last-valid flags, later-known values never replace selection", async () => {
          const a = await seed(), pinned = await resolveModelContext(scoped, a.request);
          const b = await seed({ player: a.player_id, game: a.game_id, n: 8, supersedes: a.feature_id });
          const current = await resolveModelContext(scoped, b.request);
          assert.equal(current.feature.featureId, b.feature_id); assert.equal(current.feature.sampleSize, 8);
          const historical = await resolveModelContext(scoped, a.request);
          assert.deepEqual(historical.feature, pinned.feature); assert.equal(historical.selection.lastValid, false);
          assert.equal(historical.freshness.superseded, true); assert.equal(historical.freshness.stale, false);
          const c = await seed({ player: a.player_id, game: a.game_id, unavailable: true, supersedes: b.feature_id });
          const last = await resolveModelContext(scoped, c.request);
          assert.equal(last.feature.featureId, b.feature_id); assert.equal(last.selection.lastValid, true);
          assert.deepEqual(last.selection.reasons, ["newer-unavailable"]); assert.equal(last.freshness.stale, true);
          assert.equal(last.freshness.headId, c.feature_id);
          const boundary = (await admin.query(`SELECT ($1::timestamptz-interval '1 microsecond')::text AS before,
            $1::timestamptz::text AS exact`, [(await admin.query("SELECT finished_at::text FROM fs138.job_runs WHERE job_id=$1", [b.job_id])).rows[0].finished_at])).rows[0];
          assert.equal((await resolveModelContext(scoped, { ...b.request, knownAsOf: boundary.before })).feature.featureId, a.feature_id);
          assert.equal((await resolveModelContext(scoped, { ...b.request, knownAsOf: boundary.exact })).feature.featureId, b.feature_id);
          // Checkpoint order precedes computed_at; a later computation for an
          // older checkpoint cannot displace the selected revision.
          await seed({ player: a.player_id, game: a.game_id, checkpoint: a.checkpoint });
          assert.equal((await resolveModelContext(scoped, { ...b.request, knownAsOf: await clock() })).feature.featureId, b.feature_id);
          // Insertion is not availability. Pin knowledge while the newer job
          // is running, then prove completing it cannot rewrite that answer.
          const previous = await seed();
          const pending = await seed({ player: previous.player_id, game: previous.game_id,
            n: 8, supersedes: previous.feature_id, running: true });
          const beforeFinish = await resolveModelContext(scoped, pending.request);
          assert.equal(beforeFinish.feature.featureId, previous.feature_id);
          assert.equal(beforeFinish.freshness.headId, previous.feature_id);
          await finishJob(writer, pending.job_id, { counts: {} });
          const afterFinish = await resolveModelContext(scoped, pending.request);
          assert.deepEqual(afterFinish.feature, beforeFinish.feature);
          assert.deepEqual(afterFinish.selection, beforeFinish.selection);
          assert.equal(afterFinish.freshness.headId, pending.feature_id);
          const clocks = (await admin.query(`SELECT f.computed_at::text,j.finished_at::text,
            f.computed_at < $2::timestamptz AND $2::timestamptz < j.finished_at AS between
            FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id) WHERE f.feature_id=$1`,
          [pending.feature_id, pending.request.knownAsOf])).rows[0];
          assert.equal(clocks.between, true);
          assert.equal((await resolveModelContext(scoped, { ...pending.request, knownAsOf: await clock() })).feature.featureId, pending.feature_id);
          return { selected: b.feature_id, unavailable: c.feature_id, boundary, lastValid: true, laterValueWithheld: true,
            usableKnowledgeTime: { ...clocks, knownAsOf: pending.request.knownAsOf, sameSelectionBeforeAndAfterFinish: true,
              visibleHeadUnchanged: true, currentHeadRefreshed: true } };
        });
        await check("typed refusals at both TypeScript and direct SQL boundaries", async () => {
          const f = await seed(); let noSql = 0;
          const never = { query: async () => { noSql++; throw new Error("unexpected SQL"); } } as unknown as Pick<Client, "query">;
          for (const patch of [{ playerId: "" }, { gameId: " " }, { knownAsOf: "infinity" }, { knownAsOf: "2025-01-01" }])
            await assert.rejects(resolveModelContext(never, { ...f.request, ...patch }), refusal("model-context-request-refused"));
          for (const patch of [{ featureVersion: "unknown" }, { historyPolicy: "unknown" }, { evidenceMode: "unknown" }])
            await assert.rejects(resolveModelContext(never, { ...f.request, ...patch } as ModelContextRequest), refusal("model-context-unsupported-version"));
          assert.equal(noSql, 0);
          await assert.rejects(resolveModelContext(scoped, { ...f.request, knownAsOf: "2025-02-30T00:00:00Z" }), refusal("model-context-request-refused"));
          await assert.rejects(resolveModelContext(scoped, { ...f.request, knownAsOf: "2099-01-01T00:00:00Z" }), refusal("model-context-future-knowledge"));
          for (const n of [0, 1]) await assert.rejects(resolveModelContext(scoped, (await seed({ n })).request), refusal("model-context-insufficient-history"));
          await assert.rejects(resolveModelContext(scoped, (await seed({ unavailable: true })).request), refusal("model-context-unavailable"));
          await assert.rejects(resolveModelContext(scoped, (await seed({ emptyLineage: true })).request), refusal("model-context-lineage-refused"));
          const values: unknown[] = [f.player_id, f.game_id, FEATURE_VERSION, HISTORY_POLICY, mode, f.request.knownAsOf];
          const direct = (pins: unknown[]) => scoped.query("SELECT fs138.resolve_model_context($1,$2,$3,$4,$5,$6)", pins);
          for (const [position, value, code] of [[0, null, "P2311"], [1, " ", "P2311"], [5, "infinity", "P2311"],
            [2, null, "P2312"], [3, "unknown", "P2312"], [4, null, "P2312"], [5, "2099-01-01", "P2313"]] as const) {
            const pins = [...values]; pins[position] = value; await assert.rejects(direct(pins), { code });
          }
          await scoped.query("SET default_transaction_isolation='repeatable read'");
          try { await assert.rejects(resolveModelContext(scoped, f.request), error =>
            error instanceof ArtifactGovernanceError && error.code === "model-read-session-refused"); }
          finally { await scoped.query("RESET default_transaction_isolation"); }
          return { malformedApiSql: noSql, typedSqlRefusals: 7, insufficientHistory: [0, 1], snapshotIsolationRefused: true };
        });
        await check("real LOGIN can only execute the narrow metadata surface; PUBLIC/role-switch bypasses refuse", async () => {
          const refused = [];
          for (const table of ["feature_values", "feature_inputs", "outcome_labels", "label_inputs", "norm_player_game_stats",
            "source_snapshots", "normalized_evidence", "rights_decisions", "model_runs", "dataset_manifests"]) {
            await assert.rejects(scoped.query(`SELECT * FROM fs138.${table} LIMIT 0`), { code: "42501" }); refused.push(table);
          }
          for (const sql of ["DELETE FROM fs138.feature_inputs", "INSERT INTO fs138.feature_values DEFAULT VALUES",
            "SELECT fs138.delete_sources('{}','refused',0)", "SELECT fs138.delete_datasets('{}','refused',0)",
            "SELECT fs138.publish_model_run('{}','[]')", "SELECT fs138.authorize_model_read(NULL,ARRAY['descriptor'],true)",
            "SET ROLE fs138_reader", "SET ROLE fs138_pipeline_writer", "SET ROLE fs231_model_reader"])
            { await assert.rejects(scoped.query(sql), { code: "42501" }); refused.push(sql); }
          const login = (await scoped.query("SELECT session_user,current_user")).rows[0];
          assert.equal(login.session_user, config.user); assert.equal(login.current_user, config.user);
          const membership = (await admin.query(`SELECT inherit_option,set_option FROM pg_auth_members
            WHERE roleid='fs138_reader'::regrole AND member='fs231_model_reader'::regrole`)).rows[0];
          assert.deepEqual(membership, { inherit_option: false, set_option: false });
          const capability = (await admin.query(`SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls
            FROM pg_roles WHERE rolname='fs231_model_reader'`)).rows[0];
          assert(Object.values(capability).every(v => v === false));
          const publicExecute = (await admin.query(`SELECT count(*)::integer AS n FROM pg_proc p,
            LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE p.oid='fs138.resolve_model_context(text,text,text,text,text,timestamptz)'::regprocedure
            AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows[0].n;
          assert.equal(publicExecute, 0);
          const outsiderConfig = await createReaderConfig(); await admin.query(`REVOKE fs138_reader FROM ${outsiderConfig.user}`);
          const outsider = new Client(outsiderConfig); await outsider.connect();
          try { await assert.rejects(resolveModelContext(outsider, (await seed()).request), { code: "42501" }); }
          finally { await outsider.end(); }
          // Broad model-only readers retain access to the metadata capability.
          assert((await resolveModelContext(reader, (await seed()).request)).feature.featureId);
          return { login, membership, capability, publicExecute, refused: refused.length };
        });
        await check("indexed metadata work, zero reader DML/rights/history expansion and no transaction after resolution", async () => {
          const f = await seed();
          // Observer wrapper sees work inside SECURITY DEFINER. It has no effect
          // on the request API's one-statement budget and is never a timing path.
          await admin.query(`CREATE FUNCTION fs138.context_work() RETURNS jsonb LANGUAGE sql VOLATILE AS $$
            SELECT jsonb_agg(jsonb_build_object('table',relname,'read',seq_tup_read+coalesce(idx_tup_fetch,0),
            'writes',n_tup_ins+n_tup_upd+n_tup_del) ORDER BY relname) FROM pg_stat_xact_user_tables WHERE schemaname='fs138' $$;
            CREATE FUNCTION fs138.measure_context(player text,game text,known timestamptz) RETURNS jsonb
            LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
            DECLARE before jsonb; after jsonb; result jsonb; locks jsonb; BEGIN
            before:=fs138.context_work();
            result:=fs138.resolve_model_context(player,game,'${FEATURE_VERSION}','${HISTORY_POLICY}','${mode}',known);
            after:=fs138.context_work();
            SELECT coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode)),'[]') INTO locks FROM pg_locks
            WHERE pid=pg_backend_pid() AND (locktype IN ('advisory','tuple','transactionid')
             OR (locktype='relation' AND mode<>'AccessShareLock'));
            RETURN jsonb_build_object('before',before,'after',after,'locks',locks,'result',result); END $$;
            REVOKE ALL ON FUNCTION fs138.context_work(),fs138.measure_context(text,text,timestamptz) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION fs138.measure_context(text,text,timestamptz) TO fs231_model_reader`);
          try {
            const m = (await scoped.query("SELECT fs138.measure_context($1,$2,$3) AS m", [f.player_id, f.game_id, f.request.knownAsOf])).rows[0].m;
            assert.deepEqual(m.locks, []);
            const delta = m.after.map((row: { table: string; read: number; writes: number }) => {
              const old = m.before.find((r: { table: string }) => r.table === row.table);
              return { table: row.table, read: row.read - old.read, writes: row.writes - old.writes };
            });
            for (const row of delta) {
              assert.equal(row.writes, 0);
              if (!['feature_values', 'feature_inputs', 'job_runs'].includes(row.table)) assert.equal(row.read, 0, row.table);
            }
            const pid = (await scoped.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const activity = (await admin.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
            assert.deepEqual(activity, { state: "idle", xact_start: null });
            const definition = (await admin.query(`SELECT pg_get_functiondef('fs138.resolve_model_context(text,text,text,text,text,timestamptz)'::regprocedure) AS sql`)).rows[0].sql;
            const statements = definition.replace(/--[^\n]*/g, "");
            assert(!/\bf\.\*|f\.history\b|history_gaps|jsonb_array_elements|effective_rights|outcome_labels|dataset_members|FOR (UPDATE|SHARE)|pg_advisory/i.test(statements));
            const plan = (await admin.query(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON)
              SELECT f.feature_id FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
              WHERE (f.player_id,f.game_id,f.stat,f.feature_version,f.history_policy,f.evidence_mode)=($1,$2,'passing_yards',$3,$4,$5)
              AND f.computed_at<=$6 AND f.checkpoint<=$6 AND j.status='succeeded' AND f.state='usable'
              ORDER BY f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC LIMIT 1`,
            [f.player_id, f.game_id, FEATURE_VERSION, HISTORY_POLICY, mode, f.request.knownAsOf])).rows[0]["QUERY PLAN"];
            assert(JSON.stringify(plan).includes('feature_head'));
            return { delta, plan, forbiddenLocks: m.locks, activity, rightsCalls: 0 };
          } finally { await admin.query("DROP FUNCTION fs138.measure_context(text,text,timestamptz); DROP FUNCTION fs138.context_work()"); }
        });
      } finally { await scoped.end(); }
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.error = String(error); throw error; }
  finally {
    const paths = ["packages/db/proposals/231_composite_authorization.sql", "packages/db/package.json",
      "services/pipeline/src/featureStore/modelContext.ts", "services/pipeline/package.json",
      "services/pipeline/tests/feature-store/model-context.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS231_CONTEXT_EVIDENCE) await writeFile(process.env.FS231_CONTEXT_EVIDENCE,
      JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  }
});
