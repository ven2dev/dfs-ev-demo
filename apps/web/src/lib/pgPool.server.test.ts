import { EventEmitter } from "node:events";
import { Pool, type PoolConfig, type PoolClient, type QueryConfig } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigurationError } from "./config.server";
import { createPgSql, PG_ACQUISITION_CEILING_MS } from "./pgSql";
import { createPgSqlOwner, verifiedPgConfiguration } from "./pgPool.server";

const url = "postgres://synthetic:synthetic-secret@database.invalid/synthetic?sslmode=require";
const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.end()));
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function fixture(max = 1, connectDelay = 0, connectionTimeoutMillis = PG_ACQUISITION_CEILING_MS) {
  const calls: string[] = [];
  const clients: SyntheticClient[] = [];
  const counts = { connections: 0, acquisitions: 0, releases: 0, discards: 0 };
  let operation: (config: QueryConfig) => Promise<unknown> = async () => ({ rows: [{ value: 1 }] });
  class SyntheticClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    pending?: (reason: unknown) => void;
    constructor() { super(); clients.push(this); }
    connect(callback: (error: Error | null) => void) {
      counts.connections++;
      if (connectDelay) setTimeout(() => callback(null), connectDelay);
      else queueMicrotask(() => callback(null));
    }
    query(config: QueryConfig) {
      calls.push(config.text);
      return new Promise((resolve, reject) => {
        this.pending = reject;
        void operation(config).then(resolve, reject);
      });
    }
    end(callback?: () => void) {
      this._ending = true;
      this.pending?.(new Error("Synthetic connection ended"));
      queueMicrotask(() => { this.emit("end"); callback?.(); });
    }
  }
  const pool = new Pool({ Client: SyntheticClient as unknown as PoolConfig["Client"],
    max, min: 0, connectionTimeoutMillis, idleTimeoutMillis: 5_000, maxLifetimeSeconds: 60 });
  pools.push(pool);
  pool.on("acquire", () => counts.acquisitions++);
  pool.on("release", error => { counts.releases++; if (error) counts.discards++; });
  return { pool, calls, clients, counts, sql: createPgSql(pool), operation: (run: typeof operation) => { operation = run; } };
}

it("validates one TLS/target policy and refuses URL overrides before pool creation", () => {
  const config = verifiedPgConfiguration(url, 2);
  expect(config).toMatchObject({ host: "database.invalid", max: 2, min: 0,
    ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 2_000, query_timeout: 15_000,
    idleTimeoutMillis: 5_000, maxLifetimeSeconds: 60 });
  expect(config).not.toHaveProperty("connectionString");
  for (const suffix of ["sslmode=disable", "sslmode=no-verify", "sslmode=require&sslmode=verify-full",
    "sslrootcert=/synthetic", "options=-c%20statement_timeout=0", "host=another.invalid", "sslnegotiation=direct"]) {
    expect(() => verifiedPgConfiguration(url.split("?")[0] + "?" + suffix, 2)).toThrow(ConfigurationError);
  }
  expect(() => verifiedPgConfiguration(url, 0)).toThrow(ConfigurationError);
});

it("validates on every cached reuse, creates no pool after refusal, and attaches only once", async () => {
  const f = fixture();
  let value = url;
  let refusal = false;
  const read = vi.fn(() => { if (refusal) throw new ConfigurationError("missing"); return value; });
  const create = vi.fn(() => f.pool);
  const attach = vi.fn();
  const owner = createPgSqlOwner({ maximum: 1, readConnectionString: read, createPool: create, attach });
  expect(create).not.toHaveBeenCalled();
  refusal = true; expect(() => owner.get()).toThrow(ConfigurationError); expect(create).not.toHaveBeenCalled();
  refusal = false;
  const first = owner.get(); expect(owner.get()).toBe(first);
  expect(read).toHaveBeenCalledTimes(3); expect(create).toHaveBeenCalledOnce(); expect(attach).toHaveBeenCalledOnce();
  expect(f.counts.connections).toBe(0);
  value = url.replace("database.invalid", "changed.invalid");
  expect(() => owner.get()).toThrow(ConfigurationError); expect(create).toHaveBeenCalledOnce();
  await owner.end();
  pools.splice(pools.indexOf(f.pool), 1);
  expect(() => owner.get()).toThrow(ConfigurationError);
});

