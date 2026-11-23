import { EventEmitter } from "node:events";
import { neon, neonConfig } from "@neondatabase/serverless";
import { Pool, Query, types as pgTypes, type FieldDef, type PoolConfig, type QueryConfig, type QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgSql, type SqlRow, type SqlTransactionOptions, type TransactionStatement } from "./pgSql";

type WireResult = { fields: { name: string; dataTypeID: number }[]; rows: (string | null)[][] };
type RowDecoder = {
  handleRowDescription(message: { fields: FieldDef[] }): void;
  handleDataRow(message: { fields: (string | null)[] }): void;
  handleCommandComplete(message: { text: string }): void;
  handleReadyForQuery(): void;
};

// Feed the installed pg Query row decoder synthetic protocol events, not an
// imitation parser. Real wire, isolation and rollback proof belongs to A2.
function decode(config: QueryConfig<unknown[]>, wire: WireResult): Promise<QueryResult<SqlRow>> {
  return new Promise((resolve, reject) => {
    const query = new Query<SqlRow>(config, (error, result) =>
      error ? reject(error) : resolve(result));
    const decoder = query as unknown as RowDecoder;
    decoder.handleRowDescription({ fields: wire.fields.map(field => ({ ...field,
      tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: "text" })) });
    for (const fields of wire.rows) decoder.handleDataRow({ fields });
    decoder.handleCommandComplete({ text: `SELECT ${wire.rows.length}` });
    decoder.handleReadyForQuery();
  });
}

const pools: Pool[] = [];
const originalFetch = neonConfig.fetchFunction;
afterEach(async () => {
  neonConfig.fetchFunction = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map(pool => pool.end()));
});

function fixture(wire: WireResult = { fields: [{ name: "id", dataTypeID: 23 }], rows: [["1"]] }) {
  const trace: { client: number; config: QueryConfig<unknown[]> }[] = [];
  const failures = new Map<string, Error>();
  const counts = { connects: 0, acquires: 0, releases: 0, discards: 0 };
  let clientId = 0;
  let onQuery: ((text: string) => void) | undefined;
  class SyntheticClient extends EventEmitter {
    readonly id = ++clientId;
    _queryable = true;
    _ending = false;
    connect(callback: (error: Error | null) => void) { counts.connects++; queueMicrotask(() => callback(null)); }
    query(config: QueryConfig<unknown[]>,
      valuesOrCallback?: unknown[] | ((error: Error | null, result?: QueryResult<SqlRow>) => void),
      poolCallback?: (error: Error | null, result?: QueryResult<SqlRow>) => void) {
      const callback = typeof valuesOrCallback === "function" ? valuesOrCallback : poolCallback;
      trace.push({ client: this.id, config });
      onQuery?.(config.text);
      const result = failures.has(config.text) ? Promise.reject(failures.get(config.text)) :
        decode(config, /^(BEGIN|COMMIT|ROLLBACK)\b/.test(config.text) ? { fields: [], rows: [] } : wire);
      if (callback) { result.then(value => callback(null, value), error => callback(error)); return; }
      return result;
    }
    end(callback?: () => void) { this._ending = true; queueMicrotask(() => { this.emit("end"); callback?.(); }); }
  }
  const pool = new Pool({ Client: SyntheticClient as unknown as PoolConfig["Client"], max: 1, idleTimeoutMillis: 0 });
  pool.on("acquire", () => counts.acquires++);
  pool.on("release", error => { counts.releases++; if (error) counts.discards++; });
  pools.push(pool);
  return { pool, sql: createPgSql(pool), trace, counts, failures,
    onQuery: (hook: (text: string) => void) => { onQuery = hook; } };
}

