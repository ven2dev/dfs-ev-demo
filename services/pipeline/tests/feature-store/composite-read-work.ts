import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import type { ModelContext } from "../../src/featureStore/modelContext.ts";
import { readCounterDelta, type ReadCounters } from "./artifact-read-work.ts";

// Measurement only: retain the original SQL function behind a non-inlined
// PL/pgSQL notice. Notices survive a refused statement's rollback, so the oracle
// sees rights calls on refusals too. No writes or observer queries in timings.
export const installCompositeWorkOracle = async (admin: Client) => {
  const sql = await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/163_effective_rights.sql")), "utf8");
  await admin.query(sql.replace("CREATE FUNCTION fs138.effective_rights", "CREATE FUNCTION fs138.composite_original_rights"));
  await admin.query(`CREATE OR REPLACE FUNCTION fs138.effective_rights(p_profile text,p_valid_at timestamptz,p_known_at timestamptz)
    RETURNS TABLE(decision_id uuid,allowed_uses text[]) LANGUAGE plpgsql STABLE AS $$ BEGIN
    RAISE NOTICE 'fs231-rights:%',p_profile;
    RETURN QUERY SELECT * FROM fs138.composite_original_rights(p_profile,p_valid_at,p_known_at); END $$;
    CREATE FUNCTION fs138.composite_counters() RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,fs138 AS $$
    SELECT jsonb_agg(jsonb_build_object('table',relname,'seq_scan',seq_scan,'seq_tup_read',seq_tup_read,
     'idx_scan',coalesce(idx_scan,0),'idx_tup_fetch',coalesce(idx_tup_fetch,0),
     'inserted',n_tup_ins,'updated',n_tup_upd,'deleted',n_tup_del) ORDER BY relname)
    FROM pg_stat_xact_user_tables WHERE schemaname='fs138' $$;
    CREATE FUNCTION fs138.measure_composite_read(id uuid,context jsonb,pins boolean,negative text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
    DECLARE before jsonb; after jsonb; result jsonb; forbidden jsonb; BEGIN
    before:=fs138.composite_counters();
    IF negative='scan' THEN PERFORM history FROM fs138.feature_values;
    ELSIF negative='dml' THEN INSERT INTO fs138.orphan_observations VALUES('audits/'||repeat('d',64),clock_timestamp());
    ELSE result:=fs138.authorize_model_context_read(id,ARRAY['descriptor'],pins,context); END IF;
    after:=fs138.composite_counters();
    SELECT coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode)),'[]') INTO forbidden FROM pg_locks
    WHERE pid=pg_backend_pid() AND (locktype IN ('advisory','tuple','transactionid') OR (locktype='relation' AND mode<>'AccessShareLock'));
    RETURN jsonb_build_object('before',before,'after',after,'result',result,'forbiddenLocks',forbidden);END $$;
    REVOKE ALL ON FUNCTION fs138.composite_original_rights(text,timestamptz,timestamptz),fs138.composite_counters(),
     fs138.measure_composite_read(uuid,jsonb,boolean,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fs138.composite_original_rights(text,timestamptz,timestamptz) TO fs138_reader,fs138_pipeline_writer;
    GRANT EXECUTE ON FUNCTION fs138.measure_composite_read(uuid,jsonb,boolean,text) TO fs231_model_reader`);
  return async () => {
    await admin.query(sql.replace("CREATE FUNCTION fs138.effective_rights", "CREATE OR REPLACE FUNCTION fs138.effective_rights"));
    await admin.query(`DROP FUNCTION fs138.measure_composite_read(uuid,jsonb,boolean,text);
      DROP FUNCTION fs138.composite_counters();DROP FUNCTION fs138.composite_original_rights(text,timestamptz,timestamptz)`);
  };
};

export const observeRightsCalls = (client: Client) => {
  const profiles: string[] = [];
  const onNotice = (notice: { message?: string }) => {
    if (notice.message?.startsWith("fs231-rights:")) profiles.push(notice.message.slice("fs231-rights:".length));
  };
  client.on("notice", onNotice);
  return { reset: () => { profiles.length = 0; }, profiles,
    close: () => client.removeListener("notice", onNotice) };
};
export const unionProfiles = async (admin: Client, runId: string, featureId: string) =>
  (await admin.query(`SELECT DISTINCT s.profile_id FROM (
    SELECT i.snapshot_id FROM fs138.model_run_datasets p JOIN fs138.dataset_inputs i USING(dataset_id) WHERE run_id=$1
    UNION SELECT snapshot_id FROM fs138.feature_inputs WHERE feature_id=$2
   ) u JOIN fs138.source_snapshots s USING(snapshot_id) ORDER BY s.profile_id`, [runId, featureId])).rows.map(r => r.profile_id as string);
export const assertCompositeWork = (delta: ReadCounters) => {
  for (const row of delta) {
    assert.equal(row.inserted + row.updated + row.deleted, 0, `${row.table}: reader DML`);
    if (/^(dataset_members|outcome_labels|label_inputs|norm_)/.test(row.table))
      assert(Object.entries(row).filter(([key]) => key !== "table").every(([, value]) => value === 0), `${row.table}: hidden example work`);
  }
};
export const measureCompositeWork = async (client: Pick<Client, "query">, runId: string, context: ModelContext, pins: boolean, negative?: string) => {
  const m = (await client.query<{ measured: { before: ReadCounters; after: ReadCounters; forbiddenLocks: unknown[] } }>(
    "SELECT fs138.measure_composite_read($1,$2,$3,$4) AS measured", [runId, context, pins, negative ?? null])).rows[0].measured;
  if (!negative) assert.deepEqual(m.forbiddenLocks, []);
  return readCounterDelta(m.before, m.after);
};
