import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  canonicalJson, fingerprint, parseCatalogOptions, validateOutputPath,
} from "../../scripts/db-catalog.mjs";
import { LOCAL_TEST_DATABASE_URL } from "./target.mts";
import { compareCatalogs } from "../../scripts/compare-db-catalog.mjs";

// Fictional credentials/endpoint: parsing tests never connect to this host.
const remoteUrl = "postgresql://catalog_reader:synthetic-password@ep-example.us-west-2.aws.neon.tech/neondb?sslmode=require";
const remoteEnv = { MIGRATION_DATABASE_URL: remoteUrl };
const remoteArgs = ["--environment", "production", "--expected-host-fingerprint",
  fingerprint("ep-example.us-west-2.aws.neon.tech").slice(0, 12), "--expected-database", "neondb", "--output", "/private/tmp/catalog.json"];

test("catalog requires explicit credentials, environment and matching expected target", () => {
  const parsed = parseCatalogOptions(remoteArgs, remoteEnv);
  assert.equal(parsed.config.database, "neondb");
  assert.equal(parsed.identity.declaredEnvironment, "production");
  assert.equal(parsed.config.query_timeout, 20_000);
  const identity = parseCatalogOptions(["--environment", "production", "--identity"], remoteEnv).identity;
  assert.ok(!JSON.stringify(identity).includes("synthetic-password"));
  assert.ok(!JSON.stringify(identity).includes("ep-example"));
  for (const [args, env] of [
    [[], remoteEnv], [remoteArgs, { DATABASE_URL: remoteUrl }],
    [remoteArgs.map((arg) => arg === "neondb" ? "another" : arg), remoteEnv],
    [remoteArgs.map((arg) => arg === parsed.identity.hostFingerprint ? "000000000000" : arg), remoteEnv],
    [remoteArgs, { ...remoteEnv, PGHOST: "example.invalid" }],
    [remoteArgs.concat("--unknown"), remoteEnv],
  ]) assert.throws(() => parseCatalogOptions(args, env));
});

test("catalog rejects pooled, non-Neon and URL overrides without reflecting credentials", () => {
  for (const url of [
    remoteUrl.replace("ep-example.", "ep-example-pooler."),
    remoteUrl.replace(".neon.tech", ".example.invalid"),
    remoteUrl.replace("postgresql:", "https:"),
    remoteUrl.replace("/neondb", "/neondb/extra"),
    remoteUrl + "&sslmode=require", remoteUrl + "&host=example.invalid",
    remoteUrl + "&options=-csearch_path=other", remoteUrl + "#fragment", remoteUrl + "\n",
  ]) {
    assert.throws(() => parseCatalogOptions(remoteArgs, { MIGRATION_DATABASE_URL: url }), (error) => {
      assert.ok(!error.message.includes(url));
      assert.ok(!error.message.includes("synthetic-password"));
      return true;
    });
  }
});

test("catalog test mode retains the existing strict disposable guard", () => {
  const args = ["--environment", "test", "--identity"];
  assert.equal(parseCatalogOptions(args, { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }).config.database, "dfs_ev_test");
  for (const env of [
    {}, { DATABASE_URL: LOCAL_TEST_DATABASE_URL },
    { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL, MIGRATION_DATABASE_URL: remoteUrl },
    { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "example.invalid") },
    { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL, ODDS_API_KEY: "synthetic" },
  ]) assert.throws(() => parseCatalogOptions(args, env));
});

test("catalog fingerprint canonicalizes object keys without discarding semantic differences", () => {
  assert.equal(canonicalJson({ b: [1, { y: false, x: null }], a: "v" }), canonicalJson({ a: "v", b: [1, { x: null, y: false }] }));
  assert.notEqual(fingerprint(canonicalJson({ not_null: true })), fingerprint(canonicalJson({ not_null: false })));
});

test("snapshot destinations must be outside the repo, including symlinked parents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-catalog-output-"));
  try {
    assert.equal(await validateOutputPath(join(directory, "safe.json")), join(directory, "safe.json"));
    await assert.rejects(validateOutputPath("db/catalog.json"), /outside-repository/);
    await assert.rejects(validateOutputPath(join(directory, "wrong.sql")), /json-output-required/);
    await symlink(process.cwd(), join(directory, "repo"));
    await assert.rejects(validateOutputPath(join(directory, "repo", "catalog.json")), /outside-repository/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI refuses malformed configuration without printing parser errors or URL values", () => {
  const result = spawnSync(process.execPath, ["scripts/db-catalog.mjs", ...remoteArgs], {
    encoding: "utf8", env: { MIGRATION_DATABASE_URL: "postgresql://synthetic-private-value@bad" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "db-catalog: direct-neon-url-required\n");
});

test("catalog comparison reports every missing, unexpected and changed definition", () => {
  const snapshot = (objects) => ({ formatVersion: 1, postgresMajor: 18, schema: "public", objects });
  const expected = snapshot([
    { kind: "column", name: "example.value", definition: { not_null: true, type: "integer" } },
    { kind: "index", name: "example_lookup", definition: { valid: true } },
  ]);
  const actual = snapshot([
    { kind: "column", name: "example.value", definition: { not_null: false, type: "text" } },
    { kind: "relation", name: "unreviewed", definition: { kind: "r" } },
  ]);
  assert.equal(compareCatalogs(expected, actual).length, 4);
  assert.deepEqual(compareCatalogs(expected, { ...expected, capturedAt: "later", target: { hostFingerprint: "another" } }), []);
  assert.match(compareCatalogs(expected, { ...expected, postgresMajor: 19 })[0], /regenerate/);
  assert.throws(() => compareCatalogs(expected, snapshot([actual.objects[0], actual.objects[0]])), /invalid-catalog-object/);
});
