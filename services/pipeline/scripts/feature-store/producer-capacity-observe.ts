import type { Client } from "pg";
import { execFileSync } from "node:child_process";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { clockOffset, type ClockObservation, type Diagnostics, type DiskSample, type StatementTime } from "./producer-capacity-contract.ts";

export const timeProducerQueries = (client: Client, notify: (statement: StatementTime) => void) => {
  const statements: StatementTime[] = [];
  let stopped = false;
  const proxy = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      if (stopped) throw new Error("capacity-query-after-stop-refused");
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      const statement: StatementTime = { index: statements.length + 1, sqlSha256: sha256(Buffer.from(text)),
        kind: text.trim().split(/\s+/).slice(0, 3).join(" "), elapsedMs: 0, status: "running" };
      statements.push(statement);
      const started = performance.now();
      notify({ ...statement });
      try { const result = await Reflect.apply(target.query, target, args); statement.status = "completed"; return result; }
      catch (error) { statement.status = "failed"; throw error; }
      finally { statement.elapsedMs = performance.now() - started; notify({ ...statement }); }
    };
  } });
  return { client: proxy, statements, stop: () => { stopped = true; } };
};

export const checkCapacityClock = async (admin: Client) => {
  const observations: ClockObservation[] = [];
  for (let i = 0; i < 10; i++) {
    const hostBeforeMs = Date.now();
    const { rows } = await admin.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms");
    observations.push({ hostBeforeMs, hostAfterMs: Date.now(), databaseMs: Number(rows[0].ms) });
  }
  return clockOffset(observations);
};

const stats = async (admin: Client) => {
  // Separate admin connection; no values or diagnostics are added to producer SQL.
  await admin.query("SELECT pg_stat_clear_snapshot()");
  return (await admin.query(`SELECT clock_timestamp()::text AS at,
    (SELECT row_to_json(c) FROM pg_stat_checkpointer c) AS checkpointer,
    (SELECT row_to_json(w) FROM pg_stat_wal w) AS wal,
    (SELECT coalesce(jsonb_agg(t),'[]') FROM
      (SELECT relname,last_autovacuum,autovacuum_count,last_autoanalyze,autoanalyze_count
       FROM pg_stat_user_tables ORDER BY relname) t) AS tables`)).rows[0] as Record<string, unknown>;
};
export const sampleCapacityDisk = async (admin: Client): Promise<DiskSample> => {
  if (process.env.DB_TEST_LANE !== "lane-3") throw new Error("capacity-lane-refused");
  const row = execFileSync("docker", ["exec", "dfs-ev-demo-test-lane-3-postgres-1", "sh", "-c", 'df -Pk "$PGDATA" | tail -1'], { encoding: "utf8" }).trim().split(/\s+/);
  const detail = (await admin.query(`SELECT clock_timestamp()::text AS at,
    (SELECT coalesce(sum(size),0)::float8 FROM pg_ls_waldir()) AS "walBytes",
    (SELECT coalesce(jsonb_agg(t),'[]') FROM pg_ls_tmpdir() t) AS "tempFiles",
    (SELECT jsonb_agg(jsonb_build_object('name',datname,'bytes',pg_database_size(oid))) FROM pg_database) AS databases`)).rows[0];
  return { ...detail, mountBytes: Number(row[1]) * 1024, usedBytes: Number(row[2]) * 1024, availableBytes: Number(row[3]) * 1024 };
};
export const observeCapacityTrial = async (admin: Client, feature: boolean, diskSample = () => sampleCapacityDisk(admin)) => {
  const disk: DiskSample[] = [], autovacuum: Diagnostics["autovacuum"] = [];
  const before = feature ? await stats(admin) : {};
  const sample = async () => {
    disk.push(await diskSample());
    if (feature) {
      const activity = (await admin.query(`SELECT pid,datname,query_start::text,wait_event_type,wait_event,query
        FROM pg_stat_activity WHERE backend_type='autovacuum worker' ORDER BY pid`)).rows;
      autovacuum.push({ at: new Date().toISOString(), activity });
    }
  };
  await sample();
  let pending = Promise.resolve(), busy = false, failure: unknown;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true; pending = sample().catch(e => { failure = e; }).finally(() => { busy = false; });
  }, 250);
  let finished: Promise<Diagnostics | undefined> | undefined;
  const finish = async () => {
    clearInterval(timer); await pending; await sample();
    const diagnostics = feature ? { before, after: await stats(admin), autovacuum } : undefined;
    if (failure) throw failure;
    return diagnostics;
  };
  return { disk, finish: () => finished ??= finish() };
};
