import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { fingerprint, readCatalog } from "../../scripts/db-catalog.mjs";
import { compareCatalogs } from "../../scripts/compare-db-catalog.mjs";
import { buildCatalogContracts, checkCatalogContractArtifacts } from "../../scripts/db-catalog-contracts.mjs";
import { compareCandidateCatalog, createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createScratchHarness } from "./scratch.mjs";

let harness;
let files;
let contracts;
let verify;
before(async () => {
  files = await checkMigrationArtifacts();
  contracts = await loadCatalogContracts(files);
  verify = createCatalogVerifier(contracts);
  harness = await createScratchHarness(process.env);
});
after(async () => { await harness?.close(); });
const optionsFor = (expected, overrides = {}) => ({ expected, files, assertTarget: harness.assertTarget, verify, ...overrides });
const has = (differences, prefix) => assert.ok(differences.some((difference) => difference.startsWith(prefix)), "Missing mismatch: " + prefix);

test("both generated contracts match independent historical fixtures without a ledger", async () => {
  for (const [index, name] of ["pre-41.schema.sql", "current-before-60.schema.sql"].entries()) {
    await harness.withDatabase(async (client, expected) => {
      await client.query(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"));
      assert.deepEqual(await compareCandidateCatalog(client, contracts, index + 1, { includeLedger: false }), []);
      const snapshot = await readCatalog(client, expected);
      assert.deepEqual(compareCatalogs(contracts.migrations[index], snapshot), []);
      assert.equal(snapshot.objects.filter((object) => object.kind === "relation").length, index === 0 ? 8 : 17);
      assert.ok(!JSON.stringify(snapshot).includes("RI_ConstraintTrigger_"));
    });
  }
});

test("full verifier reports every real column, key, check, FK, index, sequence and unexpected-object mismatch without repair", async () => {
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected));
    await client.query(`
      ALTER TABLE creators ALTER COLUMN channel_name DROP NOT NULL;
      ALTER TABLE creators ALTER COLUMN created_at SET DEFAULT '2000-01-01T00:00:00Z'::timestamptz;
      ALTER TABLE creators ADD COLUMN extra_value integer;
      ALTER TABLE nflverse_roster_players DROP COLUMN football_name;
      ALTER TABLE player_game_stats ALTER COLUMN stat_value TYPE numeric(12,2);
      ALTER TABLE player_crosswalk DROP CONSTRAINT player_crosswalk_pkey;
      ALTER TABLE creator_video_submissions DROP CONSTRAINT creator_video_submissions_video_url_key;
      ALTER TABLE odds_observations DROP CONSTRAINT odds_observations_quota_remaining_check;
      ALTER TABLE odds_observations ADD CONSTRAINT odds_observations_quota_remaining_check CHECK (quota_remaining >= 1) NOT VALID;
      ALTER TABLE creator_video_submissions DROP CONSTRAINT creator_video_submissions_creator_id_fkey;
      ALTER TABLE creator_video_submissions ADD CONSTRAINT creator_video_submissions_creator_id_fkey
        FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE NOT VALID;
      DROP INDEX idx_player_game_stats_lookup;
      CREATE INDEX idx_player_game_stats_lookup ON player_game_stats (player_id, stat_type, game_date ASC);
      ALTER SEQUENCE creators_id_seq AS integer START WITH 10 RESTART WITH 10 INCREMENT BY 2
        MINVALUE 2 MAXVALUE 100000 CACHE 3 CYCLE OWNED BY NONE;
      DROP TABLE sync_state;
      CREATE TABLE db_migrations_unreviewed (id integer);
      CREATE VIEW drift_view AS SELECT id FROM creators;
      CREATE SEQUENCE drift_sequence;
      CREATE TYPE drift_enum AS ENUM ('synthetic');
      CREATE DOMAIN drift_domain AS integer CHECK (VALUE > 0);
      CREATE TYPE drift_range AS RANGE (subtype = integer);
      CREATE TYPE drift_composite AS (value integer);
      CREATE STATISTICS drift_statistics ON id, channel_name FROM creators;
      CREATE FUNCTION drift_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER drift_trigger BEFORE INSERT ON creators FOR EACH ROW EXECUTE FUNCTION drift_trigger();
      CREATE POLICY drift_policy ON creators USING (true);
      CREATE RULE drift_rule AS ON UPDATE TO creators DO ALSO NOTIFY synthetic_catalog_drift;
    `);
    const original = await readCatalog(client, expected);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const differences = await compareCandidateCatalog(client, contracts, files.length);
    for (const prefix of [
      "Changed column:creators.channel_name / not_null", "Changed column:creators.created_at / default",
      "Unexpected column:creators.extra_value", "Missing column:nflverse_roster_players.football_name",
      "Changed column:player_game_stats.stat_value / type", "Missing constraint:player_crosswalk.player_crosswalk_pkey",
      "Missing constraint:creator_video_submissions.creator_video_submissions_video_url_key",
      "Changed constraint:odds_observations.odds_observations_quota_remaining_check / definition",
      "Changed constraint:odds_observations.odds_observations_quota_remaining_check / validated",
      "Changed constraint:creator_video_submissions.creator_video_submissions_creator_id_fkey / definition",
      "Changed constraint:creator_video_submissions.creator_video_submissions_creator_id_fkey / validated",
      "Changed index:idx_player_game_stats_lookup / definition", "Missing relation:sync_state",
      "Unexpected relation:db_migrations_unreviewed", "Unexpected relation:drift_view",
      "Unexpected sequence:drift_sequence", "Unexpected type:drift_enum", "Unexpected routine:drift_trigger()",
      "Unexpected type:drift_domain", "Unexpected domain_constraint:drift_domain.drift_domain_check",
      "Unexpected unsupported:type.drift_range", "Unexpected unsupported:type.drift_composite", "Unexpected unsupported:statistics.drift_statistics",
      "Unexpected trigger:creators.drift_trigger", "Unexpected policy:creators.drift_policy", "Unexpected rule:creators.drift_rule",
      ...["type", "start", "increment", "minimum", "maximum", "cache", "cycle", "owned_by"].map((field) => "Changed sequence:creators_id_seq / " + field),
    ]) has(differences, prefix);
    await assert.rejects(runScratchMigrations(client, optionsFor(expected)), (error) => {
      assert.equal(error.message, "candidate-catalog-mismatch");
      assert.deepEqual(error.differences, differences);
      return true;
    });
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
    assert.deepEqual((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows, ledger);
  });
});

