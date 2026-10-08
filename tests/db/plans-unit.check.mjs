import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fingerprint } from "../../scripts/db-catalog.mjs";
import { loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { computeMigrationPlan, planFingerprint, prepareMigrationContext } from "../../scripts/db-migrations/plans.mjs";
import { parseMigrationCommand } from "../../scripts/db-migrate.mjs";
import { LOCAL_TEST_DATABASE_URL } from "./target.mts";

const files = await checkMigrationArtifacts();
const contracts = await loadCatalogContracts(files);
const argsFor = (command) => [command, "--environment", "test", "--expected-host-fingerprint",
  fingerprint("127.0.0.1").slice(0, 12), "--expected-database", "dfs_ev_test"];

test("planning context freezes validated source and refuses edited bytes, contracts and forged contexts", async () => {
  const inputFiles = structuredClone(files);
  const inputContracts = structuredClone(contracts);
  const context = await prepareMigrationContext(inputFiles, inputContracts);
  inputFiles[0].sql += "-- outside edit\n";
  inputContracts.migrations[0].objects[0].definition.type = "outside edit";
  assert.equal(context.files[0].sql, files[0].sql);
  assert.deepEqual(context.contracts, contracts);
  assert.throws(() => { context.files[0].sql += "-- forbidden\n"; }, TypeError);
  assert.throws(() => { context.contracts.ledger.objects.push({}); }, TypeError);
  await assert.rejects(prepareMigrationContext(inputFiles, contracts), /migration-context-mismatch/);
  await assert.rejects(prepareMigrationContext(files, inputContracts), /catalog-contract-fingerprint-mismatch/);
  await assert.rejects(prepareMigrationContext(files, { ...contracts, migrations: contracts.migrations.slice(0, 1) }), /migration-context-mismatch/);
  await assert.rejects(computeMigrationPlan({ query: () => assert.fail("Forged context must be refused before DB access.") },
    { context: { files, contracts } }), /prepared-migration-context-required/);
});

test("fingerprints bind facts while remaining independent of object key order and their own stored value", () => {
  const facts = { source: { checksum: "first" }, operations: [{ action: "adopt", version: 1 }],
    observed: { catalogFingerprint: "schema", history: [{ applied_at: "2026-10-06T00:00:00.000Z" }] }, target: { identityFingerprint: "target" } };
  const digest = planFingerprint(facts);
  assert.equal(digest, planFingerprint({ target: facts.target, observed: facts.observed,
    operations: facts.operations, source: facts.source, planFingerprint: "ignored" }));
  for (const changed of [
    { ...facts, source: { checksum: "changed" } }, { ...facts, target: { identityFingerprint: "changed" } },
    { ...facts, operations: [{ action: "execute", version: 1 }] },
    { ...facts, observed: { ...facts.observed, catalogFingerprint: "changed" } },
    { ...facts, observed: { ...facts.observed, history: [{ applied_at: "later" }] } },
  ]) assert.notEqual(planFingerprint(changed), digest);
});

test("plan requires private output, explicit matching target and read-only command options", () => {
  const args = [...argsFor("plan"), "--output", "/private/tmp/owner-plan.json"];
  const parsed = parseMigrationCommand(args, { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL });
  assert.equal(parsed.command, "plan");
  assert.equal(parsed.output, "/private/tmp/owner-plan.json");
  for (const invalid of [argsFor("plan"), args.concat("--approved-plan-fingerprint", "a".repeat(64)),
    argsFor("status").concat("--output", "/private/tmp/owner-plan.json"), args.concat("--unknown"),
    args.map((value) => value === "dfs_ev_test" ? "another" : value)]) {
    assert.throws(() => parseMigrationCommand(invalid, { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }));
  }
  assert.throws(() => parseMigrationCommand(args, { DATABASE_URL: LOCAL_TEST_DATABASE_URL }));
  const result = spawnSync(process.execPath, ["scripts/db-migrate.mjs", ...argsFor("plan"), "--output", "db/owner-plan.json"],
    { encoding: "utf8", env: { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "db-migrate: output-must-be-outside-repository\n");
});

test("up cannot bypass fingerprint approval, scratch registration or pending owner evidence", () => {
  for (const approval of [undefined, "short", "A".repeat(64)]) {
    assert.throws(() => parseMigrationCommand(["up", ...(approval ? ["--approved-plan-fingerprint", approval] : [])], {}), /approved-plan-fingerprint-required/);
  }
  for (const [environment, code] of [["test", "scratch-up-only"], ["preview", "owner-rollout-evidence-pending"], ["production", "owner-rollout-evidence-pending"]]) {
    const result = spawnSync(process.execPath, ["scripts/db-migrate.mjs", "up", "--environment", environment,
      "--approved-plan-fingerprint", "a".repeat(64)], { encoding: "utf8", env: { MIGRATION_DATABASE_URL: "synthetic-private-url" } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "db-migrate: " + code + "\n");
  }
});
