import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { fingerprint, readCatalog } from "../../scripts/db-catalog.mjs";
import { compareCatalogs } from "../../scripts/compare-db-catalog.mjs";
import { buildCatalogContract, contractSources, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { LOCK_KEY, LOCK_NAMESPACE, readLedger } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { prepareMigrationContext, readMigrationPlan, runApprovedScratchMigrations } from "../../scripts/db-migrations/plans.mjs";
import { createScratchHarness } from "./scratch.mjs";
import { parseTestDatabaseUrl } from "./target.mts";

const runCli = promisify(execFile);
let harness;
let context;
let files;
let contracts;
before(async () => {
  files = await checkMigrationArtifacts();
  contracts = await loadCatalogContracts(files);
  context = await prepareMigrationContext(files, contracts);
  harness = await createScratchHarness(process.env);
});
after(async () => { await harness?.close(); });
const optionsFor = (expected, overrides = {}) => ({ expected, environment: "test", context, assertTarget: harness.assertTarget, ...overrides });
const applyPlan = (client, options, plan) => runApprovedScratchMigrations(client, { ...options, approvedFingerprint: plan.planFingerprint });
const actions = (plan) => plan.operations.map(({ version, action }) => [version, action]);
async function installFixture(client, name) { await client.query(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8")); }

test("read-only plans are deterministic, create no ledger and fresh approvals install then no-op", async () => {
  await harness.withDatabase(async (client, expected) => {
    const options = optionsFor(expected);
    const plan = await readMigrationPlan(client, options);
    assert.deepEqual(await readMigrationPlan(client, options), plan);
    assert.equal(plan.observed.schemaVersion, 0);
    assert.equal(plan.observed.ledger, "absent");
    assert.deepEqual(actions(plan), files.map((file) => [file.version, "execute"]));
    assert.equal(await readLedger(client, files), null);
    assert.deepEqual((await applyPlan(client, options, plan)).executed, files.map((file) => file.version));
    const history = await readLedger(client, files);
    await assert.rejects(applyPlan(client, options, plan), /approved-plan-changed/);
    const repeat = await readMigrationPlan(client, options);
    assert.deepEqual(repeat.operations, []);
    assert.deepEqual((await applyPlan(client, options, repeat)).executed, []);
    assert.deepEqual(await readLedger(client, files), history);
  });
});

test("verified seeded current adoption changes only ledger metadata and never replays application SQL", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "current-before-60.schema.sql");
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic current creator')");
    await client.query("INSERT INTO creator_video_submissions (creator_id, video_url, transcript_text) SELECT id, 'https://example.invalid/current', 'synthetic current text' FROM creators");
    const catalog = await readCatalog(client, expected);
    const rows = (await client.query("SELECT * FROM creator_video_submissions")).rows;
    const sequence = (await client.query("SELECT last_value, is_called FROM creators_id_seq")).rows;
    const historical = await prepareMigrationContext(files.slice(0, 2), { ledger: contracts.ledger, migrations: contracts.migrations.slice(0, 2) });
    const options = optionsFor(expected, { context: historical });
    const plan = await readMigrationPlan(client, options);
    assert.equal(plan.observed.schemaVersion, 2);
    assert.deepEqual(actions(plan), [[1, "adopt"], [2, "adopt"]]);
    const statements = [];
    const observed = { query: async (sql, params) => { statements.push(sql); return client.query(sql, params); } };
    assert.deepEqual((await applyPlan(observed, options, plan)).adopted, [1, 2]);
    assert.ok(!statements.some((sql) => context.files.some((file) => file.sql === sql)));
    assert.deepEqual(statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)), ["BEGIN", "COMMIT"]);
    const ledgerKeys = new Set(context.contracts.ledger.objects.map((object) => object.kind + ":" + object.name));
    const after = await readCatalog(client, expected);
    assert.deepEqual(compareCatalogs(catalog, { ...after, objects: after.objects.filter((object) => !ledgerKeys.has(object.kind + ":" + object.name)) }), []);
    assert.deepEqual((await client.query("SELECT * FROM creator_video_submissions")).rows, rows);
    assert.deepEqual((await client.query("SELECT last_value, is_called FROM creators_id_seq")).rows, sequence);
    assert.ok((await readLedger(client, files)).every((row) => row.provenance === "adopted"));
  });
});

