import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { checkConnectedTarget } from "../../scripts/db-migrations/core.mjs";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

export async function createScratchHarness(environment) {
  assertNoApplicationCredentials(environment);
  if (environment.MIGRATION_DATABASE_URL !== undefined) throw new Error("Remote credentials are refused in the scratch harness.");
  const base = Object.freeze(parseTestDatabaseUrl(environment.TEST_DATABASE_URL));
  const active = new Set();
  const admin = new Client(base);
  try {
    await admin.connect();
    await checkConnectedTarget(admin, base);
  } catch (error) {
    await admin.end();
    throw error;
  }
  function assertTarget(config) {
    if (!config || !/^dfs_ev_test_[a-f0-9]{20}$/.test(config.database) || !active.has(config.database) ||
        Object.keys(base).some((key) => key !== "database" && config[key] !== base[key]) ||
        Object.keys(config).some((key) => !Object.hasOwn(base, key))) throw new Error("Unregistered scratch target refused.");
  }
  return {
    assertTarget,
    async withDatabase(run) {
      const name = "dfs_ev_test_" + randomBytes(10).toString("hex");
      await admin.query(`CREATE DATABASE "${name}"`);
      active.add(name);
      const config = Object.freeze({ ...base, database: name });
      const client = new Client(config);
      try {
        assertTarget(config);
        await client.connect();
        await checkConnectedTarget(client, config);
        return await run(client, config);
      } finally {
        try { await client.end(); }
        finally {
          assertTarget(config);
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          active.delete(name);
        }
      }
    },
    async close() {
      try { if (active.size) throw new Error("Scratch databases remain active."); }
      finally { await admin.end(); }
    },
  };
}
