import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { expect, it } from "vitest";
import { DB_READINESS_MANIFEST } from "../../src/lib/dbReadinessManifest";
import { DB_READINESS_HISTORY_LIMIT, DB_READINESS_HISTORY_SQL, DB_READINESS_RELATIONS_SQL,
  DB_READINESS_SETTINGS_SQL, evaluateDatabaseReadiness, readinessRelations } from "../../src/lib/dbReadiness";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { insertLedgerRow, ledgerSql, runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createScratchHarness } from "./scratch.mjs";

const required = [...DB_READINESS_MANIFEST.requiredTables, "db_migrations"];
async function inspect(client: Client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query(DB_READINESS_SETTINGS_SQL);
    const state = readinessRelations((await client.query(DB_READINESS_RELATIONS_SQL, [required])).rows);
    const history = state.ledgerPresent ? (await client.query(DB_READINESS_HISTORY_SQL, [DB_READINESS_HISTORY_LIMIT + 1])).rows : [];
    await client.query("COMMIT");
    return evaluateDatabaseReadiness({ ...state, history });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function withScratch(run: (client: Client, install: () => Promise<unknown>) => Promise<void>) {
  const harness = await createScratchHarness(process.env);
  const files = await checkMigrationArtifacts();
  const contracts = await loadCatalogContracts(files);
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      await run(client, () => runScratchMigrations(client, { expected, files,
        assertTarget: harness.assertTarget, verify: createCatalogVerifier(contracts) }));
    });
  } finally { await harness.close(); }
}

it("database readiness reports missing ledger without creating one on authentic current schema", async () => {
  await withScratch(async (client) => {
    await client.query(await readFile(new URL("./fixtures/current-before-60.schema.sql", import.meta.url), "utf8"));
    await client.query("INSERT INTO creators (channel_name) VALUES ('Synthetic readiness')");
    const rows = (await client.query("SELECT * FROM creators")).rows;
    expect(await inspect(client)).toMatchObject({ status: "not-ready", schemaVersion: 0, reasons: ["migration-ledger-missing"] });
    expect((await client.query("SELECT to_regclass('public.db_migrations') AS ledger")).rows[0].ledger).toBeNull();
    expect((await client.query("SELECT * FROM creators")).rows).toEqual(rows);
  });
});

it("database readiness accepts migrated history and valid ahead history while preserving rows", async () => {
  await withScratch(async (client, install) => {
    await install();
    await client.query("INSERT INTO creators (channel_name) VALUES ('Synthetic readiness')");
    const rows = (await client.query("SELECT * FROM creators")).rows;
    const history = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(await inspect(client)).toMatchObject({ status: "ready", schemaVersion: 2, warnings: [] });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(history);
    await client.query(`INSERT INTO db_migrations (version, filename, sha256, runner_version, provenance)
      VALUES (3, '0003_future.sql', $1, 1, 'executed')`, ["a".repeat(64)]);
    const ahead = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(await inspect(client)).toMatchObject({ status: "ready", schemaVersion: 3, warnings: ["schema-ahead"] });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(ahead);
    expect((await client.query("SELECT * FROM creators")).rows).toEqual(rows);
  });
});

it("database readiness refuses behind, corrupt and missing-table states without repair", async () => {
  await withScratch(async (client) => {
    await client.query(await readFile(new URL("./fixtures/pre-41.schema.sql", import.meta.url), "utf8"));
    await client.query(ledgerSql);
    const files = await checkMigrationArtifacts();
    await insertLedgerRow(client, files[0], "adopted");
    expect(await inspect(client)).toMatchObject({ status: "not-ready", schemaVersion: 1, reasons: ["schema-behind"] });
  });
  await withScratch(async (client, install) => {
    await install();
    await client.query("UPDATE db_migrations SET sha256 = $1 WHERE version = 1", ["b".repeat(64)]);
    const corrupt = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(await inspect(client)).toMatchObject({ status: "not-ready", reasons: ["migration-history-invalid"] });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(corrupt);
    await client.query("UPDATE db_migrations SET sha256 = $1 WHERE version = 1", [DB_READINESS_MANIFEST.migrations[0].sha256]);
    await client.query("DROP TABLE sync_state");
    expect(await inspect(client)).toMatchObject({ status: "not-ready", schemaVersion: 2, reasons: ["required-tables-missing"] });
    expect((await client.query("SELECT to_regclass('public.sync_state') AS relation")).rows[0].relation).toBeNull();
  });
});

it("database readiness reads are bounded, enforced read-only and reject view substitutes", async () => {
  await withScratch(async (client, install) => {
    await install();
    await client.query("DROP TABLE sync_state; CREATE VIEW sync_state AS SELECT 1 AS synthetic");
    expect(await inspect(client)).toMatchObject({ status: "not-ready", reasons: ["required-tables-missing"] });
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query(DB_READINESS_SETTINGS_SQL);
      const bounds = (await client.query(`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock, current_setting('transaction_read_only') AS readonly`)).rows[0];
      expect(bounds).toEqual({ statement: "2s", lock: "1s", readonly: "on" });
      await expect(client.query("DELETE FROM db_migrations")).rejects.toMatchObject({ code: "25006" });
    } finally { await client.query("ROLLBACK"); }
    await client.query(`INSERT INTO db_migrations (version, filename, sha256, runner_version, provenance)
      SELECT n, lpad(n::text, 4, '0') || '_synthetic.sql', $1, 1, 'executed'
      FROM generate_series(3, $2::integer) AS n`, ["a".repeat(64), DB_READINESS_HISTORY_LIMIT + 10]);
    const history = (await client.query(DB_READINESS_HISTORY_SQL, [DB_READINESS_HISTORY_LIMIT + 1])).rows;
    expect(history).toHaveLength(DB_READINESS_HISTORY_LIMIT + 1);
    expect(evaluateDatabaseReadiness({ ledgerPresent: true, requiredTablesPresent: true, history }).reasons)
      .toEqual(["migration-history-limit-exceeded"]);
    expect((await client.query("SELECT count(*)::integer AS count FROM db_migrations")).rows[0].count)
      .toBe(DB_READINESS_HISTORY_LIMIT + 10);
  });
});
