import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { Client, type ClientConfig } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION } from "@dfs-ev/domain/qb-evaluation";
import { predictQbModel, type PredictionRequest } from "@dfs-ev/pipeline/feature-store/predict";
import { createCompositeMeasurement, type CompositeCase, type CompositeSample } from "./composite-authorization-measure.ts";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";

export const predictionRequest = (runId: string, input: CompositeCase): PredictionRequest => ({
  ...input.request, runId, modelVersion: MODEL_VERSION, scoringPolicy: QB_EVALUATOR_VERSION, line: 225.5,
});

// Measure the public handler unchanged. Internal math/serialization stay inside
// totalMs, without monkey-patching helpers or adding measurement-only hooks.
// The reference is the unchanged #163 adapter via the existing observer.
export const createPredictionMeasurement = async (store: ObjectStore, runId: string) => {
  const reference = await createCompositeMeasurement(store, runId);
  return async (options: { arm: CompositeSample["arm"]; temperature: CompositeSample["temperature"];
    input: CompositeCase; connection: Client | ClientConfig }) => {
    if (options.arm === "baseline") return reference(options);
    const { input, temperature } = options, queries: CompositeSample["queries"] = [];
    const work = { sql: 0, checks: 0, gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 };
    const request = predictionRequest(runId, input);
    let setupMs = 0, getMs = 0, outputBytes = 0, failure: string | undefined, client: Client | undefined;
    const originalHash = crypto.createHash, started = performance.now();
    try {
      if (temperature === "cold") {
        client = new Client(options.connection as ClientConfig);
        await client.connect(); setupMs = performance.now() - started;
      } else client = options.connection as Client;
      // Authentication hashing is setup, not artifact verification. Install the
      // observer after connect and restore it before closing the connection.
      crypto.createHash = ((...args: Parameters<typeof originalHash>) => {
        work.hashes++; return originalHash(...args);
      }) as typeof originalHash;
      syncBuiltinESMExports();
      const observed = new Proxy(client, { get(target, property) {
        if (property !== "query") return Reflect.get(target, property, target);
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
          const kind = sql.includes("resolve_model_context") ? "context" : "check";
          work.sql++; if (kind === "check") work.checks++;
          const begin = performance.now();
          try { return await Reflect.apply(target.query, target, args); }
          finally { queries.push({ kind, elapsedMs: performance.now() - begin }); }
        };
      } });
      const objects: ObjectStore = { ...store,
        get: async key => { work.gets++; const begin = performance.now();
          try { assert(key.startsWith("models/"), "descriptor-only-GET"); return await store.get(key); }
          finally { getMs += performance.now() - begin; } },
        head: key => { work.heads++; return store.head(key); },
        putIfAbsent: (key, bytes) => { work.puts++; return store.putIfAbsent(key, bytes); },
        delete: key => { work.deletes++; return store.delete(key); },
        list: prefix => { work.lists++; return store.list(prefix); },
      };
      // Cold setup consumes the same allocation; the handler cannot renew it.
      const read = await predictQbModel(observed, objects, request, { deadlineAt: started + 300 });
      assert.equal(read.response.status, "available", JSON.stringify(read.response));
      if (read.response.status === "available") {
        assert.equal(read.response.forecast.sampleCount, input.n);
        assert.equal(read.response.context.feature.featureId, input.featureId);
      }
      assert.deepEqual(JSON.parse(read.serialized), read.response);
      outputBytes = Buffer.byteLength(read.serialized);
      assert.deepEqual(work, { sql: 3, checks: 2, gets: 1, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 });
    } catch (error) { failure = String(error); }
    const totalMs = performance.now() - started;
    crypto.createHash = originalHash; syncBuiltinESMExports();
    if (temperature === "cold") await client?.end();
    return { arm: "candidate" as const, temperature, featureId: input.featureId, n: input.n,
      verdict: failure ? "fail" : "pass", ...(failure ? { error: failure } : {}), totalMs, setupMs,
      warmPathMs: totalMs - setupMs, setupShare: setupMs / totalMs, getMs,
      computeMs: 0, serializationMs: 0, outputBytes, work, queries };
  };
};