describe("#309 query rows and installed-driver decoding parity", () => {
  it.each([0, 1, 3])("returns %i rows including empty RETURNING, without pg metadata", async count => {
    const f = fixture({ fields: [{ name: "id", dataTypeID: 23 }], rows: Array.from({ length: count }, (_, i) => [String(i + 1)]) });
    expect(await f.sql.query("INSERT INTO synthetic DEFAULT VALUES RETURNING id")).toEqual(
      Array.from({ length: count }, (_, i) => ({ id: i + 1 })));
    expect(f.counts).toEqual({ connects: 1, acquires: 1, releases: 1, discards: 0 });
    expect(f.trace).toHaveLength(1);
  });

  it("reuses the warm connection and binds values separately without a statement name", async () => {
    const f = fixture();
    await f.sql.query("SELECT 1");
    const input = ["synthetic'); DROP TABLE synthetic; --", null, ["one", "two"], { nested: true }];
    const text = "SELECT $1, $2, $3, $4";
    await f.sql.query(text, input);
    expect(f.counts).toEqual({ connects: 1, acquires: 2, releases: 2, discards: 0 });
    expect(f.trace.map(q => q.config.text)).toEqual(["SELECT 1", text]);
    expect(f.trace[1].config.values).toEqual(input);
    expect(f.trace[1].config).not.toHaveProperty("name");
    expect(f.trace[1].config.values).not.toBe(input);
  });

  const cases: [string, number, string | null, unknown][] = [
    ["integer id", 23, "2147483647", 2147483647],
    ["bigint beyond JS integer range", 20, "9007199254740993", "9007199254740993"],
    ["negative bigint", 20, "-9007199254740993", "-9007199254740993"],
    ["decimal precision", 1700, "123456789.123456789", "123456789.123456789"],
    ["floating point", 701, "1.75", 1.75],
    ["boolean", 16, "t", true],
    ["SQL null", 23, null, null],
    ["JSON", 114, '{"source":"synthetic","empty":null}', { source: "synthetic", empty: null }],
    ["JSONB", 3802, '{"values":[1,true,null]}', { values: [1, true, null] }],
    ["integer array", 1007, "{1,NULL,-2}", [1, null, -2]],
    ["bigint array", 1016, "{9007199254740993,NULL,-9007199254740993}", ["9007199254740993", null, "-9007199254740993"]],
    ["escaped text array", 1009, '{"a,b","NULL",NULL,"a\\\\b"}', ["a,b", "NULL", null, "a\\b"]],
    ["date as text", 25, "2026-11-23", "2026-11-23"],
    ["timestamp precision as text", 25, "2026-11-23 12:34:56.123456+00", "2026-11-23 12:34:56.123456+00"],
  ];
  it.each(cases)("matches Neon for %s", async (_name, oid, value, expected) => {
    const wire = { fields: [{ name: "value", dataTypeID: oid }], rows: [[value]] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 }));
    neonConfig.fetchFunction = fetch;
    const oldRows = await neon("postgres://synthetic:synthetic@comparison.invalid/synthetic").query("SELECT synthetic");
    const f = fixture(wire);
    const newRows = await f.sql.query("SELECT synthetic");
    expect(newRows).toEqual([{ value: expected }]);
    expect(newRows).toEqual(oldRows);
    expect(JSON.stringify(newRows)).toBe(JSON.stringify(oldRows));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Kolkata"])("preserves date/timezone and existing precision in %s without global parser changes", async timezone => {
    vi.stubEnv("TZ", timezone);
    const wire: WireResult = {
      fields: [
        { name: "day", dataTypeID: 1082 }, { name: "local", dataTypeID: 1114 },
        { name: "offset", dataTypeID: 1184 }, { name: "precise", dataTypeID: 1184 },
        { name: "dates", dataTypeID: 1185 },
      ],
      rows: [["2026-11-23", "2026-11-23 12:34:56.123456", "2026-11-23 12:34:56.123456+05:30",
        "2026-11-23 12:34:56.123999+00", '{"2026-11-23 12:34:56.123456+00",NULL}']],
    };
    const oids = [20, 23, 1082, 1114, 1184, 1700, 3802, 1185];
    const before = oids.map(oid => pgTypes.getTypeParser(oid, "text"));
    neonConfig.fetchFunction = async () => new Response(JSON.stringify(wire), { status: 200 });
    const oldRows = await neon("postgres://synthetic:synthetic@comparison.invalid/synthetic").query("SELECT synthetic");
    const f = fixture(wire);
    const actual = await f.sql.query("SELECT synthetic");
    expect(actual).toEqual(oldRows);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(oldRows));
    expect(actual[0].day).toEqual(new Date(2026, 10, 23));
    expect(actual[0].local).toEqual(new Date(2026, 10, 23, 12, 34, 56, 123));
    expect(actual[0].offset).toEqual(new Date("2026-11-23T07:04:56.123Z"));
    expect(actual[0].precise).toEqual(new Date("2026-11-23T12:34:56.123Z"));
    oids.forEach((oid, i) => expect(pgTypes.getTypeParser(oid, "text")).toBe(before[i]));
  });

  it.each([
    { text: "SELECT 1", name: "persistent" },
    "PREPARE persistent AS SELECT 1",
    "SELECT 1; prepare persistent AS SELECT 2",
  ])("refuses query configs and persistent SQL names before checkout: %j", async input => {
    const f = fixture();
    await expect(f.sql.query(input as string)).rejects.toThrow("Database query contract is invalid.");
    expect(f.counts.connects).toBe(0);
    expect(f.trace).toEqual([]);
  });
});

