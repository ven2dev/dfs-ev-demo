import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import { predictQbModel, type PredictionRequest } from "@dfs-ev/pipeline/feature-store/predict";
import { predictionDeliveryFixture, predictionFixture } from "./prediction-helpers-fixture.ts";

// Actual resolver, composite reader and helpers; only transport replies are
// synthetic here. PostgreSQL selection/rights/race proof belongs to Step 2.
const transport = (input = predictionDeliveryFixture()) => {
  const trace: string[] = [], queries: { sql: string; values: unknown[] }[] = [];
  const bytes = Buffer.from(JSON.stringify(input.descriptor));
  let q2 = false, ended = 0;
  const options = { failAt: "", code: "", bytes, missingFinalContext: false,
    onGet: () => {}, afterContext: () => {} };
  const client = { query: async (sql: string, values: unknown[]) => {
    const stage = sql.includes("resolve_model_context") ? "context" : values[2] ? "Q1" : "Q2";
    trace.push(stage); queries.push({ sql, values: structuredClone(values) });
    if (stage === options.failAt) throw Object.assign(new Error("private provider diagnostics"), { code: options.code });
    if (stage === "context") { options.afterContext(); return { rows: [{ context: structuredClone(input.context) }] }; }
    if (stage === "Q1") return { rows: [{ access: { ...input.model, context: structuredClone(input.context),
      history: input.history, authorization: structuredClone(input.authorization),
      artifacts: [{ slot: "descriptor", objectKey: "models/" + input.model.run.descriptorSha256, byteSize: options.bytes.length }] } }] };
    q2 = true;
    return { rows: [{ access: { authorization: structuredClone(input.delivery),
      ...(!options.missingFinalContext ? { context: structuredClone(input.finalContext) } : {}) } }] };
  }, end: async () => { ended++; } } as unknown as Pick<Client, "query" | "end">;
  const store = { get: async (key: string) => {
    expect(key).toBe("models/" + input.model.run.descriptorSha256);
    trace.push("GET:descriptor"); options.onGet();
    if (options.failAt === "GET") throw new Error("private storage diagnostic");
    return options.bytes;
  } };
  const request: PredictionRequest = { ...input.request, knownAsOf: input.context.request.knownAsOf, line: 100 };
  return { input, client, store, request, trace, queries, options, delivered: () => q2, ended: () => ended };
};
const expectRefusal = (result: Awaited<ReturnType<typeof predictQbModel>>, reason: string, discard = false) => {
  const expected = { status: "unavailable", reason, connectionDisposition: discard ? "discard" : "reusable" };
  expect(result.response).toEqual(expected); expect(JSON.parse(result.serialized)).toEqual(expected);
  expect(Object.keys(result)).toEqual(["response", "serialized"]);
};

