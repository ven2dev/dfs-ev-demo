import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { predictQbModelOwned } from "@dfs-ev/pipeline/feature-store/prediction-owner";
import { predictionDeliveryFixture } from "./prediction-helpers-fixture.ts";

const transport = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), release: vi.fn(),
  config: undefined as unknown, poolConnect: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) { transport.config = config; }
    connect = transport.connect; query = transport.query; end = transport.end;
    on = vi.fn();
  },
  Pool: class {
    options: unknown;
    constructor(options: unknown) { this.options = options; }
    connect = transport.poolConnect;
  },
}));

describe("#168 connection owner", () => {
  const input = () => {
    const fixture = predictionDeliveryFixture();
    transport.query.mockImplementation(async (q: { text: string; values: unknown[] }) => {
      if (q.text.includes("resolve_model_context")) return { rows: [{ context: fixture.context }] };
      return { rows: [{ access: q.values[2] ? { ...fixture.model, context: fixture.context,
        history: fixture.history, authorization: fixture.authorization,
        artifacts: [{ slot: "descriptor", objectKey: "models/" + fixture.model.run.descriptorSha256,
          byteSize: Buffer.byteLength(JSON.stringify(fixture.descriptor)) }] }
        : { context: fixture.finalContext, authorization: fixture.delivery } }] };
    });
    return { request: { ...fixture.request, knownAsOf: fixture.context.request.knownAsOf, line: 100 },
      store: { get: vi.fn(async () => Buffer.from(JSON.stringify(fixture.descriptor))) } };
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.clearAllMocks(); transport.connect.mockResolvedValue(undefined); transport.end.mockResolvedValue(undefined);
    transport.poolConnect.mockResolvedValue({ query: transport.query, release: transport.release });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([undefined, 5000, 100, 0, false, .5, NaN, Infinity] as const)("bounds standalone startup timeout %s and ends once", async statement_timeout => {
    const t = input(), result = await predictQbModelOwned({ statement_timeout }, t.store, t.request);
    expect(result.response.status).toBe("available"); expect(result.response).not.toHaveProperty("connectionDisposition");
    expect(JSON.parse(result.serialized)).toEqual(result.response); expect(result.connectionDisposition).toBe("reusable");
    expect(transport.config).toMatchObject({ statement_timeout: statement_timeout === 100 ? 100 : 300, connectionTimeoutMillis: 300 });
    expect(transport.end).toHaveBeenCalledTimes(1); expect(transport.release).not.toHaveBeenCalled();
    expect(transport.query).toHaveBeenCalledTimes(3); expect(t.store.get).toHaveBeenCalledTimes(1);
  });
  it("releases a reusable pool client exactly once and never ends it directly", async () => {
    const t = input(), pool = new Pool({ statement_timeout: 100 });
    expect((await predictQbModelOwned(pool, t.store, t.request)).response.status).toBe("available");
    expect(transport.release).toHaveBeenCalledExactlyOnceWith(); expect(transport.end).not.toHaveBeenCalled();
  });
  it.each([undefined, false, 0, 301, .5, NaN, Infinity] as const)("refuses unsafe pool startup timeout %s before acquisition", async statement_timeout => {
    const t = input(), pool = new Pool({ statement_timeout });
    expect((await predictQbModelOwned(pool, t.store, t.request)).response).toEqual({ status: "unavailable", reason: "model-read-session-refused" });
    expect(transport.poolConnect).not.toHaveBeenCalled(); expect(transport.query).not.toHaveBeenCalled();
  });
  it.each([{ connectionString: "postgres://unused?statement_timeout=0" }, { pipeline: true }])("refuses overriding startup config %j", async config => {
    const t = input();
    for (const source of [config, new Pool({ ...config, statement_timeout: 300 })])
      expect((await predictQbModelOwned(source, t.store, t.request)).response).toEqual({ status: "unavailable", reason: "model-read-session-refused" });
    expect(transport.connect).not.toHaveBeenCalled(); expect(transport.poolConnect).not.toHaveBeenCalled();
  });
  it.each(["standalone", "pool"])("%s discard applies exactly one owner disposal even with a hung close", async kind => {
    const t = input(); transport.query.mockRejectedValue(Object.assign(new Error("private"), { code: "08006" }));
    transport.end.mockReturnValue(new Promise(() => {}));
    const result = await predictQbModelOwned(kind === "pool" ? new Pool({ statement_timeout: 300 }) : {}, t.store, t.request);
    expect(result.response).toEqual({ status: "unavailable", reason: "connection-interrupted" });
    expect(result.connectionDisposition).toBe("discard");
    if (kind === "pool") expect(transport.release).toHaveBeenCalledExactlyOnceWith(true);
    else expect(transport.end).toHaveBeenCalledTimes(1);
    expect(transport.query).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["standalone", "pool"])("%s acquisition failure returns no private diagnostics and cleans up owned resources", async kind => {
    const t = input(), error = new Error("private password/provider diagnostics");
    transport.connect.mockRejectedValue(error); transport.poolConnect.mockRejectedValue(error);
    const result = await predictQbModelOwned(kind === "pool" ? new Pool({ statement_timeout: 300 }) : {}, t.store, t.request);
    expect(result.response).toEqual({ status: "unavailable", reason: "prediction-unavailable" });
    expect(transport.end).toHaveBeenCalledTimes(kind === "standalone" ? 1 : 0); expect(transport.release).not.toHaveBeenCalled();
    expect(transport.query).not.toHaveBeenCalled();
  });
  it.each(["standalone", "pool"])("%s acquisition consumes the same deadline; late acquisition cannot query or double-dispose", async kind => {
    const t = input(), acquired = Promise.withResolvers<unknown>();
    transport.connect.mockReturnValue(acquired.promise); transport.poolConnect.mockReturnValue(acquired.promise);
    const result = predictQbModelOwned(kind === "pool" ? new Pool({ statement_timeout: 300 }) : {}, t.store, t.request, { deadlineAt: 50 });
    await vi.advanceTimersByTimeAsync(51);
    expect((await result).response).toEqual({ status: "unavailable", reason: "deadline-exceeded" });
    acquired.resolve({ query: transport.query, release: transport.release }); await vi.advanceTimersByTimeAsync(0);
    expect(transport.query).not.toHaveBeenCalled(); expect(t.store.get).not.toHaveBeenCalled();
    if (kind === "pool") expect(transport.release).toHaveBeenCalledExactlyOnceWith(true);
    else expect(transport.end).toHaveBeenCalledTimes(1);
  });
  it("captures caller pins before acquisition and gives the handler only the remaining allocation", async () => {
    const t = input(), playerId = t.request.playerId;
    transport.connect.mockImplementation(async () => { vi.advanceTimersByTime(100); t.request.playerId = "mutated"; });
    const result = await predictQbModelOwned({}, t.store, t.request);
    expect(result.response).toMatchObject({ status: "available", playerId });
    expect(transport.query.mock.calls[0][0].query_timeout).toBe(200);
  });
  it.each([Date.now(), 301, Infinity, NaN])("refuses invalid caller clock %s before connecting", async deadlineAt => {
    const t = input();
    expect((await predictQbModelOwned({}, t.store, t.request, { deadlineAt })).response).toEqual({ status: "unavailable", reason: "invalid-request" });
    expect(transport.connect).not.toHaveBeenCalled(); expect(transport.query).not.toHaveBeenCalled();
  });
  it("abort during acquisition destroys a late pool checkout without running the handler", async () => {
    const t = input(), acquired = Promise.withResolvers<unknown>(), controller = new AbortController();
    transport.poolConnect.mockReturnValue(acquired.promise);
    const pending = predictQbModelOwned(new Pool({ statement_timeout: 300 }), t.store, t.request, { signal: controller.signal });
    controller.abort(); expect((await pending).response).toEqual({ status: "unavailable", reason: "cancelled" });
    acquired.resolve({ query: transport.query, release: transport.release }); await vi.advanceTimersByTimeAsync(0);
    expect(transport.release).toHaveBeenCalledExactlyOnceWith(true); expect(transport.query).not.toHaveBeenCalled();
  });
  it.each(["context", "Q1", "Q2"])("owner cancellation during %s disposes once; late SQL cannot continue", async stage => {
    const t = input(), query = transport.query.getMockImplementation()!, entered = Promise.withResolvers<void>(), late = Promise.withResolvers<void>();
    transport.query.mockImplementation(async q => {
      const current = q.text.includes("resolve_model_context") ? "context" : q.values[2] ? "Q1" : "Q2";
      if (current === stage) { entered.resolve(); await late.promise; }
      return query(q);
    });
    const controller = new AbortController();
    const pending = predictQbModelOwned(new Pool({ statement_timeout: 300 }), t.store, t.request, { signal: controller.signal });
    await entered.promise; controller.abort();
    const result = await pending;
    expect(result.response).toEqual({ status: "unavailable", reason: "cancelled" }); expect(result.connectionDisposition).toBe("discard");
    expect(transport.release).toHaveBeenCalledExactlyOnceWith(true);
    const calls = transport.query.mock.calls.length; late.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.query).toHaveBeenCalledTimes(calls); expect(transport.release).toHaveBeenCalledTimes(1);
    expect(transport.end).not.toHaveBeenCalled();
  });
  it.each(["expired", "aborted"])("%s owner request does not acquire a connection", async kind => {
    const t = input(), controller = new AbortController(); if (kind === "aborted") controller.abort();
    const result = await predictQbModelOwned({}, t.store, t.request,
      { signal: controller.signal, ...(kind === "expired" ? { deadlineAt: -1 } : {}) });
    expect(result.response).toEqual({ status: "unavailable", reason: kind === "expired" ? "deadline-exceeded" : "cancelled" });
    expect(transport.connect).not.toHaveBeenCalled(); expect(transport.query).not.toHaveBeenCalled();
  });
  it("a close rejection cannot escape into the delivered prediction", async () => {
    const t = input(); transport.end.mockRejectedValue(new Error("close diagnostics"));
    expect((await predictQbModelOwned({}, t.store, t.request)).response.status).toBe("available");
    expect(transport.end).toHaveBeenCalledTimes(1);
  });
});
