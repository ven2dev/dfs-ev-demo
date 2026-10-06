import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { readCatalog } from "../../scripts/db-catalog.mjs";
import { compareCatalogs } from "../../scripts/compare-db-catalog.mjs";
import { buildManifest, checkMigrationArtifacts, loadMigrationSet, readMigrationFiles } from "../../scripts/db-migrations/files.mjs";
import { LOCK_KEY, LOCK_NAMESPACE, readMigrationStatus, runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { verifyCandidateTables } from "../../scripts/db-migrations/candidates.mjs";
import { createScratchHarness } from "./scratch.mjs";

let harness;
let files;
let reference;
before(async () => {
  files = await checkMigrationArtifacts();
  harness = await createScratchHarness(process.env);
  reference = await harness.withDatabase(async (client, expected) => {
    await client.query(execFileSync("git", ["show", "a3a5dd9:db/schema.sql"], { encoding: "utf8" }));
    return readCatalog(client, expected);
  });
});
after(async () => { await harness?.close(); });

const optionsFor = (expected, overrides = {}) => ({ expected, files, assertTarget: harness.assertTarget,
  verify: verifyCandidateTables, ...overrides });
async function ledgerRows(client) {
  return (await client.query("SELECT * FROM public.db_migrations ORDER BY version")).rows;
}
async function assertEmpty(client) {
  const { rows } = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
  assert.deepEqual(rows, []);
}

test("empty installation matches the authentic current catalog and reruns preserve ledger and relational rows", async () => {
  await harness.withDatabase(async (client, expected) => {
    await client.query("SET standard_conforming_strings = off");
    const options = optionsFor(expected, { verify: async (session, version) => {
      assert.equal((await session.query("SELECT current_setting('standard_conforming_strings') AS mode")).rows[0].mode, "on");
      await verifyCandidateTables(session, version);
    } });
    assert.deepEqual(await runScratchMigrations(client, options), { schemaVersion: 2, executed: [1, 2] });
    assert.equal((await client.query("SELECT current_setting('standard_conforming_strings') AS mode")).rows[0].mode, "off");
    await client.query("SET standard_conforming_strings = on");
    const catalog = await readCatalog(client, expected);
    const application = { ...catalog, objects: catalog.objects.filter((object) => !object.name.startsWith("db_migrations")) };
    assert.deepEqual(compareCatalogs(reference, application), []);
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic creator')");
    await client.query("INSERT INTO creator_video_submissions (creator_id, video_url, transcript_text) SELECT id, 'https://example.invalid/synthetic', 'synthetic text' FROM creators");
    const before = await ledgerRows(client);
    assert.deepEqual(await runScratchMigrations(client, options), { schemaVersion: 2, executed: [] });
    assert.deepEqual(await ledgerRows(client), before);
    assert.ok(before.every((row) => row.provenance === "executed" && row.runner_version === 1));
    const { rows } = await client.query("SELECT c.channel_name, v.transcript_text FROM creators c JOIN creator_video_submissions v ON v.creator_id = c.id");
    assert.deepEqual(rows, [{ channel_name: "synthetic creator", transcript_text: "synthetic text" }]);
    const status = await readMigrationStatus(client, expected, files);
    assert.equal(status.schemaVersion, 2);
    assert.equal(status.history.length, 2);
  });
});

test("read-only status creates no ledger and unversioned application schemas cannot be adopted", async () => {
  await harness.withDatabase(async (client, expected) => {
    const status = await readMigrationStatus(client, expected, files);
    assert.equal(status.ledger, "absent");
    await assertEmpty(client);
    await client.query(files[0].sql);
    const original = await readCatalog(client, expected);
    await assert.rejects(runScratchMigrations(client, optionsFor(expected)), /unversioned-schema-refused/);
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
    assert.equal((await readMigrationStatus(client, expected, files)).ledger, "absent");
  });
});

test("recorded baseline upgrades preserve seeded relationships and working sequence defaults", async () => {
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected, { files: files.slice(0, 1) }));
    await client.query("INSERT INTO creators (channel_name) VALUES ('seeded baseline')");
    await client.query("INSERT INTO creator_video_submissions (creator_id, video_url, transcript_text) SELECT id, 'https://example.invalid/baseline', 'baseline text' FROM creators");
    const original = await client.query("SELECT * FROM creator_video_submissions");
    const baselineLedger = (await ledgerRows(client))[0];
    assert.deepEqual((await runScratchMigrations(client, optionsFor(expected))).executed, [2]);
    assert.deepEqual((await ledgerRows(client))[0], baselineLedger);
    assert.deepEqual((await client.query("SELECT * FROM creator_video_submissions")).rows, original.rows);
    const { rows } = await client.query("INSERT INTO creators (channel_name) VALUES ('after upgrade') RETURNING id");
    assert.equal(Number(rows[0].id), 2);
    await verifyCandidateTables(client, 2);
  });
});

