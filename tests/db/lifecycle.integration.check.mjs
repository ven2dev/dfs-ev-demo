import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "pg";
import { assertNoApplicationCredentials, getTestDatabaseLane, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";

const execute = promisify(execFile);
const script = "scripts/db/test-db.mjs";

test("a non-contention startup failure still removes the disposable service", { timeout: 120000 }, async () => {
  assertNoApplicationCredentials(process.env);
  const lane = getTestDatabaseLane(process.env.DB_TEST_LANE);
  const base = parseTestDatabaseUrl(lane.url);
  const admin = new Client(base);
  const environment = { ...process.env, TEST_DATABASE_URL: lane.url };
  delete environment.NODE_TEST_CONTEXT;
  try {
    await execute(process.execPath, [script, "up"], { env: environment });
    // Run the real startup regressions before intentionally breaking login.
    await execute(process.execPath, ["--test", "--test-timeout=60000", "tests/db/startup.integration.check.mjs"],
      { env: environment, timeout: 60000 });
    await admin.connect();
    await admin.query("ALTER ROLE dfs_ev_test PASSWORD 'startup-failure-test-only'");
    await admin.end();
    await assert.rejects(execute(process.execPath, [script, "local"], { env: environment, timeout: 60000 }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /password authentication failed/);
      assert.doesNotMatch(error.stderr, /another DB test run is active/);
      return true;
    });
    const result = await execute("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${lane.project}`]);
    assert.equal(result.stdout.trim(), "", "Non-contention startup failure left the service running");
  } finally {
    await admin.end();
    await execute(process.execPath, [script, "down"], { env: environment });
  }
});
