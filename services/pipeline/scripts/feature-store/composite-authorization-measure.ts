import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { Client, type ClientConfig } from "pg";
import { equalMassSupport, probabilityAt, priceSide } from "@dfs-ev/domain/empirical";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { createEmpiricalAdapter } from "../../src/featureStore/empiricalAdapter.ts";
import { resolveModelContext, type ModelContextRequest } from "../../src/featureStore/modelContext.ts";
import { withModelArtifacts } from "../../src/featureStore/modelArtifacts.ts";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";

export type CompositeCase = { featureId: string; n: number; request: ModelContextRequest };
export type CompositeSample = {
  arm: "baseline" | "candidate"; temperature: "cold" | "warm";
  phase: "baseline-first" | "interleaved"; cohort: number; position: number; read: number;
  featureId: string; n: number; verdict: string; error?: string;
  totalMs: number; setupMs: number; warmPathMs: number; setupShare: number;
  getMs: number; computeMs: number; serializationMs: number; outputBytes: number;
  work: { sql: number; checks: number; gets: number; heads: number; puts: number; deletes: number; lists: number; hashes: number };
  queries: { kind: "context" | "check" | "history"; elapsedMs: number }[];
};

// Benchmark composition only, not a serving endpoint. The actual reviewed APIs
// own selection and authorization; this trusted callback does pure domain math.
// Source qualification, server observers and connection close are outside timing.
export const createCompositeMeasurement = async (store: ObjectStore, runId: string) => {
  const reference = await createEmpiricalAdapter();
  return async (options: {
    arm: CompositeSample["arm"]; temperature: CompositeSample["temperature"]; input: CompositeCase;
    connection: Client | ClientConfig;
  }) => {
    const { arm, temperature, input } = options;
    const queries: CompositeSample["queries"] = [];
    const work = { sql: 0, checks: 0, gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 };
    let setupMs = 0, getMs = 0, computeMs = 0, serializationMs = 0, outputBytes = 0, failure: string | undefined;
    const originalHash = crypto.createHash;
    let client: Client | undefined;
    const started = performance.now();
    try {
      if (temperature === "cold") {
        const connectionStarted = performance.now();
        client = new Client(options.connection as ClientConfig);
        await client.connect(); setupMs = performance.now() - connectionStarted;
      } else client = options.connection as Client;
      // Authentication belongs to separately reported connection setup. The
      // no-rehash budget covers the lookup/use/delivery path after connection.
      crypto.createHash = ((...args: Parameters<typeof originalHash>) => { work.hashes++; return originalHash(...args); }) as typeof originalHash;
      syncBuiltinESMExports();
      const observed = new Proxy(client, { get(target, property) {
        if (property !== "query") return Reflect.get(target, property, target);
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
          const kind = /authorize_model_context_read|effective_rights/.test(sql) ? "check"
            : sql.includes("resolve_model_context") ? "context" : arm === "baseline" && work.sql !== 1 ? "check" : "history";
          work.sql++; if (kind === "check") work.checks++;
          const begin = performance.now();
          try { return await Reflect.apply(target.query, target, args); }
          finally { queries.push({ kind, elapsedMs: performance.now() - begin }); }
        };
      } });
      const objects: ObjectStore = { ...store,
        get: async key => { work.gets++; const begin = performance.now();
          try { return await store.get(key); } finally { getMs += performance.now() - begin; } },
        head: key => { work.heads++; return store.head(key); },
        putIfAbsent: (key, bytes) => { work.puts++; return store.putIfAbsent(key, bytes); },
        delete: key => { work.deletes++; return store.delete(key); },
        list: prefix => { work.lists++; return store.list(prefix); },
      };
      if (arm === "baseline") {
        const result = await reference(observed, { featureId: input.featureId, ...input.request, line: 225.5 });
        assert.equal(result.response.status, "available");
        if (result.response.status === "available") assert.equal(result.response.sampleSize, input.n);
        assert.deepEqual(result.work, { statements: 3, rightsChecks: 2 });
        outputBytes = Buffer.byteLength(result.serialized);
        computeMs = result.timingMs.calculation; serializationMs = result.timingMs.serialization;
      } else {
        const context = await resolveModelContext(observed, input.request);
        const result = await withModelArtifacts(observed, objects, { runId, slots: ["descriptor"], context }, privateInput => {
          const begin = performance.now();
          const descriptor = JSON.parse(privateInput.files[0].bytes.toString());
          assert.equal(descriptor.format, "qb-model-descriptor-v1");
          assert.equal(descriptor.identity.modelVersion, MODEL_VERSION);
          assert.equal(descriptor.identity.featureVersion, FEATURE_VERSION);
          assert.equal(descriptor.identity.historyPolicy, HISTORY_POLICY);
          assert(privateInput.history && privateInput.context);
          // Only arithmetic scales with n. No per-row integrity/time/eligibility
          // verification: the reviewed producer qualified this materialization.
          const support = equalMassSupport(privateInput.history.map(row => row.yards));
          const probabilities = probabilityAt(support, 225.5)!;
          const value = { run: privateInput.run, modelVersion: descriptor.identity.modelVersion,
            sampleSize: privateInput.history.length, line: 225.5, support, probabilities,
            pricing: { over: priceSide(probabilities, "over"), under: priceSide(probabilities, "under") } };
          computeMs = performance.now() - begin;
          return value;
        });
        assert.equal(result.value.sampleSize, input.n); assert.equal(result.context?.feature.featureId, input.featureId);
        const begin = performance.now();
        outputBytes = Buffer.byteLength(JSON.stringify({ status: "available", rightsScope: "research",
          designation: "uncalibrated-interim-hit-rate", ...result }));
        serializationMs = performance.now() - begin;
      }
      assert.deepEqual(work, { sql: 3, checks: 2, gets: arm === "candidate" ? 1 : 0,
        heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 });
    } catch (error) { failure = String(error); }
    const totalMs = performance.now() - started;
    crypto.createHash = originalHash; syncBuiltinESMExports();
    if (temperature === "cold") await client?.end();
    return { arm, temperature, featureId: input.featureId, n: input.n,
      verdict: failure ? "fail" : "pass", ...(failure ? { error: failure } : {}),
      totalMs, setupMs, warmPathMs: totalMs - setupMs, setupShare: setupMs / totalMs,
      getMs, computeMs, serializationMs, outputBytes, work, queries };
  };
};
