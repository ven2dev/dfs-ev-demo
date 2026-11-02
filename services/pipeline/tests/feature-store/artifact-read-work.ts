import assert from "node:assert/strict";
import type { Client } from "pg";
import type { ModelArtifactSlot } from "../../src/featureStore/modelArtifacts.ts";

export type ReadCounters = { table: string; seq_scan: number; seq_tup_read: number; idx_scan: number;
  idx_tup_fetch: number; inserted: number; updated: number; deleted: number }[];
export const readCounterDelta = (before: ReadCounters, after: ReadCounters): ReadCounters => after.map(row => {
  const prior = before.find(p => p.table === row.table);
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === "number" ? value - (prior?.[key as keyof typeof prior] as number ?? 0) : value]));
}) as ReadCounters;
export const assertReadWork = (delta: ReadCounters) => {
  for (const row of delta) {
    assert.equal(row.inserted + row.updated + row.deleted, 0, `${row.table}: reader DML`);
    if (/^(dataset_members|feature_values|feature_inputs|outcome_labels|label_inputs|norm_)/.test(row.table))
      assert.deepEqual({ ...row, table: undefined }, { table: undefined, seq_scan: 0, seq_tup_read: 0,
        idx_scan: 0, idx_tup_fetch: 0, inserted: 0, updated: 0, deleted: 0 }, `${row.table}: hidden example-table work`);
  }
};
export const deterministicReadWork = (delta: ReadCounters) => delta.map(row => ({
  table: row.table, inserted: row.inserted, updated: row.updated, deleted: row.deleted,
  // Physical metadata probe counts can change with custom/generic plans and
  // early EXISTS exits. The CI invariant is zero example work and all-table
  // DML, independent of row count; keep full raw counters in the evidence.
  ...(/^(dataset_members|feature_values|feature_inputs|outcome_labels|label_inputs|norm_)/.test(row.table)
    ? { seq_scan: row.seq_scan, seq_tup_read: row.seq_tup_read, idx_scan: row.idx_scan, idx_tup_fetch: row.idx_tup_fetch } : {}),
}));

// A measurement-only wrapper samples this backend's transaction-local counters
// around the actual production function in ONE autocommit statement. It opens
// no caller transaction, and its extra measurement SELECTs do not enter client
// budget counts. Hidden negative controls prove that definer work is visible.
export const installReadWorkOracle = async (admin: Client) => {
  await admin.query(`CREATE FUNCTION fs138.read_work_counters() RETURNS jsonb
    LANGUAGE sql VOLATILE SET search_path=pg_catalog,fs138 AS $$
    SELECT jsonb_agg(jsonb_build_object('table',relname,'seq_scan',seq_scan,'seq_tup_read',seq_tup_read,
      'idx_scan',coalesce(idx_scan,0),'idx_tup_fetch',coalesce(idx_tup_fetch,0),
      'inserted',n_tup_ins,'updated',n_tup_upd,'deleted',n_tup_del) ORDER BY relname)
    FROM pg_stat_xact_user_tables WHERE schemaname='fs138' $$`);
  await admin.query(`CREATE FUNCTION fs138.measure_model_read(id uuid,slots text[],pins boolean) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,fs138 AS $$
    DECLARE before jsonb; result jsonb; after jsonb; forbidden_locks jsonb;
    BEGIN
      before:=fs138.read_work_counters();
      result:=fs138.authorize_model_read(id,slots,pins);
      after:=fs138.read_work_counters();
      SELECT coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode)),'[]') INTO forbidden_locks
      FROM pg_locks WHERE pid=pg_backend_pid() AND
        (locktype IN ('advisory','tuple','transactionid') OR
         (locktype='relation' AND mode<>'AccessShareLock'));
      RETURN jsonb_build_object('before',before,'after',after,'result',result,'forbiddenLocks',forbidden_locks);
    END $$`);
  await admin.query(`CREATE FUNCTION fs138.negative_read_work(dml boolean) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
    DECLARE before jsonb; after jsonb;
    BEGIN
      before:=fs138.read_work_counters();
      IF dml THEN
        INSERT INTO fs138.orphan_observations VALUES('audits/'||repeat('f',64),clock_timestamp());
      ELSE
        PERFORM history FROM fs138.feature_values;
      END IF;
      after:=fs138.read_work_counters();
      RETURN jsonb_build_object('before',before,'after',after);
    END $$`);
  await admin.query(`REVOKE ALL ON FUNCTION fs138.read_work_counters(),fs138.measure_model_read(uuid,text[],boolean),
    fs138.negative_read_work(boolean) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fs138.read_work_counters(),fs138.measure_model_read(uuid,text[],boolean),
    fs138.negative_read_work(boolean) TO fs138_reader`);
};
export const measureReadWork = async (reader: Client, runId: string, slots: readonly ModelArtifactSlot[], pins: boolean) => {
  const { before, after, forbiddenLocks } = (await reader.query<{
    measured: { before: ReadCounters; after: ReadCounters; forbiddenLocks: unknown[] } }>(
    "SELECT fs138.measure_model_read($1,$2,$3) AS measured", [runId, slots, pins])).rows[0].measured;
  assert.deepEqual(forbiddenLocks, [], "no explicit coordination locks even inside the authorization statement");
  return readCounterDelta(before, after);
};