it("normalizes query, initialization and background failures without message/cause/target leakage", async () => {
  const f = fixture();
  const failure = Object.assign(new Error("synthetic-secret"), { code: "23505", cause: { password: "synthetic-secret" } });
  f.operation(async () => { throw failure; });
  const reports: Error[] = [];
  const owner = createPgSqlOwner({ maximum: 1, readConnectionString: () => url, createPool: () => f.pool,
    attach: () => {}, onBackgroundError: error => { reports.push(error); throw failure; } });
  const sql = owner.get();
  const error = await sql.query("SELECT $1", ["synthetic-secret"]).catch(error => error);
  expect(error).toMatchObject({ code: "23505", message: "Application dependency unavailable." });
  expect(JSON.stringify(error) + error.stack).not.toContain("synthetic-secret");
  expect(() => f.pool.emit("error", failure)).not.toThrow();
  expect(reports).toHaveLength(1); expect(JSON.stringify(reports)).not.toContain("synthetic-secret");
  const rejected = createPgSqlOwner({ maximum: 1, readConnectionString: () => url,
    createPool: () => { throw failure; } });
  expect(() => rejected.get()).toThrow("Application dependency unavailable.");
});

it("expires a queued checkout at 2 seconds and sends no SQL", async () => {
  vi.useFakeTimers(); const f = fixture();
  const held = await f.pool.connect();
  const result = f.sql.query("SELECT must_not_run").catch(error => error);
  await vi.advanceTimersByTimeAsync(PG_ACQUISITION_CEILING_MS);
  expect(await result).toBeInstanceOf(Error);
  expect(f.calls).toEqual([]); expect(f.pool.waitingCount).toBe(0);
  held.release(); expect(f.counts.releases).toBe(1);
});

it("failed lifecycle attachment closes its pool before any query and returns a sanitized error", async () => {
  const f = fixture(); const end = vi.spyOn(f.pool, "end");
  const owner = createPgSqlOwner({ maximum: 1, readConnectionString: () => url, createPool: () => f.pool,
    attach: () => { throw new Error("synthetic-secret"); } });
  expect(() => owner.get()).toThrow("Application dependency unavailable.");
  expect(end).toHaveBeenCalledOnce(); expect(f.counts.connections).toBe(0);
  pools.splice(pools.indexOf(f.pool), 1);
});

it("cancellation during rollback promptly discards and preserves the original SQL failure", async () => {
  const f = fixture(); const rollback = Promise.withResolvers<void>();
  const failure = Object.assign(new Error("synthetic SQL failure"), { code: "23505" });
  f.operation(async config => {
    if (config.text === "INSERT synthetic") throw failure;
    if (config.text === "ROLLBACK") { rollback.resolve(); return new Promise(() => {}); }
    return { rows: [] };
  });
  const controller = new AbortController();
  const result = f.sql.transaction(tx => [tx.query("INSERT synthetic")],
    { fetchOptions: { signal: controller.signal } }).catch(error => error);
  await rollback.promise; controller.abort(new Error("synthetic cancellation"));
  expect(await result).toBe(failure); expect(f.counts.discards).toBe(1);
  expect(f.counts.releases).toBe(1); expect(f.calls).toEqual(["BEGIN", "INSERT synthetic", "ROLLBACK"]);
});

it("a shorter original signal expires during checkout and releases a late client without SQL", async () => {
  vi.useFakeTimers(); const f = fixture(); const held = await f.pool.connect();
  const controller = new AbortController();
  const result = f.sql.transaction(tx => [tx.query("SELECT must_not_run")],
    { fetchOptions: { signal: controller.signal } }).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("synthetic cancellation"));
  expect((await result).message).toBe("synthetic cancellation");
  held.release(); await vi.advanceTimersByTimeAsync(0);
  expect(f.calls).toEqual([]); expect(f.counts.acquisitions).toBe(2); expect(f.counts.releases).toBe(2);
  expect(f.pool.waitingCount).toBe(0);
});

it("a connection completing after the adapter ceiling is returned unused", async () => {
  // Deliberately disable pg's own timeout to prove the adapter ceiling and its
  // late-client continuation independently of the transport's timeout.
  vi.useFakeTimers(); const f = fixture(1, 2_100, 0);
  const result = f.sql.query("SELECT must_not_run").catch(error => error);
  await vi.advanceTimersByTimeAsync(2_101);
  expect(await result).toBeInstanceOf(Error); expect(f.calls).toEqual([]);
  expect(f.counts.releases).toBe(1); expect(f.pool.waitingCount).toBe(0);
});

