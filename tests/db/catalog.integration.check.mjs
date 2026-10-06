import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { readCatalog } from "../../scripts/db-catalog.mjs";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

const activeScratch = new Set();
let admin;
let baseConfig;
before(async () => {
  assertNoApplicationCredentials(process.env);
  baseConfig = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  admin = new Client(baseConfig);
  await admin.connect();
  const { rows: [identity] } = await admin.query("SELECT current_database() AS database, current_user AS role, current_setting('server_version_num')::integer AS version");
  assert.equal(identity.database, "dfs_ev_test");
  assert.equal(identity.role, "dfs_ev_test");
  assert.ok(identity.version >= 180000 && identity.version < 190000);
});
after(async () => { await admin?.end(); });

async function withScratch(run) {
  const name = "dfs_ev_test_" + randomBytes(10).toString("hex");
  assert.match(name, /^dfs_ev_test_[a-f0-9]{20}$/);
  await admin.query(`CREATE DATABASE "${name}"`);
  activeScratch.add(name);
  const config = { ...baseConfig, database: name };
  const client = new Client(config);
  try {
    await client.connect();
    return await run(client, config);
  } finally {
    try { await client.end(); }
    finally {
      assert.ok(activeScratch.has(name));
      assert.match(name, /^dfs_ev_test_[a-f0-9]{20}$/);
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      activeScratch.delete(name);
    }
  }
}

test("empty export creates neither application objects nor migration ledger", async () => {
  await withScratch(async (client, config) => {
    const snapshot = await readCatalog(client, config);
    assert.equal(snapshot.postgresMajor, 18);
    assert.deepEqual(snapshot.objects, []);
    const { rows: [state] } = await client.query("SELECT to_regclass('public.db_migrations') AS ledger");
    assert.equal(state.ledger, null);
  });
});

test("exports authentic eight-table pre-41 and seventeen-table current candidates", async () => {
  const legacy = execFileSync("git", ["show", "68c65f6e918730b0d8b22a761a482a79225347b6:db/schema.sql"], { encoding: "utf8" });
  const current = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  for (const [sql, expectedCount] of [[legacy, 8], [current, 17]]) {
    await withScratch(async (client, config) => {
      await client.query(sql);
      const snapshot = await readCatalog(client, config);
      assert.equal(snapshot.objects.filter((object) => object.kind === "relation").length, expectedCount);
      assert.ok(snapshot.objects.some((object) => object.kind === "constraint" && object.name.startsWith("creator_video_submissions.") && object.definition.type === "f"));
      assert.ok(snapshot.objects.some((object) => object.kind === "index" && object.name === "idx_player_game_stats_lookup" && object.definition.valid));
      assert.equal(snapshot.objects.find((object) => object.kind === "column" && object.name === "creator_video_submissions.video_url").definition.not_null, true);
      assert.equal(snapshot.objects.find((object) => object.kind === "sequence" && object.name === "creators_id_seq").definition.maximum, "9223372036854775807");
      assert.deepEqual(snapshot.objects.find((object) => object.kind === "sequence" && object.name === "creators_id_seq").definition.owned_by, ["public.creators.id"]);
      assert.ok(snapshot.objects.every((object) => !object.name.includes("db_migrations")));
      if (expectedCount === 17) {
        const names = new Set(snapshot.objects.filter((object) => object.kind === "relation").map((object) => object.name));
        for (const table of ["odds_observations", "odds_quote_sets", "odds_observation_markets", "odds_observation_book_markets", "odds_quotes", "odds_free_pilot_selections", "odds_priority_targets", "odds_collection_checkpoints", "odds_api_request_log"]) assert.ok(names.has(table));
      }
    });
  }
});

test("exports preserve synthetic rows and exclude row values and sequence progress", async () => {
  await withScratch(async (client, config) => {
    await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic-private-row-one')");
    const first = await readCatalog(client, config);
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic-private-row-two')");
    const second = await readCatalog(client, config);
    assert.deepEqual(first.objects, second.objects);
    assert.equal(first.catalogFingerprint, second.catalogFingerprint);
    assert.ok(!JSON.stringify(second).includes("synthetic-private-row"));
    const { rows } = await client.query("SELECT channel_name FROM creators ORDER BY id");
    assert.deepEqual(rows.map((row) => row.channel_name), ["synthetic-private-row-one", "synthetic-private-row-two"]);
  });
});

test("database enforces read-only export and failed exports roll back their session", async () => {
  await withScratch(async (client, config) => {
    const guardedClient = { query: async (text, params) => {
      if (text.includes("WITH relations AS")) await client.query("CREATE TABLE exporter_must_not_create (id integer)");
      return client.query(text, params);
    } };
    await assert.rejects(readCatalog(guardedClient, config), (error) => error.code === "25006");
    const { rows: [state] } = await client.query("SELECT to_regclass('public.exporter_must_not_create') AS unwanted, current_setting('transaction_read_only') AS readonly");
    assert.equal(state.unwanted, null);
    assert.equal(state.readonly, "off");
    assert.deepEqual((await readCatalog(client, config)).objects, []);
  });
});

test("catalog refuses an unexpected connected database before catalog access", async () => {
  await withScratch(async (client, config) => {
    await assert.rejects(readCatalog(client, { ...config, database: "another_test" }), /connected-target-mismatch/);
    assert.deepEqual((await readCatalog(client, config)).objects, []);
  });
});