test("verified seeded pre-41 adoption records its baseline and executes additions while preserving rows and sequences", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "pre-41.schema.sql");
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic legacy creator')");
    await client.query("INSERT INTO creator_video_submissions (creator_id, video_url, transcript_text) SELECT id, 'https://example.invalid/legacy', 'synthetic legacy text' FROM creators");
    const rows = (await client.query("SELECT * FROM creator_video_submissions")).rows;
    const plan = await readMigrationPlan(client, optionsFor(expected));
    assert.deepEqual(actions(plan), [[1, "adopt"], ...files.slice(1).map((file) => [file.version, "execute"])]);
    const observed = { query: async (sql, params) => {
      assert.notEqual(sql, files[0].sql, "Baseline SQL must never replay during adoption.");
      return client.query(sql, params);
    } };
    const result = await applyPlan(observed, optionsFor(expected), plan);
    assert.deepEqual(result.adopted, [1]);
    assert.deepEqual(result.executed, files.slice(1).map((file) => file.version));
    assert.deepEqual((await readLedger(client, files)).map((row) => row.provenance), ["adopted", ...files.slice(1).map(() => "executed")]);
    assert.deepEqual((await client.query("SELECT * FROM creator_video_submissions")).rows, rows);
    assert.equal(Number((await client.query("INSERT INTO creators (channel_name) VALUES ('after adopted upgrade') RETURNING id")).rows[0].id), 2);
  });
});

test("approved recorded-baseline upgrades preserve existing ledger rows and execute only the pending file", async () => {
  const baseline = await prepareMigrationContext(files.slice(0, 1), { ledger: contracts.ledger, migrations: contracts.migrations.slice(0, 1) });
  await harness.withDatabase(async (client, expected) => {
    const firstOptions = optionsFor(expected, { context: baseline });
    await applyPlan(client, firstOptions, await readMigrationPlan(client, firstOptions));
    await client.query("INSERT INTO creators (channel_name) VALUES ('recorded baseline row')");
    const original = await readLedger(client, files);
    const pending = await prepareMigrationContext(files.slice(0, 2), { ledger: contracts.ledger, migrations: contracts.migrations.slice(0, 2) });
    const options = optionsFor(expected, { context: pending });
    const plan = await readMigrationPlan(client, options);
    assert.equal(plan.observed.ledgerVersion, 1);
    assert.deepEqual(actions(plan), [[2, "execute"]]);
    assert.deepEqual((await applyPlan(client, options, plan)).executed, [2]);
    assert.deepEqual((await readLedger(client, files))[0], original[0]);
    assert.deepEqual((await client.query("SELECT channel_name FROM creators")).rows, [{ channel_name: "recorded baseline row" }]);
  });
});

test("ambiguous unversioned catalogs never guess the latest version or adopt", async () => {
  const sql = "-- synthetic migration with no schema change\nSELECT 1;\n";
  const ambiguousFiles = [...files.slice(0, 2), { version: 3, filename: "0003_synthetic_noop.sql", sql, sha256: fingerprint(sql) }];
  const sources = await contractSources(ambiguousFiles);
  const ambiguousContracts = { ...contracts, migrations: [...contracts.migrations.slice(0, 2),
    buildCatalogContract(contracts.migrations[1], sources.migrations[2])] };
  const ambiguousContext = await prepareMigrationContext(ambiguousFiles, ambiguousContracts);
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "current-before-60.schema.sql");
    const options = optionsFor(expected, { context: ambiguousContext });
    const plan = await readMigrationPlan(client, options);
    assert.equal(plan.refusalCode, "ambiguous-unversioned-schema");
    assert.equal(plan.executable, false);
    assert.equal(plan.verification.filter((report) => !report.differences.length).length, 2);
    await assert.rejects(applyPlan(client, options, plan), /migration-plan-not-executable/);
    assert.equal(await readLedger(client, files), null);
  });
});

test("partial or mismatched unversioned schemas expose every candidate difference and refuse approved adoption without repair", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "pre-41.schema.sql");
    await client.query("ALTER TABLE creators ALTER COLUMN channel_name DROP NOT NULL; ALTER SEQUENCE creators_id_seq INCREMENT BY 2; CREATE TABLE unreviewed (id integer)");
    const original = await readCatalog(client, expected);
    const plan = await readMigrationPlan(client, optionsFor(expected));
    assert.equal(plan.executable, false);
    assert.equal(plan.refusalCode, "unrecognized-unversioned-schema");
    assert.equal(plan.observed.schemaVersion, null);
    assert.deepEqual(plan.operations, []);
    assert.equal(plan.verification.length, files.length);
    for (const report of plan.verification) {
      for (const prefix of ["Changed column:creators.channel_name / not_null", "Changed sequence:creators_id_seq / increment", "Unexpected relation:unreviewed"]) {
        assert.ok(report.differences.some((difference) => difference.startsWith(prefix)), prefix);
      }
    }
    await assert.rejects(applyPlan(client, optionsFor(expected), plan), /migration-plan-not-executable/);
    assert.equal(await readLedger(client, files), null);
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
  });
});

