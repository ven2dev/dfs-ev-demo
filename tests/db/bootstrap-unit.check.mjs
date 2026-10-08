import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapPrimaryTestDatabase } from "./bootstrap.mjs";
import { LOCAL_TEST_DATABASE_URL } from "./target.mts";

test("primary migration bootstrap refuses unsafe targets and remote credentials before database access", async () => {
  const client = { query: () => assert.fail("Unsafe bootstrap must not issue SQL.") };
  for (const value of [undefined, LOCAL_TEST_DATABASE_URL.replace("/dfs_ev_test", "/production"),
    LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "example.invalid"),
    LOCAL_TEST_DATABASE_URL + "?options=-csearch_path=public"]) {
    await assert.rejects(bootstrapPrimaryTestDatabase(client, { TEST_DATABASE_URL: value }));
  }
  for (const key of ["MIGRATION_DATABASE_URL", "DATABASE_URL", "PGHOST"]) {
    await assert.rejects(bootstrapPrimaryTestDatabase(client, { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL, [key]: "synthetic-private-value" }));
  }
});