describe("#309 deferred single-client transactions", () => {
  it("preserves creator ordering/IDs with four statements plus two controls on one client", async () => {
    const f = fixture();
    const statements = ["SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", "INSERT INTO synthetic_creator VALUES ($1)",
      "INSERT INTO synthetic_submission VALUES ($1) RETURNING id", "SELECT id FROM synthetic_submission WHERE url=$1"];
    const results = await f.sql.transaction(tx => {
      const deferred = statements.map(text => tx.query(text, ["synthetic"]));
      expect(f.trace).toEqual([]);
      expect(f.counts.acquires).toBe(0);
      expect(deferred[0]).not.toHaveProperty("then");
      return deferred;
    });
    expect(results).toEqual(Array.from({ length: 4 }, () => [{ id: 1 }]));
    expect(f.trace.map(q => q.config.text)).toEqual(["BEGIN", ...statements, "COMMIT"]);
    expect(new Set(f.trace.map(q => q.client)).size).toBe(1);
    expect(f.counts).toEqual({ connects: 1, acquires: 1, releases: 1, discards: 0 });
    for (const query of f.trace) expect(query.config).not.toHaveProperty("name");
  });

  it.each([2, 3])("carries readiness options into BEGIN with %i domain statements", async count => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.sql.transaction(tx => Array.from({ length: count }, (_, i) => tx.query("SELECT $1::int", [i])),
      { readOnly: true, isolationLevel: "RepeatableRead", fetchOptions: { signal } });
    expect(f.trace.map(q => q.config.text)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", ...Array(count).fill("SELECT $1::int"), "COMMIT"]);
    expect(f.counts.acquires).toBe(1);
    expect(f.counts.releases).toBe(1);
  });

  it("refuses a throwing, async or foreign transaction builder without connecting", async () => {
    const f = fixture();
    await expect(f.sql.transaction(() => { throw new Error("synthetic builder"); })).rejects.toThrow("synthetic builder");
    await expect(f.sql.transaction((async () => []) as unknown as () => TransactionStatement[])).rejects.toThrow("deferred statements");
    await expect(f.sql.transaction(() => [{} as TransactionStatement])).rejects.toThrow("deferred statements");
    expect(f.counts.connects).toBe(0);
  });

  it("rejects statements retained from a different batch", async () => {
    const f = fixture();
    let retained: TransactionStatement;
    await f.sql.transaction(tx => { retained = tx.query("SELECT 1"); return []; });
    const acquisitions = f.counts.acquires;
    await expect(f.sql.transaction(() => [retained])).rejects.toThrow("deferred statements");
    expect(f.counts.acquires).toBe(acquisitions);
  });

  it("snapshots batch membership and parameter arrays before awaiting checkout", async () => {
    const f = fixture();
    const params = ["original"];
    let batch: TransactionStatement[] = [];
    const pending = f.sql.transaction(tx => { batch = [tx.query("SELECT $1", params)]; return batch; });
    params[0] = "changed";
    batch.length = 0;
    await pending;
    expect(f.trace.map(q => q.config.text)).toEqual(["BEGIN", "SELECT $1", "COMMIT"]);
    expect(f.trace[1].config.values).toEqual(["original"]);
  });

  it("rolls back a statement failure, stops later statements and never replays", async () => {
    const f = fixture();
    const error = new Error("synthetic statement refusal");
    f.failures.set("INSERT synthetic", error);
    await expect(f.sql.transaction(tx => [tx.query("INSERT synthetic"), tx.query("SELECT must_not_run")])).rejects.toBe(error);
    expect(f.trace.map(q => q.config.text)).toEqual(["BEGIN", "INSERT synthetic", "ROLLBACK"]);
    expect(f.counts).toEqual({ connects: 1, acquires: 1, releases: 1, discards: 0 });
  });

  it("discards on rollback failure while retaining the original failure", async () => {
    const f = fixture();
    const original = new Error("synthetic write refusal");
    f.failures.set("INSERT synthetic", original);
    f.failures.set("ROLLBACK", new Error("synthetic rollback refusal"));
    await expect(f.sql.transaction(tx => [tx.query("INSERT synthetic")])).rejects.toBe(original);
    expect(f.counts.discards).toBe(1);
    expect(f.pool.totalCount).toBe(0);
  });

  it.each(["BEGIN", "COMMIT"])("discards an uncertain %s failure without replay", async control => {
    const f = fixture();
    const failure = new Error("synthetic control refusal");
    f.failures.set(control, failure);
    await expect(f.sql.transaction(tx => [tx.query("INSERT synthetic")])).rejects.toBe(failure);
    expect(f.trace.map(q => q.config.text)).toEqual(control === "BEGIN" ? ["BEGIN"] : ["BEGIN", "INSERT synthetic", "COMMIT"]);
    expect(f.counts.discards).toBe(1);
    expect(f.pool.totalCount).toBe(0);
  });

  it("retains the original readiness signal and stops the batch before any later SQL", async () => {
    const f = fixture();
    const controller = new AbortController();
    const refusal = new Error("synthetic cancellation");
    f.onQuery(text => { if (text === "SELECT first") controller.abort(refusal); });
    await expect(f.sql.transaction(tx => [tx.query("SELECT first"), tx.query("SELECT must_not_run")],
      { fetchOptions: { signal: controller.signal } })).rejects.toBe(refusal);
    expect(f.trace.map(q => q.config.text)).toEqual(["BEGIN", "SELECT first"]);
    expect(f.counts.discards).toBe(1);
  });

  it("refuses a pre-aborted readiness batch before the builder or connection", async () => {
    const f = fixture();
    const builder = vi.fn(() => []);
    await expect(f.sql.transaction(builder, { fetchOptions: { signal: AbortSignal.abort() } })).rejects.toThrow();
    expect(builder).not.toHaveBeenCalled();
    expect(f.counts.connects).toBe(0);
  });

  it("refuses unsupported transaction options before checkout instead of silently dropping them", async () => {
    const f = fixture();
    await expect(f.sql.transaction(() => [], { isolationLevel: "unsafe synthetic" } as unknown as SqlTransactionOptions))
      .rejects.toThrow("options are invalid");
    await expect(f.sql.transaction(() => [], { fetchOptions: { headers: { secret: "synthetic" } } } as unknown as SqlTransactionOptions))
      .rejects.toThrow("options are invalid");
    expect(f.counts.connects).toBe(0);
  });
});