test("schema, history, source checksums and target changes invalidate approval before any mutation", async () => {
  await harness.withDatabase(async (client, expected) => {
    const options = optionsFor(expected);
    const emptyPlan = await readMigrationPlan(client, options);
    await client.query("CREATE TABLE changed_since_plan (id integer)");
    await assert.rejects(applyPlan(client, options, emptyPlan), /approved-plan-changed/);
    assert.equal(await readLedger(client, files), null);
    await client.query("DROP TABLE changed_since_plan");
    const editedFiles = structuredClone(files);
    editedFiles[1].sql += "-- hypothetical separately reviewed bytes\n";
    editedFiles[1].sha256 = fingerprint(editedFiles[1].sql);
    const editedContracts = structuredClone(contracts);
    const sources = await contractSources(editedFiles);
    for (const [index, contract] of editedContracts.migrations.entries()) contract.source = sources.migrations[index];
    const editedContext = await prepareMigrationContext(editedFiles, editedContracts);
    await assert.rejects(applyPlan(client, optionsFor(expected, { context: editedContext }), emptyPlan), /approved-plan-changed/);
    assert.equal(await readLedger(client, files), null);
    const otherEnvironment = await readMigrationPlan(client, { ...options, environment: "production" });
    assert.notEqual(otherEnvironment.planFingerprint, emptyPlan.planFingerprint);
    await assert.rejects(applyPlan(client, options, otherEnvironment), /approved-plan-changed/);
    await applyPlan(client, options, emptyPlan);
    const recordedPlan = await readMigrationPlan(client, options);
    await client.query("UPDATE db_migrations SET provenance = 'adopted', applied_at = applied_at + interval '1 second' WHERE version = 1");
    const changed = await readLedger(client, files);
    await assert.rejects(applyPlan(client, options, recordedPlan), /approved-plan-changed/);
    assert.deepEqual(await readLedger(client, files), changed);
    await harness.withDatabase(async (other, otherExpected) => {
      await assert.rejects(applyPlan(other, optionsFor(otherExpected), emptyPlan), /approved-plan-changed/);
      assert.equal(await readLedger(other, files), null);
    });
  });
});

test("invalid SQL after verified baseline adoption rolls back ledger creation and preserves the authentic schema", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "pre-41.schema.sql");
    await client.query("INSERT INTO creators (channel_name) VALUES ('preserved after SQL failure')");
    const original = await readCatalog(client, expected);
    const plan = await readMigrationPlan(client, optionsFor(expected));
    let reached = false;
    const observed = { query: async (sql, params) => {
      if (sql === files[1].sql) {
        assert.deepEqual((await client.query("SELECT version, provenance FROM db_migrations")).rows, [{ version: 1, provenance: "adopted" }]);
        reached = true;
        return client.query("THIS IS INVALID SQL");
      }
      return client.query(sql, params);
    } };
    await assert.rejects(applyPlan(observed, optionsFor(expected), plan), (error) => error.code === "42601");
    assert.equal(reached, true);
    assert.equal(await readLedger(client, files), null);
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
    assert.deepEqual((await client.query("SELECT channel_name FROM creators")).rows, [{ channel_name: "preserved after SQL failure" }]);
  });
});

test("failed final verification rolls back adoption and upgrade with nothing leaked to a second connection", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "pre-41.schema.sql");
    const original = await readCatalog(client, expected);
    const plan = await readMigrationPlan(client, optionsFor(expected));
    const observer = new Client(expected);
    try {
      await observer.connect();
      const observed = { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.startsWith("INSERT INTO public.db_migrations") && params[0] === 2) {
          assert.equal(await readLedger(observer, files), null);
          assert.equal((await observer.query("SELECT to_regclass('public.odds_observations') AS relation")).rows[0].relation, null);
          await client.query("ALTER TABLE odds_observations ALTER COLUMN captured_at DROP NOT NULL");
        }
        return result;
      } };
      await assert.rejects(applyPlan(observed, optionsFor(expected), plan), /candidate-catalog-mismatch/);
    } finally { await observer.end(); }
    assert.equal(await readLedger(client, files), null);
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
  });
});

