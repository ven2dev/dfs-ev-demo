import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoApplicationCredentials,
  LOCAL_TEST_DATABASE_URL,
  parseTestDatabaseUrl,
} from "./target.mts";

test("accepts only explicit loopback test connections", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const parsed = parseTestDatabaseUrl(LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", host));
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
    assert.throws(() => parseTestDatabaseUrl(value), (error) => {
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