it("cancellation destroys the active transaction client once, stops later SQL and observes late failure", async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>();
  f.operation(async config => {
    if (config.text === "SELECT held") { entered.resolve(); return new Promise(() => {}); }
    return { rows: [] };
  });
  const controller = new AbortController();
  const result = f.sql.transaction(tx => [tx.query("SELECT held"), tx.query("SELECT must_not_run")],
    { fetchOptions: { signal: controller.signal } }).catch(error => error);
  await entered.promise; controller.abort(new Error("synthetic cancellation"));
  expect((await result).message).toBe("synthetic cancellation");
  expect(f.calls).toEqual(["BEGIN", "SELECT held"]); expect(f.counts.discards).toBe(1);
  expect(f.counts.releases).toBe(1); expect(f.pool.totalCount).toBe(0);
});

it("queue and SQL consume the same caller signal without resetting its clock", async () => {
  vi.useFakeTimers(); const f = fixture(); const held = await f.pool.connect();
  f.operation(async config => {
    if (config.text === "SELECT held") await new Promise(resolve => setTimeout(resolve, 60));
    return { rows: [] };
  });
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error("original allowance expired")), 100);
  const result = f.sql.transaction(tx => [tx.query("SELECT held"), tx.query("SELECT must_not_run")],
    { fetchOptions: { signal: controller.signal } }).catch(error => error);
  await vi.advanceTimersByTimeAsync(60); held.release();
  await vi.advanceTimersByTimeAsync(40);
  expect((await result).message).toBe("original allowance expired");
  expect(f.calls).toEqual(["BEGIN", "SELECT held"]); expect(f.counts.discards).toBe(1);
});

it("an uncertain transport failure discards instead of queuing rollback or replay", async () => {
  const f = fixture(); f.operation(async config => {
    if (config.text === "INSERT synthetic") throw new Error("synthetic transport timeout");
    return { rows: [] };
  });
  await expect(f.sql.transaction(tx => [tx.query("INSERT synthetic")])).rejects.toThrow("synthetic transport timeout");
  expect(f.calls).toEqual(["BEGIN", "INSERT synthetic"]); expect(f.counts.discards).toBe(1);
});

it("the actual Vercel helper holds concurrent releases until pg idle cleanup", async () => {
  vi.useFakeTimers(); vi.stubEnv("VERCEL_URL", "synthetic.invalid"); vi.stubEnv("VERCEL_REGION", "iad1");
  const pending: Promise<unknown>[] = [];
  const context = Symbol.for("@vercel/request-context");
  const global = globalThis as typeof globalThis & { [context]?: { get: () => object } };
  const previous = global[context];
  global[context] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }) };
  try {
    const f = fixture(2); const owner = createPgSqlOwner({ maximum: 2, readConnectionString: () => url, createPool: () => f.pool });
    owner.get(); const clients = await Promise.all([f.pool.connect(), f.pool.connect()]);
    clients.forEach(client => client.release()); expect(pending).toHaveLength(2);
    expect(f.pool.totalCount).toBe(2);
    await vi.advanceTimersByTimeAsync(5_100); await Promise.all(pending);
    expect(f.pool.totalCount).toBe(0); expect(f.counts.releases).toBe(2);
  } finally { if (previous) global[context] = previous; else delete global[context]; }
});

it("pg retires idle errors and lifetime-expired held clients without double release", async () => {
  vi.useFakeTimers(); const f = fixture(); const errors: Error[] = [];
  createPgSqlOwner({ maximum: 1, readConnectionString: () => url, createPool: () => f.pool,
    attach: () => {}, onBackgroundError: error => errors.push(error) }).get();
  const client = await f.pool.connect(); client.release();
  f.clients[0].emit("error", new Error("synthetic-secret"));
  expect(errors).toHaveLength(1); expect(f.pool.totalCount).toBe(0);
  const next: PoolClient = await f.pool.connect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.pool.totalCount).toBe(1); next.release(); expect(f.pool.totalCount).toBe(0);
  expect(f.counts.releases).toBe(2);
});