test("pre-existing empty, partial, hole, checksum and unknown-runner ledgers are refused rather than adopted", async () => {
  for (const corrupt of ["DELETE FROM db_migrations", "DELETE FROM db_migrations WHERE version = 1",
    "UPDATE db_migrations SET sha256 = repeat('0', 64) WHERE version = 1",
    "ALTER TABLE db_migrations DROP CONSTRAINT db_migrations_runner_version_check; UPDATE db_migrations SET runner_version = 2 WHERE version = 1",
    "ALTER TABLE db_migrations DROP COLUMN sha256"]) {
    await harness.withDatabase(async (client, expected) => {
      const options = optionsFor(expected);
      await applyPlan(client, options, await readMigrationPlan(client, options));
      const approved = await readMigrationPlan(client, options);
      await client.query(corrupt);
      const rows = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      await assert.rejects(readMigrationPlan(client, options));
      await assert.rejects(applyPlan(client, options, approved));
      assert.deepEqual((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows, rows);
    });
  }
});

test("valid ledger rows with catalog drift produce a readable non-executable plan", async () => {
  await harness.withDatabase(async (client, expected) => {
    const options = optionsFor(expected);
    await applyPlan(client, options, await readMigrationPlan(client, options));
    await client.query("ALTER TABLE db_migrations DROP CONSTRAINT db_migrations_sha256_check; ALTER TABLE creators ALTER COLUMN channel_name DROP NOT NULL");
    const plan = await readMigrationPlan(client, options);
    assert.equal(plan.observed.ledger, "valid");
    assert.equal(plan.observed.ledgerVersion, files.length);
    assert.equal(plan.observed.schemaVersion, null);
    assert.equal(plan.refusalCode, "recorded-catalog-mismatch");
    assert.ok(plan.verification[0].differences.some((difference) => difference.startsWith("Missing constraint:db_migrations.db_migrations_sha256_check")));
    assert.ok(plan.verification[0].differences.some((difference) => difference.startsWith("Changed column:creators.channel_name / not_null")));
    const rows = await readLedger(client, files);
    await assert.rejects(applyPlan(client, options, plan), /migration-plan-not-executable/);
    assert.deepEqual(await readLedger(client, files), rows);
  });
});

test("incomplete or rewritten ledger results cannot commit after otherwise valid migration SQL", async () => {
  const baseline = await prepareMigrationContext(files.slice(0, 1), { ledger: contracts.ledger, migrations: contracts.migrations.slice(0, 1) });
  for (const [mutation, recordedBaseline, code] of [
    [`DELETE FROM db_migrations WHERE version = ${files.length}`, false, "incomplete-migration-history"],
    ["UPDATE db_migrations SET provenance = 'adopted' WHERE version = 2", false, "migration-history-result-mismatch"],
    ["UPDATE db_migrations SET applied_at = applied_at + interval '1 second' WHERE version = 1", true, "migration-history-result-mismatch"],
  ]) {
    await harness.withDatabase(async (client, expected) => {
      if (recordedBaseline) {
        const firstOptions = optionsFor(expected, { context: baseline });
        await applyPlan(client, firstOptions, await readMigrationPlan(client, firstOptions));
        await client.query("INSERT INTO creators (channel_name) VALUES ('preserved prior history')");
      }
      const originalHistory = await readLedger(client, files);
      const originalCatalog = await readCatalog(client, expected);
      const options = optionsFor(expected);
      const plan = await readMigrationPlan(client, options);
      const observed = { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.startsWith("INSERT INTO public.db_migrations") && params[0] === files.length) await client.query(mutation);
        return result;
      } };
      await assert.rejects(applyPlan(observed, options, plan), { message: code });
      assert.deepEqual(await readLedger(client, files), originalHistory);
      assert.deepEqual(compareCatalogs(originalCatalog, await readCatalog(client, expected)), []);
      if (recordedBaseline) assert.deepEqual((await client.query("SELECT channel_name FROM creators")).rows,
        [{ channel_name: "preserved prior history" }]);
    });
  }
});

