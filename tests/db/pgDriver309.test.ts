import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Client, Pool, type PoolConfig, type QueryConfig } from "pg";
import { expect, it, vi } from "vitest";
import { createScratchHarness } from "@dfs-ev/db-tooling/test-support/scratch";
import { withMigratedDatabase, type ScratchConfig } from "@dfs-ev/db-tooling/test-support/migrated";
import { createPgSql, type Sql, type SqlRow } from "../../apps/web/src/lib/pgSql";
import { admitPaidOdds, createLivePropCacheStore, getOrRefresh, getSharedOddsBatch } from "@dfs-ev/db/runtime";

const binding = vi.hoisted(() => ({ sql: undefined as Sql | undefined }));
vi.mock("../../apps/web/src/lib/db", () => ({ getSql: () => {
  if (!binding.sql) throw new Error("Synthetic adapter binding missing"); return binding.sql;
} }));

async function withScratch(run: (admin: Client, config: ScratchConfig) => Promise<void>) {
  const harness = await createScratchHarness(process.env);
  try { await harness.withDatabase(run); } finally { await harness.close(); }
}

function instrument(config: ScratchConfig, max = 2, extra: PoolConfig = {}) {
  const trace: string[] = [];
  const protocol: { name: string; kind: string }[] = [];
  const counts = { connects: 0, acquisitions: 0, releases: 0, discards: 0, peak: 0 };
  const timing = { connectionMs: [] as number[], checkoutMs: [] as number[], sqlMs: [] as number[] };
  class TimedClient extends Client { readonly createdAt = performance.now(); }
  const pool = new Pool({ ...config, ...extra, Client: TimedClient, max, min: 0, connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000, maxLifetimeSeconds: 60 });
  pool.on("connect", client => {
    counts.connects++;
    timing.connectionMs.push(performance.now() - (client as unknown as TimedClient).createdAt);
    const original = client.query.bind(client);
    client.query = ((query: QueryConfig | string) => {
      trace.push(typeof query === "string" ? query : query.text);
      const started = performance.now();
      return original(query).finally(() => timing.sqlMs.push(performance.now() - started));
    }) as typeof client.query;
    const connection = (client as unknown as { connection: {
      parse(config: { name?: string }): void;
      bind(config: { statement?: string; portal?: string }): void;
    } }).connection;
    const parse = connection.parse.bind(connection), bind = connection.bind.bind(connection);
    connection.parse = config => { protocol.push({ kind: "parse", name: config.name ?? "" }); return parse(config); };
    connection.bind = config => {
      protocol.push({ kind: "bind", name: config.statement ?? "" }, { kind: "portal", name: config.portal ?? "" }); return bind(config);
    };
  });
  pool.on("acquire", () => { counts.acquisitions++; counts.peak = Math.max(counts.peak, pool.totalCount - pool.idleCount); });
  pool.on("release", error => { counts.releases++; if (error) counts.discards++; });
  // Idle backend terminations are expected in the timeout proof, never raw-logged.
  pool.on("error", () => {});
  // The adapter uses the public promise checkout API. Its duration includes
  // connection establishment when cold, or queue wait when the pool is full.
  const dependency = { connect: async () => {
    const started = performance.now();
    try { return await pool.connect(); } finally { timing.checkoutMs.push(performance.now() - started); }
  } } as Pick<Pool, "connect">;
  return { pool, sql: createPgSql(dependency), trace, protocol, counts, timing };
}

it("pg309 real wire preserves decoding, public serialization and unnamed protocol", async () => {
  await withScratch(async (_admin, config) => {
    const f = instrument(config);
    try {
      const [row] = await f.sql.query(`SELECT $1::bigint AS big,$2::numeric AS precise,$3::jsonb AS json,
        $4::int[] AS array,$5::text AS nil,$6::timestamptz AS instant,$6::timestamptz::text AS full,
        DATE '2026-11-23' AS day,TIMESTAMP '2026-11-23 12:34:56.123456' AS local`,
      ["9007199254740993", "123456789.123456789", { synthetic: true }, [1, null, 3], null, "2026-11-23T12:34:56.123456Z"]);
      expect(row).toMatchObject({ big: "9007199254740993", precise: "123456789.123456789", json: { synthetic: true }, array: [1, null, 3], nil: null });
      expect(JSON.parse(JSON.stringify(row))).toMatchObject({ instant: "2026-11-23T12:34:56.123Z" });
      expect(row.full).toContain(".123456"); expect(row.day).toBeInstanceOf(Date); expect(row.local).toBeInstanceOf(Date);
      await f.sql.query("SELECT $1::int AS value", [1]);
      expect(f.protocol.filter(event => event.kind === "parse").length).toBeGreaterThan(0);
      expect(f.protocol.every(event => event.name === "")).toBe(true);
      expect(f.counts).toMatchObject({ connects: 1, acquisitions: 2, releases: 2, discards: 0 });
      expect(f.trace).toHaveLength(2); // no per-borrow setup SQL
    } finally { await f.pool.end(); }
  });
});

