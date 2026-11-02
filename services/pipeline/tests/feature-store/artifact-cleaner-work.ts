import assert from "node:assert/strict";
import type { Client } from "pg";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";
import { readCounterDelta, type ReadCounters } from "./artifact-read-work.ts";

export const cleanerTrace = (client: Pick<Client, "query">, store: ObjectStore) => {
  const statements: string[] = [], deletes: string[] = [];
  const work = { gets: 0, heads: 0, puts: 0, lists: 0 };
  const tracedClient = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return (...args: unknown[]) => {
      statements.push(String(args[0])); return Reflect.apply(target.query, target, args);
    };
  } });
  const tracedStore: ObjectStore = { ...store,
    delete: async key => { deletes.push(key); await store.delete(key); },
    get: async key => { work.gets++; return store.get(key); },
    head: async key => { work.heads++; return store.head(key); },
    putIfAbsent: async (...args) => { work.puts++; return store.putIfAbsent(...args); },
    list: async namespace => { work.lists++; return store.list(namespace); },
  };
  return { client: tracedClient, store: tracedStore, statements, deletes, work };
};

export const assertCleanerTrace = (trace: ReturnType<typeof cleanerTrace>, removable: number, refused = 0) => {
  assert.match(trace.statements[0], /SELECT r.object_key FROM fs138.object_removals/);
  assert.equal(trace.statements.length, 1 + removable * 4 + refused * 3);
  assert.equal(trace.deletes.length, removable);
  assert.deepEqual(trace.work, { gets: 0, heads: 0, puts: 0, lists: 0 });
  let offset = 1, deletes = 0, refusals = 0;
  while (offset < trace.statements.length) {
    assert.equal(trace.statements[offset++], "BEGIN");
    assert.equal(trace.statements[offset++], "SELECT fs138.removal_recheck($1) AS allowed");
    if (trace.statements[offset] === "SELECT fs138.ack_removal($1)") { offset++; deletes++; }
    else refusals++;
    assert.equal(trace.statements[offset++], "COMMIT");
  }
  assert.equal(deletes, removable); assert.equal(refusals, refused);
};

const counters = async (client: Pick<Client, "query">): Promise<ReadCounters> => (await client.query(`SELECT relname AS "table",
  seq_scan::integer,seq_tup_read::integer,coalesce(idx_scan,0)::integer AS idx_scan,
  coalesce(idx_tup_fetch,0)::integer AS idx_tup_fetch,n_tup_ins::integer AS inserted,
  n_tup_upd::integer AS updated,n_tup_del::integer AS deleted
  FROM pg_stat_xact_user_tables WHERE schemaname='fs138' ORDER BY relname`)).rows;
const assertServerWork = (delta: ReadCounters, updated: number) => {
  for (const row of delta) {
    assert.equal(row.inserted, 0, `${row.table}: unexpected insert`);
    assert.equal(row.deleted, 0, `${row.table}: unexpected delete`);
    assert.equal(row.updated, row.table === "object_removals" ? updated : 0, `${row.table}: queue update budget`);
    if (/^(dataset_members|feature_values|feature_inputs|outcome_labels|label_inputs|norm_)/.test(row.table))
      assert.equal(row.seq_scan + row.seq_tup_read + row.idx_scan + row.idx_tup_fetch, 0, `${row.table}: hidden example work`);
  }
};

// Measurement transaction, without external I/O. Counters include ack's internal
// recheck, so one client statement cannot conceal example scans or extra writes.
export const measureCleanerWork = async (writer: Client, address: string, allowed: boolean, shared = false) => {
  await writer.query("BEGIN");
  try {
    const start = await counters(writer);
    assert.equal((await writer.query("SELECT fs138.removal_recheck($1) AS allowed", [address])).rows[0].allowed, allowed);
    const checked = await counters(writer), recheck = readCounterDelta(start, checked);
    assertServerWork(recheck, shared ? 1 : 0);
    let ack: ReadCounters | undefined;
    if (allowed) {
      await writer.query("SELECT fs138.ack_removal($1)", [address]);
      ack = readCounterDelta(checked, await counters(writer)); assertServerWork(ack, 1);
    }
    return { recheck, ...(ack ? { ack } : {}) };
  } finally { await writer.query("ROLLBACK"); }
};

export const waitForCleanerLock = async (admin: Client, pid: number) => {
  for (let n = 0; n < 200; n++) {
    const state = (await admin.query("SELECT wait_event_type,pg_blocking_pids($1) AS blockers FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (state?.wait_event_type === "Lock" && state.blockers.length) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("cleaner/publication lock wait not observed");
};
