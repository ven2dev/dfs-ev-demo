import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "pg";
import { createTemplateRun, getTemplateReference, registerTemplateClone } from "./templates.mts";
import { withMigratedDatabase } from "./migrated.mts";
import { createScratchHarness } from "./scratch.mjs";
import { parseTestDatabaseUrl } from "./target.mts";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";

test("template chain executes setup once, preserves prefixes and isolation, and reaps failed or abandoned clones safely", async () => {
  const base = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const directory = await mkdtemp(join(tmpdir(), "dfs-template-contract-"));
  const run = await createTemplateRun(process.env, directory);
  const environment = { ...process.env, TEST_DATABASE_TEMPLATE_MANIFEST: run.manifestPath };
  const harness = await createScratchHarness(environment);
  const admin = new Client(base);
  let orphanClient;
  try {
    await admin.connect();
    const files = await checkMigrationArtifacts();
    assert.deepEqual(run.stats.migrationVersions, files.map((file) => file.version));
    assert.equal(run.stats.catalogVerifications, files.length);
    assert.equal(run.stats.templateCount, files.length);
    await assert.rejects(harness.withDatabase(async () => assert.fail("Null reference selected a raw database"), null), /refused/);
    const prefix = await getTemplateReference(environment, 3);
    const latest = await getTemplateReference(environment);
    const oldLedger = await harness.withDatabase(async (client) => {
      const rows = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      assert.deepEqual(rows.map(({ version }) => version), [1, 2, 3]);
      assert.equal((await client.query("SELECT to_regclass('public.predictive_source_consumers') AS relation")).rows[0].relation, null);
      return rows;
    }, prefix);
    await harness.withDatabase(async (client) => {
      const rows = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      assert.deepEqual(rows.slice(0, 3), oldLedger);
      assert.equal(rows.at(-1).version, files.length);
      await client.query("INSERT INTO creators (channel_name) VALUES ('one-clone-only')");
    }, latest);
    await harness.withDatabase(async (client) => {
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM creators")).rows[0].count, 0);
    }, latest);
    const databases = await Promise.all([0, 1, 2].map((index) => withMigratedDatabase(environment, async (client, target) => {
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM creators")).rows[0].count, 0);
      await client.query("INSERT INTO creators (channel_name) VALUES ($1)", ["concurrent-" + index]);
      assert.equal((await client.query("SELECT channel_name FROM creators")).rows[0].channel_name, "concurrent-" + index);
      return target.expected.database;
    })));
    assert.equal(new Set(databases).size, 3);
    let failedDatabase;
    const failure = new Error("Synthetic fixture callback failure");
    await assert.rejects(harness.withDatabase(async (_client, config) => {
      failedDatabase = config.database;
      throw failure;
    }, latest), (error) => error === failure);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [failedDatabase])).rows[0].count, 0);
    assert.deepEqual(await readdir(join(directory, "clones")), []);
    const sourceClient = new Client({ ...base, database: latest.database });
    try { await assert.rejects(sourceClient.connect(), /not currently accepting connections/); }
    finally { await sourceClient.end(); }
    await admin.query(`ALTER DATABASE "${latest.database}" ALLOW_CONNECTIONS true`);
    await assert.rejects(harness.withDatabase(async () => assert.fail("Writable source was cloned"), latest), /refused/);
    await admin.query(`ALTER DATABASE "${latest.database}" ALLOW_CONNECTIONS false`);
    await assert.rejects(getTemplateReference(environment, files.length + 1), /refused/);
    // Simulate a child lost after CREATE but before its normal finally cleanup.
    const abandoned = await registerTemplateClone(admin, latest);
    await admin.query(`CREATE DATABASE "${abandoned.database}" TEMPLATE "${abandoned.source}"`);
    orphanClient = new Client({ ...base, database: abandoned.database });
    orphanClient.on("error", () => { /* Parent cleanup terminates this abandoned session. */ });
    await orphanClient.connect();
    // A malformed registry entry cannot authorize a drop of the primary DB;
    // other known resources still get cleaned when validation fails.
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
    await writeFile(join(directory, "clones", "foreign.json"), JSON.stringify({ runId: manifest.runId, database: base.database }), { mode: 0o600 });
    const owners = (await admin.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=$1 AND query LIKE $2 AND pid <> pg_backend_pid()`,
    [base.database, 'DROP DATABASE IF EXISTS "dfs_ev_test_' + manifest.runId + '%'])).rows;
    assert.equal(owners.length, 1, "Expected this run's template-admin backend");
    await admin.query("SELECT pg_terminate_backend($1)", [owners[0].pid]);
    if (!run.failureSignal.aborted) await new Promise((resolve) => run.failureSignal.addEventListener("abort", resolve, { once: true }));
    await assert.rejects(run.close(), (error) => error instanceof AggregateError &&
      error.errors.some((item) => item.message === "DB template admin connection lost.") &&
      error.errors.some((item) => /refused/.test(item.message)));
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [abandoned.database])).rows[0].count, 0);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname = ANY($1)", [manifest.templates.map((entry) => entry.database)])).rows[0].count, 0);
    assert.equal((await admin.query("SELECT current_database() AS database")).rows[0].database, base.database);
    await assert.rejects(harness.withDatabase(async () => assert.fail("Stale source was cloned"), latest), /refused/);
    await assert.rejects(readFile(run.manifestPath), { code: "ENOENT" });
    await assert.rejects(getTemplateReference(environment), { code: "ENOENT" });
  } finally {
    await orphanClient?.end();
    try { await harness.close(); } finally {
      try { await run.close(); } finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
    }
  }
});


test("cancelling a template build removes only its partial snapshots without publishing a manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-template-cancel-"));
  const admin = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
  const stop = new AbortController();
  let building;
  try {
    await admin.connect();
    const directoryDigest = createHash("sha256").update(resolve(directory)).digest("hex");
    let finished = false;
    building = createTemplateRun(process.env, directory, stop.signal);
    void building.finally(() => { finished = true; }).catch(() => {});
    const deadline = Date.now() + 15000;
    let builder;
    while (!finished && Date.now() < deadline) {
      const rows = (await admin.query(`SELECT datname FROM pg_database
        WHERE shobj_description(oid,'pg_database') LIKE $1`, ["dfs-ev-template-builder:%:" + directoryDigest])).rows;
      if (rows.length) { builder = rows[0].datname; break; }
      await pause(10);
    }
    assert.ok(builder, "Expected this run's builder before requesting cancellation");
    stop.abort();
    await assert.rejects(building, { name: "AbortError" });
    const prefix = builder.slice(0, -8);
    assert.deepEqual((await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [prefix + "%"])).rows, []);
    await assert.rejects(readFile(join(directory, "templates.json")), { code: "ENOENT" });
  } finally {
    stop.abort();
    const completed = await building?.catch(() => undefined);
    await completed?.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
