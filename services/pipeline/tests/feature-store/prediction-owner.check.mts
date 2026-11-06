import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, Pool, type ClientConfig, type QueryConfig } from "pg";
import { predictQbModel } from "@dfs-ev/pipeline/feature-store/predict";
import { predictQbModelOwned } from "@dfs-ev/pipeline/feature-store/prediction-owner";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { predictionDatabaseFixture } from "./prediction-db-fixture.ts";

test("#168 real connection owner, server timeout and query-only handler", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [];
  const evidence: Record<string, unknown> = { issue: 168, step: 0, kind: "prediction-owner-behavior", probes };
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs168-owner-"))), store = await openLocalObjectStore(root);
  const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
    try { probes.push({ name, verdict: "pass", details: await run() }); }
    catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
  });
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, createReaderConfig }) => {
      for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "229_mandatory_recovery.sql", "231_composite_authorization.sql"])
        await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
      const config = { ...await createReaderConfig(), statement_timeout: 300 };
      await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
      await admin.query(`GRANT fs231_model_reader TO ${config.user} WITH INHERIT TRUE, SET FALSE`);
      const world = await predictionDatabaseFixture(writer, store).world();
      const inactive = async (pid: number) => {
        // This is a generous liveness watchdog, not a CI latency assertion.
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          const row = (await admin.query("SELECT state,query FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
          if (!row || row.state !== "active") return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("disposed backend continued its sleeping statement");
      };
      await check("real standalone and pool ownership keep 3/2/1 and dispose once", async () => {
        const details = [], originalQuery = Client.prototype.query, originalEnd = Client.prototype.end;
        for (const pooled of [false, true]) {
          let sql = 0, checks = 0, gets = 0, ends = 0, releases = 0;
          const pool = pooled ? new Pool({ ...config, max: 1 }) : undefined;
          pool?.on("release", () => { releases++; });
          Client.prototype.query = function (this: Client, ...args: unknown[]) {
            sql++; const text = (args[0] as QueryConfig).text;
            if (text.includes("authorize_model")) checks++;
            return Reflect.apply(originalQuery, this, args);
          } as typeof originalQuery;
          Client.prototype.end = function (this: Client, ...args: unknown[]) { ends++; return Reflect.apply(originalEnd, this, args); } as typeof originalEnd;
          try {
            const read = await predictQbModelOwned(pool ?? config, { get: key => { gets++; return store.get(key); } }, world.request);
            assert.equal(read.response.status, "available", JSON.stringify(read.response));
            assert.deepEqual(JSON.parse(read.serialized), read.response); assert(!("connectionDisposition" in read.response));
            assert.equal(read.connectionDisposition, "reusable");
            assert.deepEqual({ sql, checks, gets }, { sql: 3, checks: 2, gets: 1 });
            assert.equal(ends, pooled ? 0 : 1); assert.equal(releases, pooled ? 1 : 0);
            details.push({ pooled, sql, checks, gets, ownerEnds: ends, poolReleases: releases });
          } finally { Client.prototype.query = originalQuery; Client.prototype.end = originalEnd; await pool?.end(); }
        }
        return details;
      });
      await check("real pool discard destroys exactly once on sleeping context/Q1/Q2 and cannot run later SQL", async () => {
        const details = [], originalQuery = Client.prototype.query, originalEnd = Client.prototype.end;
        for (const stage of ["context", "Q1", "Q2"]) {
          const pool = new Pool({ ...config, max: 1 });
          const seed = await pool.connect();
          const pid = (await seed.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          assert.equal((await seed.query("SHOW statement_timeout")).rows[0].statement_timeout, "300ms"); seed.release();
          let sql = 0, gets = 0, releases = 0, destroys = 0, ends = 0;
          const controller = new AbortController();
          pool.on("release", error => { releases++; if (error) destroys++; });
          Client.prototype.query = function (this: Client, q: QueryConfig, ...args: unknown[]) {
            if (this !== seed) return Reflect.apply(originalQuery, this, [q, ...args]);
            sql++; const current = q.text.includes("resolve_model_context") ? "context" : q.values?.[2] ? "Q1" : "Q2";
            const result = Reflect.apply(originalQuery, this, [current === stage ? { ...q, text: "SELECT pg_sleep(10)", values: [] } : q]);
            if (current === stage) setImmediate(() => controller.abort());
            return result;
          } as typeof originalQuery;
          Client.prototype.end = function (this: Client, ...args: unknown[]) { if (this === seed) ends++; return Reflect.apply(originalEnd, this, args); } as typeof originalEnd;
          try {
            const read = await predictQbModelOwned(pool, { get: key => { gets++; return store.get(key); } }, world.request, { signal: controller.signal });
            assert.deepEqual(read.response, { status: "unavailable", reason: "cancelled" });
            assert.deepEqual(JSON.parse(read.serialized), read.response); assert.equal(read.connectionDisposition, "discard");
            const expected = { sql: stage === "context" ? 1 : stage === "Q1" ? 2 : 3, gets: stage === "Q2" ? 1 : 0 };
            assert.deepEqual({ sql, gets }, expected); assert.equal(releases, 1); assert.equal(destroys, 1); assert.equal(ends, 1);
            await inactive(pid); await new Promise(resolve => setTimeout(resolve, 30));
            assert.deepEqual({ sql, gets }, expected); assert.equal(ends, 1);
            details.push({ stage, ...expected, ownerEnds: ends, poolReleases: releases, destroyingReleases: destroys, backendInactive: true, noLateQuery: true });
          } finally { Client.prototype.query = originalQuery; Client.prototype.end = originalEnd; await pool.end(); }
        }
        return details;
      });
      await check("query-only handler reports discard without ending; owner stops backend; no private or late result", async () => {
        const details = [];
        for (const stage of ["context", "Q1", "Q2"]) {
          const client = new Client(config); client.on("error", () => {}); await client.connect();
          const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          let sql = 0, gets = 0, ended = false;
          try {
            const read = await predictQbModel({ query: (q: QueryConfig) => {
              sql++; const current = q.text.includes("resolve_model_context") ? "context" : q.values?.[2] ? "Q1" : "Q2";
              return client.query(current === stage ? { ...q, text: "SELECT pg_sleep(10)", values: [] } : q);
            } } as Pick<Client, "query">, { get: key => { gets++; return store.get(key); } }, world.request,
            { deadlineAt: performance.now() + 100 });
            assert.deepEqual(read.response, { status: "unavailable", reason: "deadline-exceeded" });
            assert.equal(read.connectionDisposition, "discard"); const before = { sql, gets };
            ended = true; void client.end().catch(() => {}); await inactive(pid); await new Promise(resolve => setTimeout(resolve, 30));
            assert.deepEqual({ sql, gets }, before);
            details.push({ stage, ...before, handlerEndCapability: false, ownerEndCalls: 1, backendInactive: true, noLateQuery: true });
          } finally { if (!ended) await client.end(); }
        }
        return details;
      });
      await check("server startup timeout cancels a sleeping statement when owner disposal is deliberately delayed", async () => {
        const client = new Client(config); await client.connect();
        try {
          assert.equal((await client.query("SHOW statement_timeout")).rows[0].statement_timeout, "300ms");
          await assert.rejects(client.query("SELECT pg_sleep(10)"), { code: "57014" });
          assert.equal((await client.query("SELECT 1 AS alive")).rows[0].alive, 1);
          return { statementTimeoutMs: 300, sqlstate: "57014", disposalDelayedUntilServerRefusal: true };
        } finally { await client.end(); }
      });
      await check("invalid clocks and unbounded pools refuse before connection or artifact I/O", async () => {
        let gets = 0; const objects = { get: async () => { gets++; throw new Error("unexpected bytes"); } };
        const pool = new Pool(config);
        try {
          for (const deadlineAt of [Date.now(), performance.now() + 1000, Infinity, NaN]) {
            const read = await predictQbModelOwned(pool, objects, world.request, { deadlineAt });
            assert.deepEqual(read.response, { status: "unavailable", reason: "invalid-request" }); assert.equal(pool.totalCount, 0);
          }
          const unbounded = new Pool({ ...config, statement_timeout: 0 });
          try {
            assert.deepEqual((await predictQbModelOwned(unbounded, objects, world.request)).response,
              { status: "unavailable", reason: "model-read-session-refused" }); assert.equal(unbounded.totalCount, 0);
          } finally { await unbounded.end(); }
          assert.equal(gets, 0); return { invalidClocks: 4, unboundedPoolRefused: true, connections: 0, gets };
        } finally { await pool.end(); }
      });
      await check("failed standalone authentication is cleaned up once and exposes no provider diagnostics", async () => {
        const original = Client.prototype.end; let ends = 0;
        Client.prototype.end = function (this: Client, ...args: unknown[]) { ends++; return Reflect.apply(original, this, args); } as typeof original;
        try {
          const read = await predictQbModelOwned({ ...config, password: "deliberately-wrong" } as ClientConfig, store, world.request);
          assert.deepEqual(read.response, { status: "unavailable", reason: "prediction-unavailable" });
          assert.equal(read.connectionDisposition, "discard"); assert.equal(ends, 1); return { ownerEndCalls: ends, providerDiagnosticsPrivate: true };
        } finally { Client.prototype.end = original; }
      });
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.error = String(error); throw error; }
  finally {
    const paths = ["services/pipeline/src/featureStore/predict.ts", "services/pipeline/src/featureStore/predictionOwner.ts",
      "services/pipeline/src/featureStore/predictionClock.ts", "services/pipeline/tests/feature-store/prediction-owner.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(path))])));
    evidence.sourceBlobIds = Object.fromEntries(paths.map(path => [path, execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim()]));
    await rm(root, { recursive: true, force: true });
    if (process.env.FS168_OWNER_EVIDENCE) await writeFile(process.env.FS168_OWNER_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  }
});
