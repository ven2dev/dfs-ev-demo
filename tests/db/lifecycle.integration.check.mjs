import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "pg";
import { LOCAL_TEST_DATABASE_URL, assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

const execute = promisify(execFile);
const compose = ["compose", "--env-file", "/dev/null", "--project-name", "dfs-ev-demo-test", "-f", "compose.test.yml"];

test("a non-contention startup failure still removes the disposable service", { timeout: 120000 }, async () => {
  assertNoApplicationCredentials(process.env);
  const base = parseTestDatabaseUrl(LOCAL_TEST_DATABASE_URL);
  const admin = new Client(base);
  const environment = { ...process.env, TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL };
  delete environment.NODE_TEST_CONTEXT;
  try {
    await execute("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "60"]);
    // Run the real startup regressions before intentionally breaking login.
    await execute(process.execPath, ["--test", "--test-timeout=60000", "tests/db/startup.integration.check.mjs"],
      { env: environment, timeout: 60000 });
    await admin.connect();
    await admin.query("ALTER ROLE dfs_ev_test PASSWORD 'startup-failure-test-only'");
    await admin.end();
    await assert.rejects(execute(process.execPath, ["scripts/test-db.mjs", "local"], { env: environment, timeout: 60000 }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /password authentication failed/);
      assert.doesNotMatch(error.stderr, /another DB test run is active/);
      return true;
    });
    const result = await execute("docker", [...compose, "ps", "--all", "--quiet"]);
    assert.equal(result.stdout.trim(), "", "Non-contention startup failure left the service running");
  } finally {
    await admin.end();
    await execute("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  }
});