test("unenforced foreign keys and disabled internal enforcement triggers are detected independently of validation", async () => {
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected));
    await client.query("ALTER TABLE creator_video_submissions ALTER CONSTRAINT creator_video_submissions_creator_id_fkey NOT ENFORCED");
    has(await compareCandidateCatalog(client, contracts, files.length),
      "Changed constraint:creator_video_submissions.creator_video_submissions_creator_id_fkey / enforced");
    await client.query("ALTER TABLE creator_video_submissions ALTER CONSTRAINT creator_video_submissions_creator_id_fkey ENFORCED");
    await verify(client, files.length);
    await client.query("ALTER TABLE creator_video_submissions DISABLE TRIGGER ALL");
    const differences = await compareCandidateCatalog(client, contracts, files.length);
    has(differences, "Changed constraint:creator_video_submissions.creator_video_submissions_creator_id_fkey / trigger_states");
    assert.ok(!differences.some((difference) => difference.includes(" / validated") || difference.includes(" / enforced")));
    await assert.rejects(verify(client, files.length), /candidate-catalog-mismatch/);
  });
});

test("a naturally failed concurrent unique-index build exposes invalidity to the verifier", async () => {
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected));
    await client.query("INSERT INTO creators (channel_name) VALUES ('synthetic duplicate index target')");
    await client.query(`INSERT INTO creator_video_submissions (creator_id, video_url, transcript_text)
      SELECT id, url, 'synthetic transcript' FROM creators CROSS JOIN (VALUES ('https://example.invalid/one'), ('https://example.invalid/two')) urls(url)`);
    await client.query("DROP INDEX idx_creator_video_submissions_creator");
    await assert.rejects(client.query("CREATE UNIQUE INDEX CONCURRENTLY idx_creator_video_submissions_creator ON creator_video_submissions (creator_id)"),
      (error) => error.code === "23505");
    const differences = await compareCandidateCatalog(client, contracts, files.length);
    has(differences, "Changed index:idx_creator_video_submissions_creator / valid: expected true; actual false");
    has(differences, "Changed index:idx_creator_video_submissions_creator / ready: expected true; actual false");
    has(differences, "Changed index:idx_creator_video_submissions_creator / unique");
    await assert.rejects(runScratchMigrations(client, optionsFor(expected)), /candidate-catalog-mismatch/);
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM creator_video_submissions")).rows[0].count, 2);
  });
});

