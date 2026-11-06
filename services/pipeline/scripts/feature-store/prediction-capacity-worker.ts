import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { Pool, type ClientConfig, type PoolClient } from "pg";
import { predictQbModelOwned } from "@dfs-ev/pipeline/feature-store/prediction-owner";
import { openLocalObjectStore } from "@dfs-ev/pipeline/feature-store/local-object-store";
import type { CapacityRequest } from "./prediction-capacity-workload.ts";

export const CAPACITY_WORK = Object.freeze({ sql: 3, checks: 2, gets: 1, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 });
export const createCapacityWorker = async (config: ClientConfig, storageRoot: string) => {
  const beforeStore = performance.now(), store = await openLocalObjectStore(storageRoot);
  const storeMs = performance.now() - beforeStore;
  const pool = new Pool({ ...config, max: 1, statement_timeout: 300, query_timeout: 300,
    connectionTimeoutMillis: 300, idleTimeoutMillis: 0 });
  pool.on("error", () => {});
  const acquire = pool.connect.bind(pool);
  let connectMs = 0, observing = false, requestHashes = false;
  let work: Record<keyof typeof CAPACITY_WORK, number> = { ...CAPACITY_WORK }, queries: { kind: string; elapsedMs: number }[] = [];
  // A real pool/LOGIN is used. Only its query surface is observed; release is
  // still performed by the production owner helper, never by the handler.
  Object.defineProperty(pool, "connect", { value: async () => {
    const start = performance.now(), client = await acquire(); connectMs += performance.now() - start;
    requestHashes = true;
    return new Proxy(client, { get(target, key) {
      if (key !== "query") return Reflect.get(target, key, target);
      return async (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
        const kind = sql.includes("resolve_model_context") ? "context" : "check";
        work.sql++; if (kind === "check") work.checks++;
        const begin = performance.now();
        try { return await Reflect.apply(target.query, target, args); }
        finally { queries.push({ kind, elapsedMs: performance.now() - begin }); }
      };
    } }) as PoolClient;
  } });
  return { storeMs,
    prepare: async () => { const before = performance.now(), client = await acquire(); client.release(); return performance.now() - before; },
    close: () => pool.end(),
    predict: async (input: CapacityRequest, deadlineAt: number) => {
      assert(!observing, "capacity-worker-exclusive-request"); observing = true;
      work = Object.fromEntries(Object.keys(CAPACITY_WORK).map(k => [k, 0])) as typeof work;
      queries = []; connectMs = 0; requestHashes = false;
      const originalHash = crypto.createHash, started = performance.now();
      // pg's SCRAM authentication hashes belong to connection setup. Count only
      // artifact/request hashing after checkout, including before the first SQL.
      crypto.createHash = ((...args: Parameters<typeof originalHash>) => {
        if (requestHashes) work.hashes++; return originalHash(...args);
      }) as typeof originalHash;
      syncBuiltinESMExports();
      try {
        const read = await predictQbModelOwned(pool, {
          get: async key => { work.gets++; assert(key.startsWith("models/"), "capacity-descriptor-only"); return store.get(key); },
        }, input.request, { deadlineAt });
        const handlerMs = performance.now() - started - connectMs;
        let error: string | undefined;
        try {
          assert.equal(read.response.status, "available", JSON.stringify(read.response));
          if (read.response.status === "available") {
            assert.equal(read.response.forecast.sampleCount, input.n);
            assert.equal(read.response.context.feature.featureId, input.featureId);
          }
          assert.deepEqual(JSON.parse(read.serialized), read.response);
          assert(!read.serialized.includes("connectionDisposition")); assert.equal(read.connectionDisposition, "reusable");
          assert.deepEqual(work, CAPACITY_WORK); assert.deepEqual(queries.map(q => q.kind), ["context", "check", "check"]);
        } catch (failure) { error = String(failure); }
        return { verdict: error ? "fail" as const : "pass" as const, ...(error ? { error } : {}),
          serialized: read.serialized, work, queries, connectMs, handlerMs, outputBytes: Buffer.byteLength(read.serialized) };
      } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); observing = false; requestHashes = false; }
    },
  };
};
