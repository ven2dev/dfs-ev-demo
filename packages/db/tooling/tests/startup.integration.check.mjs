import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTemplateRun } from "./templates.mts";
import { test } from "node:test";
import { Client } from "pg";
import { DatabaseTestRunActiveError, startDatabaseTestRun } from "./startup.mts";
import { parseTestDatabaseUrl } from "./target.mts";

const execute = promisify(execFile);

test("the next run sweeps stale fixture databases, including sealed and connected leftovers, preserving other databases", async () => {
  const admin = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
  const suffix = randomBytes(10).toString("hex");
  const stale = [`dfs_ev_test_${suffix}`, `dfs_ev_test_stale_${suffix}`, `dfs_ev_test_quote_${suffix}"`];
  const unrelated = `dfsXevXtest_${suffix}`;
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  let first; let next; let orphan;
  try {
    first = await startDatabaseTestRun(process.env);
    await admin.connect();
    for (const name of [...stale, unrelated]) await admin.query(`CREATE DATABASE ${quote(name)}`);
    await admin.query(`ALTER DATABASE ${quote(stale[0])} ALLOW_CONNECTIONS false`);
    orphan = new Client({ ...parseTestDatabaseUrl(process.env.TEST_DATABASE_URL), database: stale[1] });
    orphan.on("error", () => {});
    await orphan.connect();
    // Simulate a prior process that lost its lock session without dropping fixtures.
    await first.close(); first = undefined;
    next = await startDatabaseTestRun(process.env);
    assert.deepEqual((await admin.query("SELECT datname FROM pg_database WHERE datname = ANY($1)", [stale])).rows, []);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname = ANY($1)", [[unrelated, "dfs_ev_test"]])).rows[0].count, 2);
  } finally {
    await orphan?.end();
    for (const name of [...stale, unrelated]) await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    await admin.end(); await next?.close(); await first?.close();
  }
});

test("a held session lock refuses a concurrent runner before it sweeps or starts tests", async () => {
  const lease = await startDatabaseTestRun(process.env);
  const admin = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
  const name = "dfs_ev_test_" + randomBytes(10).toString("hex");
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`);
    await assert.rejects(startDatabaseTestRun(process.env), (error) =>
      error instanceof DatabaseTestRunActiveError && error.code === "DB_TEST_RUN_ACTIVE");
    for (const mode of ["run", "local"]) await assert.rejects(execute(process.execPath,
      ["packages/db/tooling/scripts/test-db.mjs", mode], { env: process.env, timeout: 20000 }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /another DB test run is active on this target/);
      assert.equal(error.stdout, "");
      return true;
    });
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [name])).rows[0].count, 1);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end(); await lease.close();
  }
});


test("template admin loss leaves a failed teardown for the next startup sweep to recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-startup-recovery-"));
  const admin = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
  let lease; let next; let templates;
  try {
    lease = await startDatabaseTestRun(process.env);
    await admin.connect();
    templates = await createTemplateRun(process.env, directory);
    const manifest = JSON.parse(await readFile(templates.manifestPath, "utf8"));
    const owners = (await admin.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND query LIKE $1 AND pid <> pg_backend_pid()`,
    ['DROP DATABASE IF EXISTS "dfs_ev_test_' + manifest.runId + '%'])).rows;
    assert.equal(owners.length, 1);
    await admin.query("SELECT pg_terminate_backend($1)", [owners[0].pid]);
    if (!templates.failureSignal.aborted) await new Promise((resolve) => templates.failureSignal.addEventListener("abort", resolve, { once: true }));
    await assert.rejects(templates.close(), (error) => error instanceof AggregateError &&
      error.errors.some((item) => item.message === "DB template admin connection lost."));
    const names = manifest.templates.map(({ database }) => database);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname = ANY($1)", [names])).rows[0].count, names.length);
    await lease.close(); lease = undefined;
    next = await startDatabaseTestRun(process.env);
    assert.deepEqual((await admin.query("SELECT datname FROM pg_database WHERE datname = ANY($1)", [names])).rows, []);
    assert.equal((await admin.query("SELECT current_database() AS name")).rows[0].name, "dfs_ev_test");
  } finally {
    await templates?.close(); await admin.end(); await next?.close(); await lease?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