test("failed upgrade verification preserves the committed baseline, seeded rows and original ledger", async () => {
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected, { files: files.slice(0, 1) }));
    await client.query("INSERT INTO creators (channel_name) VALUES ('preserved baseline')");
    const original = await readCatalog(client, expected);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const observer = new Client(expected);
    try {
      await observer.connect();
      await assert.rejects(runScratchMigrations(client, optionsFor(expected, { verify: async (session, version) => {
        assert.equal((await session.query("SELECT count(*)::integer AS count FROM db_migrations")).rows[0].count, files.length);
        assert.equal((await observer.query("SELECT count(*)::integer AS count FROM db_migrations")).rows[0].count, 1);
        assert.equal((await observer.query("SELECT to_regclass('public.odds_observations') AS relation")).rows[0].relation, null);
        await session.query("ALTER TABLE odds_observations ALTER COLUMN captured_at DROP NOT NULL");
        await verify(session, version);
      } })), /candidate-catalog-mismatch/);
    } finally { await observer.end(); }
    assert.deepEqual(compareCatalogs(original, await readCatalog(client, expected)), []);
    assert.deepEqual((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows, ledger);
    assert.deepEqual((await client.query("SELECT channel_name FROM creators")).rows, [{ channel_name: "preserved baseline" }]);
    await verify(client, 1);
  });
});

test("extra ledger objects and removed ledger constraints fail even when ledger rows remain valid", async () => {
  for (const drift of ["ALTER TABLE db_migrations ADD COLUMN unreviewed text",
    "ALTER TABLE db_migrations DROP CONSTRAINT db_migrations_sha256_check"]) {
    await harness.withDatabase(async (client, expected) => {
      await runScratchMigrations(client, optionsFor(expected));
      await client.query(drift);
      const original = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      await assert.rejects(runScratchMigrations(client, optionsFor(expected)), /candidate-catalog-mismatch/);
      assert.deepEqual((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows, original);
    });
  }
});

test("fresh scratch databases reproduce contracts while ignoring owner roles, OIDs and sequence progress", async () => {
  const first = await buildCatalogContracts(harness, files);
  const second = await buildCatalogContracts(harness, files);
  assert.deepEqual([...second], [...first]);
  assert.deepEqual(await checkCatalogContractArtifacts(first), []);
  const oids = [];
  for (let index = 0; index < 2; index++) {
    await harness.withDatabase(async (client, expected) => {
      await runScratchMigrations(client, optionsFor(expected));
      oids.push((await client.query("SELECT 'public.creators'::regclass::oid AS oid")).rows[0].oid);
      await client.query("ALTER TABLE creators OWNER TO pg_database_owner");
      await client.query("SELECT setval('creators_id_seq', 100000, true)");
      await verify(client, files.length);
    });
  }
  assert.notEqual(oids[0], oids[1]);
});

test("contract generation refuses unsupported managed objects and cleans up its scratch databases", async () => {
  const sql = files[0].sql + "\nCREATE TYPE unreviewed_range AS RANGE (subtype = integer);\n";
  await assert.rejects(buildCatalogContracts(harness, [{ ...files[0], sql, sha256: fingerprint(sql) }]), /unsupported-catalog-object/);
});

test("an extension can be explicitly contracted without its members hiding application drift", async () => {
  const sql = "CREATE EXTENSION pg_trgm WITH SCHEMA public;\n";
  const extensionFiles = [...files, { version: files.length + 1, filename: "0004_synthetic_extension.sql", sql, sha256: fingerprint(sql) }];
  const artifacts = await buildCatalogContracts(harness, extensionFiles);
  const extensionContracts = { ledger: JSON.parse(artifacts.get("ledger.json")),
    migrations: extensionFiles.map((file) => file.version).map((version) => JSON.parse(artifacts.get("000" + version + ".json"))) };
  assert.deepEqual(compareCatalogs(contracts.migrations.at(-1), extensionContracts.migrations.at(-1)), ["Unexpected extension:pg_trgm"]);
  await harness.withDatabase(async (client, expected) => {
    await runScratchMigrations(client, optionsFor(expected));
    await client.query(sql);
    assert.deepEqual(await compareCandidateCatalog(client, contracts, files.length), ["Unexpected extension:pg_trgm"]);
    await assert.rejects(runScratchMigrations(client, optionsFor(expected)), /candidate-catalog-mismatch/);
    await client.query("DROP EXTENSION pg_trgm");
    const options = optionsFor(expected, { files: extensionFiles, verify: createCatalogVerifier(extensionContracts) });
    assert.deepEqual((await runScratchMigrations(client, options)).executed, [files.length + 1]);
    assert.deepEqual((await runScratchMigrations(client, options)).executed, []);
    const incorrectVersion = structuredClone(extensionContracts);
    incorrectVersion.migrations.at(-1).objects.find((object) => object.kind === "extension").definition.version = "unreviewed";
    has(await compareCandidateCatalog(client, incorrectVersion, extensionFiles.length), "Changed extension:pg_trgm / version");
    await client.query("ALTER TABLE creators ALTER COLUMN channel_name DROP NOT NULL");
    has(await compareCandidateCatalog(client, extensionContracts, extensionFiles.length), "Changed column:creators.channel_name / not_null");
    await assert.rejects(runScratchMigrations(client, options), /candidate-catalog-mismatch/);
  });
});