test("plan is enforced read-only and restores the session after a PostgreSQL write refusal", async () => {
  await harness.withDatabase(async (client, expected) => {
    const observed = { query: async (sql, params) => {
      if (sql.includes("SELECT to_regclass")) await client.query("CREATE TABLE plan_must_not_write (id integer)");
      return client.query(sql, params);
    } };
    await assert.rejects(readMigrationPlan(observed, optionsFor(expected)), (error) => error.code === "25006");
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
    assert.equal((await client.query("SELECT to_regclass('public.plan_must_not_write') AS relation")).rows[0].relation, null);
    assert.equal(await readLedger(client, files), null);
  });
});

test("up takes the lock before reading history and concurrent adoption cannot double-apply", async () => {
  await harness.withDatabase(async (client, expected) => {
    await installFixture(client, "current-before-60.schema.sql");
    const options = optionsFor(expected);
    const plan = await readMigrationPlan(client, options);
    const competitor = new Client(expected);
    try {
      await competitor.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]);
      const refused = { query: async (sql, params) => {
        assert.ok(!sql.includes("SELECT to_regclass"), "Lock refusal must precede history reads.");
        return competitor.query(sql, params);
      } };
      await assert.rejects(applyPlan(refused, options, plan), /migration-lock-busy/);
      await client.query("ROLLBACK");
      let release;
      let arrived;
      const barrier = new Promise((resolve) => { release = resolve; });
      const held = new Promise((resolve) => { arrived = resolve; });
      const observed = { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.startsWith("INSERT INTO public.db_migrations") && params[0] === 2) { arrived(); await barrier; }
        return result;
      } };
      const first = applyPlan(observed, options, plan).then((result) => ({ result }), (error) => ({ error }));
      try {
        await Promise.race([held, first.then(({ error }) => { if (error) throw error; })]);
        await assert.rejects(applyPlan(competitor, options, plan), /migration-lock-busy/);
        assert.equal(await readLedger(competitor, files), null);
      } finally { release(); }
      const outcome = await first;
      if (outcome.error) throw outcome.error;
      assert.deepEqual(outcome.result.adopted, [1, 2]);
      await assert.rejects(applyPlan(competitor, options, plan), /approved-plan-changed/);
      assert.equal((await readLedger(client, files)).length, files.length);
    } finally { await client.query("ROLLBACK"); await competitor.end(); }
  });
});

test("missing approval and unregistered, primary or remote mutation targets fail before a transaction", async () => {
  await harness.withDatabase(async (client, expected) => {
    const plan = await readMigrationPlan(client, optionsFor(expected));
    const noAccess = { query: () => assert.fail("Invalid approval or target must be refused before SQL.") };
    await assert.rejects(runApprovedScratchMigrations(noAccess, optionsFor(expected)), /approved-plan-fingerprint-required/);
    for (const config of [{ ...expected, database: "dfs_ev_test" }, { ...expected, database: "dfs_ev_test_" + "a".repeat(20) },
      { ...expected, host: "example.invalid" }]) await assert.rejects(applyPlan(noAccess, optionsFor(config), plan), /Unregistered scratch target refused/);
    await assert.rejects(applyPlan(noAccess, optionsFor(expected, { environment: "production" }), plan), /scratch-plan-target-required/);
    await assert.rejects(applyPlan(noAccess, optionsFor(expected, { assertTarget: undefined }), plan), /scratch-plan-target-required/);
  });
});

test("owner plan CLI writes a private exclusive artifact outside Git without changing the shared database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-owner-plan-"));
  const expected = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const client = new Client(expected);
  try {
    await client.connect();
    const original = await readCatalog(client, expected);
    const output = join(directory, "plan.json");
    const args = ["scripts/db-migrate.mjs", "plan", "--environment", "test", "--expected-host-fingerprint",
      fingerprint(expected.host).slice(0, 12), "--expected-database", expected.database, "--output", output];
    const result = await runCli(process.execPath, args, { env: process.env });
    const artifact = await readFile(output, "utf8");
    const plan = JSON.parse(artifact);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(result.stdout).planFingerprint, plan.planFingerprint);
    assert.ok(!artifact.includes(expected.password) && !artifact.includes("127.0.0.1"));
    await assert.rejects(runCli(process.execPath, args, { env: process.env }), (error) => {
      assert.equal(error.stderr, "db-migrate: command-failed\n");
      return true;
    });
    assert.equal(await readFile(output, "utf8"), artifact);
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
  } finally { await client.end(); await rm(directory, { recursive: true, force: true }); }
});
