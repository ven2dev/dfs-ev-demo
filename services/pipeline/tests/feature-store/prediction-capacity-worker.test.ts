import crypto from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { createCapacityWorker } from "../../scripts/feature-store/prediction-capacity-worker.ts";
import type { CapacityRequest } from "../../scripts/feature-store/prediction-capacity-workload.ts";

const state = vi.hoisted(() => ({ hashBeforeSql: false, extraSql: false }));
vi.mock("pg", () => ({ Pool: class {
  on = vi.fn(); end = vi.fn(async () => {});
  connect = async () => {
    // Authentication is setup, outside the zero request-hash work budget.
    crypto.createHash("sha256").update("SCRAM setup").digest();
    return { query: async () => ({}), release: vi.fn() };
  } } }));
vi.mock("@dfs-ev/pipeline/feature-store/local-object-store", () => ({ openLocalObjectStore: async () => ({ get: async () => Buffer.from("descriptor") }) }));
vi.mock("@dfs-ev/pipeline/feature-store/prediction-owner", () => ({ predictQbModelOwned: async (
  pool: { connect: () => Promise<{ query: (sql: string) => Promise<unknown> }> }, store: { get: (key: string) => Promise<Buffer> }) => {
  const client = await pool.connect();
  if (state.hashBeforeSql) crypto.createHash("sha256").update("hidden request verification").digest();
  await client.query("SELECT resolve_model_context()"); await client.query("SELECT authorize_model_context_read()");
  await store.get("models/" + "a".repeat(64)); await client.query("SELECT authorize_model_context_read()");
  if (state.extraSql) await client.query("SELECT hidden_work()");
  const response = { status: "available", forecast: { sampleCount: 2 }, context: { feature: { featureId: "f" } } };
  return { response, serialized: JSON.stringify(response), connectionDisposition: "reusable" };
} }));
const input = { featureId: "f", n: 2, request: {} } as CapacityRequest;
beforeEach(() => { state.hashBeforeSql = false; state.extraSql = false; });
it("excludes connection authentication but counts all request work from checkout", async () => {
  const worker = await createCapacityWorker({}, "/store");
  const result = await worker.predict(input, performance.now() + 300);
  expect(result.verdict).toBe("pass"); expect(result.work.hashes).toBe(0); expect(result.work.sql).toBe(3); await worker.close();
});
it("catches hashing before the first SQL instead of silently treating it as setup", async () => {
  state.hashBeforeSql = true; const worker = await createCapacityWorker({}, "/store");
  const result = await worker.predict(input, performance.now() + 300);
  expect(result.verdict).toBe("fail"); expect(result.work.hashes).toBe(1); await worker.close();
});
it("catches an extra request statement without depending on request duration", async () => {
  state.extraSql = true; const worker = await createCapacityWorker({}, "/store");
  const result = await worker.predict(input, performance.now() + 300);
  expect(result.verdict).toBe("fail"); expect(result.work.sql).toBe(4); await worker.close();
});