describe("#167 thin governed prediction handler", () => {
  it.each(Array.from({ length: 15 }, (_, i) => i + 2))("n=%i: exact context → Q1 → descriptor → math → Q2 with no example verification", async n => {
    const t = transport();
    t.input.context.feature.sampleSize = n; t.input.finalContext.feature.sampleSize = n;
    let yardsReads = 0;
    t.input.history = Array.from({ length: n }, (_, i) => ({
      get yards() { yardsReads++; if (i === 0) t.trace.push("math"); return i * 100; },
      get gameId(): string { throw new Error("per-example game verification"); },
      get kickoff(): string { throw new Error("per-example clock verification"); },
    }));
    const result = await predictQbModel(t.client, t.store, t.request);
    expect(t.trace).toEqual(["context", "Q1", "GET:descriptor", "math", "Q2"]);
    expect(t.queries).toHaveLength(3); expect(t.queries.filter(q => q.sql.includes("authorize_model_context_read"))).toHaveLength(2);
    expect(t.queries[0].values).toEqual([t.request.playerId, t.request.gameId, t.request.featureVersion,
      t.request.historyPolicy, t.request.evidenceMode, t.request.knownAsOf]);
    expect(t.queries[1].values.slice(0, 3)).toEqual([t.request.runId, ["descriptor"], true]);
    expect(t.queries[2].values).toEqual([t.request.runId, ["descriptor"], false, t.queries[1].values[3]]);
    expect(yardsReads).toBe(n); expect(t.ended()).toBe(0);
    expect(result.response.status).toBe("available");
    if (result.response.status !== "available") throw new Error("expected available result");
    expect(result.response.forecast).toMatchObject({ line: 100, sampleCount: n });
    expect(result.response.forecast.probabilities.overProbability).toBeCloseTo((n - 2) / n, 14);
    expect(result.response.forecast.probabilities.underProbability).toBeCloseTo(1 / n, 14);
    expect(result.response.forecast.probabilities.pushProbability).toBeCloseTo(1 / n, 14);
    expect(JSON.parse(result.serialized)).toEqual(result.response);
  });

  it("uses the selected sampleSize rather than substituting history.length, refusing a mismatched boundary materialization", async () => {
    const t = transport(); t.input.context.feature.sampleSize = 4;
    const result = await predictQbModel(t.client, t.store, t.request);
    expectRefusal(result, "materialization-refused");
    expect(t.trace).toEqual(["context", "Q1", "GET:descriptor"]); expect(t.delivered()).toBe(false);
  });

  it("delivers Q2 refreshed flags and both distinct receipts, retaining Q1 values and exact clocks", async () => {
    const t = transport(), selected = structuredClone(t.input.context);
    const result = await predictQbModel(t.client, t.store, t.request);
    expect(result.response.status).toBe("available");
    if (result.response.status !== "available") throw new Error("expected available result");
    expect(result.response.context).toEqual(t.input.finalContext);
    expect(result.response.context.freshness).not.toEqual(selected.freshness);
    expect(result.response.context.feature).toEqual(selected.feature);
    expect(result.response.context.selection.lastValid).toBe(true);
    expect(result.response.context.freshness).toMatchObject({ stale: true, superseded: true });
    expect(result.response.context.feature.flags).toContain("historical-availability-unverified");
    expect(result.response.authorization).toEqual(t.input.authorization);
    expect(result.response.delivery).toEqual(t.input.delivery);
    expect(result.response.authorization).not.toEqual(result.response.delivery);
    expect(result.response.forecast.sampleCount).toBe(3);
    expect(result.response.forecast.probabilities.overProbability).toBeCloseTo(2 / 3, 14);
    expect(result.response.forecast.probabilities.underProbability).toBe(0);
    expect(result.response.forecast.probabilities.pushProbability).toBeCloseTo(1 / 3, 14);
    for (const forbidden of ["history", "descriptor", "files", "datasets", "targetLabel"])
      expect(result.response).not.toHaveProperty(forbidden);
  });

  it("captures only named request scalars before awaiting, never reading target, caller history or example eligibility", async () => {
    const t = transport(), original = { ...t.request };
    for (const key of ["label", "targetLabel", "history", "sampleSize", "snapshotIds", "featureId"])
      Object.defineProperty(t.request, key, { get: () => { throw new Error("caller extras read: " + key); } });
    t.options.afterContext = () => { Object.assign(t.request, { runId: "changed", playerId: "other-QB", line: 999, knownAsOf: "changed" }); };
    const result = await predictQbModel(t.client, t.store, t.request);
    expect(result.response).toMatchObject({ status: "available", playerId: original.playerId,
      forecast: { line: original.line }, context: { request: { knownAsOf: original.knownAsOf } } });
    expect(t.queries[1].values[0]).toBe(original.runId); expect(t.queries[2].values[0]).toBe(original.runId);
  });

  it("keeps two QBs in one game distinct without requiring training membership or labels", async () => {
    const a = transport(), b = transport();
    Object.assign(b.request, { playerId: "other-QB" });
    for (const context of [b.input.context, b.input.finalContext]) {
      context.request.playerId = b.request.playerId; context.feature.playerId = b.request.playerId;
      context.feature.featureId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    }
    const first = await predictQbModel(a.client, a.store, a.request), second = await predictQbModel(b.client, b.store, b.request);
    expect(first.response.status).toBe("available"); expect(second.response.status).toBe("available");
    if (first.response.status !== "available" || second.response.status !== "available") throw new Error("expected available results");
    expect(first.response.gameId).toBe(second.response.gameId); expect(first.response.playerId).not.toBe(second.response.playerId);
    expect(first.response.context.feature.featureId).not.toBe(second.response.context.feature.featureId);
    expect(first.response.forecast).toEqual(second.response.forecast);
  });

  it("refuses a strict-only run serving retrospective input before Q2 and exposes no partial result", async () => {
    const t = transport(), strict = predictionFixture(["strict-point-in-time-v1"], "retrospective-reconstruction-v1");
    t.input.model = strict.model; t.options.bytes = Buffer.from(JSON.stringify(strict.descriptor));
    expectRefusal(await predictQbModel(t.client, t.store, t.request), "evidence-mode-mismatch");
    expect(t.trace).toEqual(["context", "Q1", "GET:descriptor"]);
  });
  it.each(["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const)("a both-mode run accepts %s", async mode => {
    const t = transport(); Object.assign(t.request, { evidenceMode: mode });
    for (const context of [t.input.context, t.input.finalContext]) {
      context.request.evidenceMode = mode; context.feature.evidenceMode = mode;
    }
    expect((await predictQbModel(t.client, t.store, t.request)).response).toMatchObject({ status: "available", model: { evidenceMode: mode } });
  });

  it.each([
    ["context", "P2311", "model-context-request-refused"], ["context", "P2312", "model-context-unsupported-version"],
    ["context", "P2313", "model-context-future-knowledge"], ["context", "P2314", "model-context-insufficient-history"],
    ["context", "P2315", "model-context-unavailable"], ["context", "P2316", "model-context-lineage-refused"],
    ...["Q1", "Q2"].flatMap(stage => [[stage, "P1666", "model-read-status-refused"],
      [stage, "P2317", "model-context-reference-refused"], [stage, "P1665", "model-current-rights-refused"],
      [stage, "P1664", "model-read-missing"], [stage, "P1663", "model-read-request-refused"]]),
  ])("%s %s keeps %s distinct, with a bounded refusal and exact prefix trace", async (stage, code, reason) => {
    const t = transport(); Object.assign(t.options, { failAt: stage, code });
    expectRefusal(await predictQbModel(t.client, t.store, t.request), reason);
    const path = ["context", "Q1", "GET:descriptor", "Q2"];
    expect(t.trace).toEqual(path.slice(0, path.indexOf(stage) + 1)); expect(t.ended()).toBe(0);
  });

  it.each([
    [{ runId: "not-a-run" }, "invalid-request"], [{ line: NaN }, "invalid-request"],
    [{ line: Infinity }, "invalid-request"], [{ modelVersion: "unknown" }, "unsupported-model-policy"],
    [{ scoringPolicy: "unknown" }, "unsupported-model-policy"],
  ])("refuses invalid model pins/line before SQL: %j", async (patch, reason) => {
    const t = transport(); Object.assign(t.request, patch);
    expectRefusal(await predictQbModel(t.client, t.store, t.request), reason); expect(t.trace).toEqual([]);
  });
  it("delegates feature policy and knowledge timestamp validation to the resolver before SQL", async () => {
    for (const [patch, reason] of [[{ featureVersion: "unknown" }, "model-context-unsupported-version"],
      [{ historyPolicy: "unknown" }, "model-context-unsupported-version"], [{ evidenceMode: "unknown" }, "model-context-unsupported-version"],
      [{ knownAsOf: "not-a-time" }, "model-context-request-refused"], [{ playerId: "" }, "model-context-request-refused"]] as const) {
      const t = transport(); Object.assign(t.request, patch);
      expectRefusal(await predictQbModel(t.client, t.store, t.request), reason); expect(t.trace).toEqual([]);
    }
  });
  it.each(["{", "null", '{"format":"unknown"}'])("refuses malformed or mismatched descriptor %s without Q2", async bytes => {
    const t = transport(); t.options.bytes = Buffer.from(bytes);
    expectRefusal(await predictQbModel(t.client, t.store, t.request), "descriptor-mismatch");
    expect(t.trace).toEqual(["context", "Q1", "GET:descriptor"]);
  });
  it("withholds all fields when descriptor storage fails or the final context is missing", async () => {
    const t = transport(); t.options.failAt = "GET";
    expectRefusal(await predictQbModel(t.client, t.store, t.request), "model-artifact-unavailable");
    expect(t.trace).toEqual(["context", "Q1", "GET:descriptor"]);
    const missing = transport(); missing.options.missingFinalContext = true;
    expectRefusal(await predictQbModel(missing.client, missing.store, missing.request), "model-context-reference-refused");
  });
  it.each(["context", "Q1", "Q2"])("discards %s connection failures without retry or cleanup SQL", async stage => {
    const t = transport(); Object.assign(t.options, { failAt: stage, code: "08006" });
    expectRefusal(await predictQbModel(t.client, t.store, t.request), "connection-interrupted", true);
    expect(t.ended()).toBe(1);
    expect(t.queries).toHaveLength(stage === "context" ? 1 : stage === "Q1" ? 2 : 3);
  });
  it("discards an unsafe reader session and keeps unexpected provider diagnostics private", async () => {
    const t = transport(); Object.assign(t.options, { failAt: "Q1", code: "P1667" });
    expectRefusal(await predictQbModel(t.client, t.store, t.request), "model-read-session-refused", true);
    expect(t.ended()).toBe(1);
    const other = transport(); Object.assign(other.options, { failAt: "Q2", code: "XX000" });
    expectRefusal(await predictQbModel(other.client, other.store, other.request), "prediction-unavailable", true);
    expect(other.ended()).toBe(1);
  });
});