it("pg309 real creator race returns one ID and rolls back a later statement failure", async () => {
  await withScratch(async (admin, config) => {
    await admin.query(await readFile(new URL("../../packages/db/tooling/tests/fixtures/current-before-60.schema.sql", import.meta.url), "utf8"));
    const f = instrument(config); binding.sql = f.sql;
    try {
      const { insertSubmission } = await import("../../apps/web/src/lib/creatorSubmissionsRepo");
      const input = { channelName: "Synthetic channel", videoUrl: "https://synthetic.invalid/one", transcriptText: "synthetic" };
      await admin.query("BEGIN");
      await admin.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [input.videoUrl]);
      const race = Promise.all([insertSubmission(input), insertSubmission(input)]);
      try {
        await vi.waitFor(async () => expect((await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"
        )).rows[0].n).toBe(2));
      } finally { await admin.query("COMMIT"); }
      const results = await race;
      expect(results.map(row => row.status).sort()).toEqual(["already-submitted", "inserted"]);
      expect(new Set(results.map(row => row.id)).size).toBe(1);
      expect((await admin.query("SELECT count(*)::int n FROM creator_video_submissions")).rows[0].n).toBe(1);
      expect(f.trace.filter(text => /^(BEGIN|COMMIT)$/.test(text))).toHaveLength(4);
      expect(f.trace).toHaveLength(12); expect(f.counts.acquisitions).toBe(2); expect(f.counts.releases).toBe(2);
      await admin.query(`CREATE FUNCTION public.synthetic_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic refusal'; END $$;
        CREATE TRIGGER synthetic_refuse BEFORE INSERT ON creator_video_submissions FOR EACH ROW EXECUTE FUNCTION public.synthetic_refuse()`);
      await expect(insertSubmission({ ...input, channelName: "Rolled back channel", videoUrl: "https://synthetic.invalid/two" })).rejects.toMatchObject({ code: "P0001" });
      expect((await admin.query("SELECT count(*)::int n FROM creators WHERE channel_name='Rolled back channel'")).rows[0].n).toBe(0);
      expect(f.trace.at(-1)).toBe("ROLLBACK"); expect(f.counts.discards).toBe(0);
      expect(f.protocol.every(event => event.name === "")).toBe(true);
    } finally { binding.sql = undefined; await f.pool.end(); }
  });
});