test("PostgreSQL rejects writes inside status and failed status restores the session", async () => {
  await harness.withDatabase(async (client, expected) => {
    const observed = { query: async (sql, params) => {
      if (sql.includes("SELECT to_regclass")) await client.query("CREATE TABLE status_must_not_write (id integer)");
      return client.query(sql, params);
    } };
    await assert.rejects(readMigrationStatus(observed, expected, files), (error) => error.code === "25006");
    await assertEmpty(client);
    assert.equal((await client.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly, "off");
    assert.equal((await readMigrationStatus(client, expected, files)).ledger, "absent");
  });
});

test("second migration invalid SQL rolls back the successful first file and its ledger insert", async () => {
  const root = await mkdtemp(join(tmpdir(), "dfs-ev-migration-rollback-"));
  const directory = join(root, "migrations");
  const manifest = join(root, "manifest.json");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "0001_first.sql"), "CREATE TABLE first_succeeded (id integer);\n");
    await writeFile(join(directory, "0002_invalid.sql"), "THIS IS INVALID SQL;\n");
    await writeFile(manifest, JSON.stringify(buildManifest(await readMigrationFiles(directory))), { flag: "wx" });
    const broken = await loadMigrationSet(directory, manifest);
    await harness.withDatabase(async (client, expected) => {
      let firstCompleted = false;
      const observed = { query: async (sql, params) => {
        if (sql === broken[1].sql) {
          assert.equal((await client.query("SELECT count(*)::integer AS count FROM public.db_migrations")).rows[0].count, 1);
          assert.equal((await client.query("SELECT to_regclass('public.first_succeeded') AS table_name")).rows[0].table_name, "first_succeeded");
          firstCompleted = true;
        }
        return client.query(sql, params);
      } };
      await assert.rejects(runScratchMigrations(observed, optionsFor(expected, { files: broken, verify: async () => assert.fail("Verification must not run after invalid SQL.") })),
        (error) => error.code === "42601");
      assert.equal(firstCompleted, true);
      await assertEmpty(client);
      assert.equal((await client.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly, "off");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification failure rolls back all application DDL and ledger writes", async () => {
  await harness.withDatabase(async (client, expected) => {
    await assert.rejects(runScratchMigrations(client, optionsFor(expected, { verify: async (session) => {
      assert.equal((await ledgerRows(session)).length, 2);
      throw new Error("synthetic-verification-failed");
    } })), /synthetic-verification-failed/);
    await assertEmpty(client);
    assert.deepEqual((await runScratchMigrations(client, optionsFor(expected))).executed, [1, 2]);
  });
});

test("held transaction lock fails promptly and concurrent runners cannot double-apply", async () => {
  await harness.withDatabase(async (client, expected) => {
    const competitor = new Client(expected);
    try {
      await competitor.connect();
      const firstPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.notEqual((await competitor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, firstPid);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]);
      const start = performance.now();
      await assert.rejects(runScratchMigrations(competitor, optionsFor(expected)), /migration-lock-busy/);
      assert.ok(performance.now() - start < 3000);
      await client.query("ROLLBACK");
      await assertEmpty(client);

      let release;
      let arrived;
      const barrier = new Promise((resolve) => { release = resolve; });
      const held = new Promise((resolve) => { arrived = resolve; });
      const first = runScratchMigrations(client, optionsFor(expected, { verify: async (session, version) => {
        await verifyCandidateTables(session, version);
        arrived();
        await barrier;
      } }));
      // Attach a rejection handler immediately so a setup failure is observable.
      const settling = first.then((result) => ({ result }), (error) => ({ error }));
      try {
        await Promise.race([held, settling.then(({ error }) => { if (error) throw error; })]);
        await assert.rejects(runScratchMigrations(competitor, optionsFor(expected)), /migration-lock-busy/);
        assert.equal((await competitor.query("SELECT to_regclass('public.db_migrations') AS ledger")).rows[0].ledger, null);
      } finally { release(); }
      const outcome = await settling;
      if (outcome.error) throw outcome.error;
      assert.deepEqual(outcome.result.executed, [1, 2]);
      assert.deepEqual((await runScratchMigrations(competitor, optionsFor(expected))).executed, []);
      assert.equal((await ledgerRows(client)).length, 2);
    } finally {
      await client.query("ROLLBACK");
      await competitor.end();
    }
  });
});

test("empty, partial, hole, checksum and unknown-runner ledgers fail without repair", async () => {
  for (const corrupt of ["DELETE FROM public.db_migrations", "DELETE FROM public.db_migrations WHERE version = 1",
    "UPDATE public.db_migrations SET sha256 = repeat('0', 64) WHERE version = 1",
    "ALTER TABLE public.db_migrations DROP CONSTRAINT db_migrations_runner_version_check; UPDATE public.db_migrations SET runner_version = 2 WHERE version = 1",
    "ALTER TABLE public.db_migrations DROP COLUMN sha256"]) {
    await harness.withDatabase(async (client, expected) => {
      await runScratchMigrations(client, optionsFor(expected));
      await client.query(corrupt);
      const before = await ledgerRows(client);
      await assert.rejects(readMigrationStatus(client, expected, files));
      await assert.rejects(runScratchMigrations(client, optionsFor(expected)));
      assert.deepEqual(await ledgerRows(client), before);
    });
  }
});

test("scratch target guards refuse primary, external, overridden and released database names", async () => {
  let released;
  await harness.withDatabase(async (client, config) => {
    released = config;
    for (const target of [{ ...config, database: "dfs_ev_test" }, { ...config, database: "dfs_ev_test_" + "a".repeat(20) },
      { ...config, host: "example.invalid" }, { ...config, port: 5432 }, { ...config, user: "postgres" },
      { ...config, ssl: true }, { ...config, connectionString: "postgresql://synthetic@invalid" }]) {
      assert.throws(() => harness.assertTarget(target), /Unregistered scratch target refused/);
      await assert.rejects(runScratchMigrations(client, optionsFor(target)));
    }
    await assertEmpty(client);
  });
  assert.throws(() => harness.assertTarget(released), /Unregistered scratch target refused/);
});
