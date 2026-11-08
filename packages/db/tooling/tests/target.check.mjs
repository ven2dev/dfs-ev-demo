import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertNoApplicationCredentials,
  getTestDatabaseLane,
  LOCAL_TEST_DATABASE_URL,
  parseTestDatabaseUrl,
} from "./target.mts";

test("accepts only explicit loopback test connections", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const parsed = parseTestDatabaseUrl(LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", host), "default");
    assert.equal(parsed.database, "dfs_ev_test");
    assert.equal(parsed.port, 54329);
    assert.equal(parsed.host, host === "[::1]" ? "::1" : "127.0.0.1");
  }
});

test("rejects missing, external, production, ambiguous, and overridden targets without exposing the URL", () => {
  const refused = [
    undefined,
    "",
    "not-a-url",
    LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "example.com"),
    LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "127.0.0.1.example.com"),
    LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "0.0.0.0"),
    LOCAL_TEST_DATABASE_URL.replace("postgresql:", "https:"),
    LOCAL_TEST_DATABASE_URL.replace("54329", "5432"),
    LOCAL_TEST_DATABASE_URL.replace(":54329", ""),
    LOCAL_TEST_DATABASE_URL.replace("/dfs_ev_test", "/production"),
    LOCAL_TEST_DATABASE_URL.replace("/dfs_ev_test", "/dfs_ev_test/extra"),
    LOCAL_TEST_DATABASE_URL.replace("/dfs_ev_test", "/%ZZ"),
    LOCAL_TEST_DATABASE_URL.replace("dfs_ev_test:", "postgres:"),
    LOCAL_TEST_DATABASE_URL.replace(":dfs_ev_test@", ":different@"),
    LOCAL_TEST_DATABASE_URL + "?host=example.com",
    LOCAL_TEST_DATABASE_URL + "?sslmode=require",
    LOCAL_TEST_DATABASE_URL + "?options=-csearch_path=public",
    LOCAL_TEST_DATABASE_URL + "#fragment",
    LOCAL_TEST_DATABASE_URL + "\n",
  ];
  for (const value of refused) {
    assert.throws(() => parseTestDatabaseUrl(value, "default"), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!value || !error.message.includes(value));
      return true;
    });
  }
});

test("rejects application credentials and ambient pg configuration", () => {
  assert.doesNotThrow(() => assertNoApplicationCredentials({
    TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL,
    ODDS_DATA_SOURCE: "fixture",
  }));
  for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "ODDS_API_KEY", "FIREBASE_ADMIN_PROJECT_ID", "FIREBASE_ADMIN_PRIVATE_KEY", "POSTGRES_URL", "PGHOST", "PGOPTIONS", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.throws(() => assertNoApplicationCredentials({ [name]: "test-only-placeholder" }));
  }
});

test("resolves the default and isolates each registered loopback port", () => {
  assert.equal(getTestDatabaseLane().url, LOCAL_TEST_DATABASE_URL);
  assert.equal(getTestDatabaseLane().project, "dfs-ev-demo-test");
  for (const [name, port] of [["lane-2", 54339], ["lane-3", 54349], ["lane-4", 54359]]) {
    const lane = getTestDatabaseLane(name);
    assert.equal(lane.project, `dfs-ev-demo-test-${name}`);
    assert.equal(parseTestDatabaseUrl(lane.url, name).port, port);
    assert.throws(() => parseTestDatabaseUrl(lane.url, "default"));
    assert.throws(() => parseTestDatabaseUrl(LOCAL_TEST_DATABASE_URL, name));
    assert.throws(() => parseTestDatabaseUrl(lane.url.replace(String(port), "54369"), name));
  }
  for (const selector of ["", "__proto__", "lane-5"]) assert.throws(() => getTestDatabaseLane(selector));
});

test("the harness refuses a default resize or a lane mismatch before calling Docker", () => {
  const script = fileURLToPath(new URL("../../../../scripts/db/test-db.mjs", import.meta.url));
  for (const [mode, env, reason] of [
    ["up", { DB_TEST_TIER: "large" }, /default DB test lane is fixed at 512 MiB/],
    ["up", { DB_TEST_LANE: "lane-2", TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }, /selected DB_TEST_LANE/],
    ["down", { DB_TEST_LANE: "lane-2", TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }, /selected DB_TEST_LANE/],
  ]) {
    const result = spawnSync(process.execPath, [script, mode], {
      env: { PATH: "/nonexistent", ...env }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, reason);
    assert.ok(!result.stderr.includes(LOCAL_TEST_DATABASE_URL));
  }
});