it("pg309 real readiness skips absent ledger and detects DDL between its two batches", async () => {
  await withScratch(async (admin, config) => {
    await admin.query(await readFile(new URL("../../packages/db/tooling/tests/fixtures/current-before-60.schema.sql", import.meta.url), "utf8"));
    const f = instrument(config); binding.sql = f.sql;
    try {
      const { getDatabaseReadinessSnapshot } = await import("../../apps/web/src/lib/dbReadinessRepo");
      expect(await getDatabaseReadinessSnapshot()).toMatchObject({ ledgerPresent: false, history: [] });
      expect(f.trace).toHaveLength(4); // BEGIN + settings + relations + COMMIT
      expect(f.trace.some(text => text.includes("FROM public.db_migrations"))).toBe(false);
    } finally { binding.sql = undefined; await f.pool.end(); }
  });
  await withMigratedDatabase(process.env, async (admin, target) => {
    target.assertTarget(target.expected);
    const f = instrument(target.expected); let batches = 0;
    binding.sql = { ...f.sql, transaction: async (...args) => {
      const results = await f.sql.transaction(...args);
      if (++batches === 1) await admin.query("DROP TABLE sync_state");
      return results;
    } };
    try {
      const { getDatabaseReadinessSnapshot } = await import("../../apps/web/src/lib/dbReadinessRepo");
      expect(await getDatabaseReadinessSnapshot()).toMatchObject({ ledgerPresent: true, requiredTablesPresent: false });
      expect(batches).toBe(2); expect(f.trace).toHaveLength(9);
      expect(f.trace.filter(text => text.startsWith("BEGIN"))).toEqual(Array(2).fill("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    } finally { binding.sql = undefined; await f.pool.end(); }
  });
});

it("pg309 real Repeatable Read snapshot is stable and writes are refused", async () => {
  await withScratch(async (admin, config) => {
    await admin.query("CREATE TABLE synthetic_snapshot (n int); INSERT INTO synthetic_snapshot VALUES(1)");
    const f = instrument(config, 1);
    let reads = 0;
    // Interleave a committed write after the first actual query result, with a
    // barrier at the adapter's transport boundary rather than a timing sleep.
    f.pool.on("connect", client => {
      const query = client.query.bind(client);
      client.query = (async (input: QueryConfig) => {
        const result = await query(input);
        if (input.text === "SELECT n FROM synthetic_snapshot" && ++reads === 1) await admin.query("UPDATE synthetic_snapshot SET n=2");
        return result;
      }) as typeof client.query;
    });
    try {
      const results = await f.sql.transaction(tx => [tx.query("SELECT n FROM synthetic_snapshot"), tx.query("SELECT n FROM synthetic_snapshot")],
        { readOnly: true, isolationLevel: "RepeatableRead" });
      expect(results).toEqual([[{ n: 1 }], [{ n: 1 }]]);
      expect((await admin.query("SELECT n FROM synthetic_snapshot")).rows).toEqual([{ n: 2 }]);
      await expect(f.sql.transaction(tx => [tx.query("DELETE FROM synthetic_snapshot")],
        { readOnly: true, isolationLevel: "RepeatableRead" })).rejects.toMatchObject({ code: "25006" });
      expect(f.trace.at(-1)).toBe("ROLLBACK");
    } finally { await f.pool.end(); }
  });
});

it("pg309 real backend timeouts fire on fresh and reused clients without local-setting leakage", async () => {
  await withScratch(async (admin, config) => {
    // Database defaults are local fixture setup, not startup assertions. These
    // hypotheses need role/pooler enforcement at cutover, on reassigned backends.
    await admin.query(`ALTER DATABASE "${config.database}" SET statement_timeout='5s'`);
    await admin.query(`ALTER DATABASE "${config.database}" SET lock_timeout='1s'`);
    await admin.query(`ALTER DATABASE "${config.database}" SET idle_in_transaction_session_timeout='5s'`);
    await admin.query("CREATE TABLE synthetic_lock(n int)");
    const f = instrument(config, 1, { statement_timeout: 0, query_timeout: 15_000 });
    const settings = "SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await f.sql.query(settings))[0]).toEqual({ statement: "5s", lock: "1s", idle: "5s" });
        await expect(f.sql.transaction(tx => [tx.query("SELECT pg_sleep(10)")])).rejects.toMatchObject({ code: "57014" });
      }
      expect(f.counts.connects).toBe(1); // same backend across both timeouts
      // A server SQL error is rolled back, retaining a healthy connection.
      await admin.query("BEGIN; LOCK TABLE synthetic_lock IN ACCESS EXCLUSIVE MODE");
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(f.sql.transaction(tx => [tx.query("SELECT * FROM synthetic_lock")])).rejects.toMatchObject({ code: "55P03" });
        }
      } finally { await admin.query("ROLLBACK"); }
      await f.sql.transaction(tx => [tx.query("SELECT set_config('statement_timeout','2s',true),set_config('lock_timeout','500ms',true)")]);
      expect((await f.sql.query(settings))[0]).toEqual({ statement: "5s", lock: "1s", idle: "5s" });
      const held = await f.pool.connect(); const ended = Promise.withResolvers<Error>();
      held.once("error", error => ended.resolve(error));
      await held.query("BEGIN");
      expect(await ended.promise).toMatchObject({ code: "25P03" }); held.release(true);
      expect((await f.sql.query(settings))[0]).toEqual({ statement: "5s", lock: "1s", idle: "5s" });
    } finally { await f.pool.end(); }
  });
}, 30_000);

