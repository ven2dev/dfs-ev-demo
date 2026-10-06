import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fingerprint } from "../../scripts/db-catalog.mjs";
import { assertTransactionalSql, buildManifest, checkMigrationArtifacts, loadMigrationSet,
  readMigrationFiles, validateManifest } from "../../scripts/db-migrations/files.mjs";
import { validateHistory } from "../../scripts/db-migrations/core.mjs";
import { parseMigrationCommand } from "../../scripts/db-migrate.mjs";
import { LOCAL_TEST_DATABASE_URL } from "./target.mts";

async function withFiles(run) {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-migration-files-"));
  try {
    const migrations = join(directory, "migrations");
    await mkdir(migrations);
    await writeFile(join(migrations, "0001_first.sql"), "CREATE TABLE example (id integer);\n");
    await writeFile(join(migrations, "0002_second.sql"), "ALTER TABLE example ADD COLUMN value text;\n");
    await run(migrations, join(directory, "manifest.json"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("candidate artifacts preserve the authentic historical boundary and all schema comments", async () => {
  const files = await checkMigrationArtifacts();
  const legacy = await readFile(new URL("./fixtures/pre-41.schema.sql", import.meta.url), "utf8");
  const original = await readFile(new URL("./fixtures/current-before-60.schema.sql", import.meta.url), "utf8");
  assert.equal(fingerprint(legacy), "a01c8ab5d91939d731c71571ede83bfc4e6123ef1f61b8a0918f4f951f306c98");
  assert.equal(fingerprint(original), "95c349dc4fb79a604ce3c38abe2d064673bd6d6a86e3cbed8a086744102a85c2");
  assert.equal(files[0].sql, legacy);
  assert.equal(files.length, 2);
  assert.equal(files.map((file) => file.sql).join("\n"), original);
});

test("manifest rejects edited bytes, missing files, extra fields and unsupported runner versions", async () => {
  await withFiles(async (directory, path) => {
    const files = await readMigrationFiles(directory);
    const manifest = buildManifest(files);
    await writeFile(path, JSON.stringify(manifest));
    await loadMigrationSet(directory, path);
    assert.throws(() => validateManifest({ ...manifest, runnerVersion: 2 }, files));
    assert.throws(() => validateManifest({ ...manifest, ignored: true }, files));
    await writeFile(join(directory, "0001_first.sql"), files[0].sql + "-- edited\n");
    await assert.rejects(loadMigrationSet(directory, path), /migration-manifest-mismatch/);
    await rm(join(directory, "0002_second.sql"));
    await assert.rejects(loadMigrationSet(directory, path), /migration-manifest-mismatch/);
  });
});

test("migration files refuse gaps, down files, CRLF, empty content and symlinked SQL", async () => {
  for (const kind of ["gap", "down", "crlf", "empty", "symlink"]) {
    await withFiles(async (directory) => {
      if (kind === "gap") await writeFile(join(directory, "0004_gap.sql"), "SELECT 1;\n");
      if (kind === "down") await writeFile(join(directory, "0003_down.down.sql"), "DROP TABLE example;\n");
      if (kind === "crlf") await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\r\n");
      if (kind === "empty") await writeFile(join(directory, "0001_first.sql"), "\n");
      if (kind === "symlink") await symlink(join(directory, "0001_first.sql"), join(directory, "0003_link.sql"));
      await assert.rejects(readMigrationFiles(directory));
    });
  }
});

test("SQL cannot end the runner transaction even behind comments and quoted statements", () => {
  for (const sql of ["COMMIT;", "SELECT 1; /* outer /* nested */ tail */ COMMIT;", "-- before\nBEGIN;",
    "SELECT 'ordinary\\'; COMMIT;", "SELECT $$COMMIT$$; END;", "START /* gap */ TRANSACTION;",
    "SELECT name$body$ FROM example; COMMIT; SELECT other$body$ FROM example;",
    "ROLLBACK;", "PREPARE TRANSACTION 'name';", "SAVEPOINT other;"]) assert.throws(() => assertTransactionalSql(sql));
  for (const sql of ["SELECT 'COMMIT;';", "SELECT E'escaped\\\' COMMIT;';", "SELECT \"COMMIT\";",
    "DO $body$ BEGIN PERFORM 1; END $body$;", "/* outer /* COMMIT; */ END; */ SELECT 1;"]) assert.doesNotThrow(() => assertTransactionalSql(sql));
});

test("ledger validation refuses holes, checksum mismatches, empty history and unknown provenance", async () => {
  const files = await checkMigrationArtifacts();
  const rows = files.map((file) => ({ version: file.version, filename: file.filename,
    sha256: file.sha256, runner_version: 1, provenance: "executed", applied_at: "2026-10-05" }));
  assert.doesNotThrow(() => validateHistory(rows, files));
  for (const broken of [[], [rows[1]], [...rows, rows[1]],
    [{ ...rows[0], sha256: null }], [{ ...rows[0], sha256: "0".repeat(64) }],
    [{ ...rows[0], runner_version: 2 }], [{ ...rows[0], provenance: "unknown" }],
    [{ ...rows[0], applied_at: null }]]) assert.throws(() => validateHistory(broken, files));
});

test("manual status requires explicit matching targets and up requires approval before any connection", () => {
  const args = ["status", "--environment", "test", "--expected-host-fingerprint", fingerprint("127.0.0.1").slice(0, 12),
    "--expected-database", "dfs_ev_test"];
  assert.equal(parseMigrationCommand(args, { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }).config.database, "dfs_ev_test");
  for (const [input, environment] of [[args, {}], [args, { DATABASE_URL: LOCAL_TEST_DATABASE_URL }],
    [args.slice(0, -2), { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }], [["down"], {}], [["up"], {}]]) {
    assert.throws(() => parseMigrationCommand(input, environment));
  }
  const refused = spawnSync(process.execPath, ["scripts/db-migrate.mjs", "up"], { encoding: "utf8", env: {} });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, "db-migrate: approved-plan-fingerprint-required\n");
  const malformed = spawnSync(process.execPath, ["scripts/db-migrate.mjs", "status", "--environment", "production"],
    { encoding: "utf8", env: { MIGRATION_DATABASE_URL: "postgresql://synthetic-secret@bad" } });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr, "db-migrate: direct-neon-url-required\n");
  assert.equal(malformed.stdout, "");
});

test("manifest generation never rewrites known migration checksums", async () => {
  await withFiles(async (directory, path) => {
    const { generateMigrationArtifacts } = await import("../../scripts/db-migration-artifacts.mjs");
    const referenceFile = join(directory, "../reference.sql");
    const options = { directory, manifestFile: path, referenceFile };
    await generateMigrationArtifacts(options);
    const originalManifest = await readFile(path, "utf8");
    const originalReference = await readFile(referenceFile, "utf8");
    const originalSql = await readFile(join(directory, "0001_first.sql"), "utf8");
    await writeFile(join(directory, "0001_first.sql"), "SELECT 2;\n");
    await assert.rejects(generateMigrationArtifacts(options), /migration-manifest-mismatch/);
    assert.equal(await readFile(path, "utf8"), originalManifest);
    assert.equal(await readFile(referenceFile, "utf8"), originalReference);
    await writeFile(join(directory, "0001_first.sql"), originalSql);
    await writeFile(join(directory, "0003_append.sql"), "CREATE TABLE appended (id integer);\n");
    await generateMigrationArtifacts(options);
    assert.equal((await loadMigrationSet(directory, path)).length, 3);
  });
});