it("pg309 real cancellation discards its client and the server contains abandoned work", async () => {
  await withScratch(async (admin, config) => {
    await admin.query(`ALTER DATABASE "${config.database}" SET statement_timeout='1s'`);
    const f = instrument(config, 1, { statement_timeout: 0 });
    const controller = new AbortController();
    try {
      const started = Promise.withResolvers<number>();
      f.pool.on("connect", client => { started.resolve((client as unknown as { processID: number }).processID); });
      const pending = f.sql.transaction(tx => [tx.query("SELECT pg_sleep(10)"), tx.query("SELECT 999")],
        { fetchOptions: { signal: controller.signal } }).catch(error => error);
      const pid = await started.promise;
      // Observe the actual backend entering pg_sleep before cancellation.
      await vi.waitFor(async () => expect((await admin.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event).toBe("PgSleep"));
      controller.abort(new Error("synthetic cancellation"));
      expect((await pending).message).toBe("synthetic cancellation");
      expect(f.trace).toEqual(["BEGIN", "SELECT pg_sleep(10)"]); expect(f.counts.discards).toBe(1);
      // Socket closure is not a claim of immediate backend cancellation. The
      // server timeout supplies the independent containment bound.
      await vi.waitFor(async () => expect((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0].n).toBe(0), { timeout: 3_000 });
      expect(f.pool.totalCount).toBe(0);
    } finally { await f.pool.end(); }
  });
});

it("pg309 twenty composed leaders span two bounded owners and overlapping generations", async () => {
  await withMigratedDatabase(process.env, async (admin, target) => {
    target.assertTarget(target.expected);
    for (const file of ["221_shared_odds_cache.sql", "223_paid_leader_gcra.sql"]) {
      await admin.query(await readFile(new URL("../../packages/db/proposals/" + file, import.meta.url), "utf8"));
    }
    const owners = [instrument(target.expected, 2), instrument(target.expected, 2)];
    const allEntered = Promise.withResolvers<void>(), drain = Promise.withResolvers<void>();
    let sends = 0;
    const work: { pre: number; total: number }[] = [];
    try {
      const operations = Array.from({ length: 20 }, async (_, i) => {
        const owner = owners[i % 2]; const sample = { pre: 0, total: 0 }; work.push(sample);
        const query = async (text: string, values: unknown[]) => { sample.total++; return owner.sql.query(text, values); };
        const event = "pg309-" + i;
        const store = createLivePropCacheStore<SqlRow>((text, values) => query(text, values));
        return getOrRefresh({ sportKey: "americanfootball_nfl", eventId: event, marketKey: "player_pass_yds", playerName: "Synthetic" }, {
          ...store, makeOwnerId: randomUUID, now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
          fetchFresh: async () => {
            const batch = await getSharedOddsBatch<SqlRow>(event, ["player_pass_yds"], {
              query, makeOwnerId: randomUUID, monotonicNow: () => performance.now(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
              fetch: async () => {
                const subject = "v1:anonymous-network:" + createHash("sha256").update(event).digest("hex");
                expect(await admitPaidOdds(query, [{ keys: [subject], report: subject, intervalMs: 60_000, burst: 1, traffic: "anonymous" }],
                  { enforce: false, reserve: 100, batch: 1 })).toMatchObject({ outcome: "allow", warning: null });
                sample.pre = sample.total;
                if (++sends === 20) allEntered.resolve();
                await drain.promise;
                return { player_pass_yds: { synthetic: true } };
              },
            }, { ttlMs: 90_000, leaseMs: 45_000, refreshTimeoutMs: 20_000, waitIntervalMs: 250 });
            return batch.player_pass_yds.payload!;
          },
        }, { ttlMs: 90_000, leaseMs: 45_000, refreshTimeoutMs: 20_000, waitIntervalMs: 250 });
      });
      // Rejection must release the barrier too, or a failed leader would strand
      // its peers until their provider timers expired.
      for (const operation of operations) void operation.catch(error => { drain.resolve(); allEntered.reject(error); });
      await allEntered.promise;
      expect(sends).toBe(20); expect(owners.every(owner => owner.pool.totalCount <= 2)).toBe(true);
      drain.resolve(); expect(await Promise.all(operations)).toEqual(Array(20).fill({ synthetic: true }));
      expect(work).toEqual(Array(20).fill({ pre: 5, total: 7 }));
      for (const owner of owners) {
        expect(owner.counts.acquisitions).toBe(70); expect(owner.counts.releases).toBe(70);
        expect(owner.counts.peak).toBeLessThanOrEqual(2); expect(owner.counts.discards).toBe(0);
        expect(owner.protocol.every(event => event.name === "")).toBe(true);
      }
      const generation = instrument(target.expected, 2);
      try {
        const held = await Promise.all([...owners, generation].flatMap(owner => [owner.pool.connect(), owner.pool.connect()]));
        expect([...owners, generation].map(owner => owner.pool.totalCount)).toEqual([2, 2, 2]);
        held.forEach(client => client.release());
      } finally { await generation.pool.end(); }
      console.info("PG309_LOCAL_PROOF " + JSON.stringify({
        leaders: sends, owners: owners.length, maximumPerOwner: 2,
        beforeSendStatements: [...new Set(work.map(sample => sample.pre))],
        totalStatements: [...new Set(work.map(sample => sample.total))],
        counts: owners.map(owner => owner.counts),
        // Descriptive local observations, never speed assertions or a hosted
        // p95 pass. Checkout includes connection time; do not sum them twice.
        timing: owners.map(owner => Object.fromEntries(Object.entries(owner.timing).map(([kind, values]) =>
          [kind, { samples: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), maxMs: Math.max(...values) }]))),
        namedProtocolMessages: owners.flatMap(owner => owner.protocol).filter(event => event.name !== "").length,
      }));
    } finally { drain.resolve(); await Promise.all(owners.map(owner => owner.pool.end())); }
  });
});
