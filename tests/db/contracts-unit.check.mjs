import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../../scripts/db-catalog.mjs";
import { checkCatalogContractArtifacts } from "../../scripts/db-catalog-contracts.mjs";
import { buildCatalogContract, contractDirectory, contractSources, contractText,
  loadCatalogContracts, validateCatalogContract } from "../../scripts/db-migrations/contracts.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";

const files = await checkMigrationArtifacts();
const sources = await contractSources(files);
const contracts = await loadCatalogContracts(files);

test("contracts bind every immutable prefix, ledger DDL and inventory query and omit environment metadata", () => {
  assert.equal(contracts.migrations.length, files.length);
  assert.equal(contracts.migrations[0].source.migrations.length, 1);
  assert.equal(contracts.migrations[1].source.migrations.length, 2);
  assert.equal(contracts.migrations.at(-1).source.migrations.length, files.length);
  for (const [contract, source] of [[contracts.ledger, sources.ledger],
    ...contracts.migrations.map((contract, index) => [contract, sources.migrations[index]])]) {
    assert.doesNotThrow(() => validateCatalogContract(contract, source));
    assert.deepEqual(buildCatalogContract({ ...contract, serverVersionNum: 180999,
      target: { hostFingerprint: "synthetic" }, capturedAt: "later" }, source), contract);
    assert.throws(() => validateCatalogContract({ ...contract, postgresMajor: 19 }, source), /invalid-catalog-contract/);
    assert.throws(() => validateCatalogContract({ ...contract, contractVersion: 2 }, source));
    assert.throws(() => validateCatalogContract({ ...contract, ignored: true }, source));
    assert.throws(() => validateCatalogContract(contract, { ...source, catalogSqlSha256: "0".repeat(64) }), /source-mismatch/);
    const edited = structuredClone(contract);
    edited.objects[0].definition.type = "unexpected";
    assert.throws(() => validateCatalogContract(edited, source), /fingerprint-mismatch/);
    assert.throws(() => validateCatalogContract({ ...contract, objects: [...contract.objects, contract.objects[0]] }, source), /invalid-catalog-contract/);
  }
});

test("contract drift check reports all changed, missing and unexpected artifacts without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-contract-drift-"));
  try {
    const artifacts = new Map([...contracts.migrations.map((contract, index) => [String(index + 1).padStart(4, "0") + ".json", contractText(contract)]), ["ledger.json", contractText(contracts.ledger)]]);
    await writeFile(join(directory, "0001.json"), "edited\n");
    await writeFile(join(directory, "unexpected.json"), "unexpected\n");
    await symlink(join(contractDirectory, "ledger.json"), join(directory, "ledger.json"));
    assert.deepEqual(await checkCatalogContractArtifacts(artifacts, directory), [
      "Changed contract artifact: 0001.json", ...files.slice(1).map((file) => "Missing contract artifact: " + String(file.version).padStart(4, "0") + ".json"),
      "Unexpected contract artifact: ledger.json", "Unexpected contract artifact: unexpected.json",
    ]);
    assert.equal(await readFile(join(directory, "0001.json"), "utf8"), "edited\n");
    await assert.rejects(loadCatalogContracts(files, directory), /files-mismatch/);
    await rm(join(directory, "ledger.json"));
    await rm(join(directory, "unexpected.json"));
    for (const [name, text] of artifacts) await writeFile(join(directory, name), text);
    assert.deepEqual(await loadCatalogContracts(files, directory), contracts);
    assert.deepEqual(await checkCatalogContractArtifacts(artifacts, directory), []);
    const stale = structuredClone(contracts.migrations[1]);
    stale.source.migrations[0].sha256 = "0".repeat(64);
    await writeFile(join(directory, "0002.json"), canonicalJson(stale));
    await assert.rejects(loadCatalogContracts(files, directory), /source-mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("contract CLI refuses missing or remote targets and unsupported options without connecting or leaking values", () => {
  for (const [args, env] of [
    [["generate"], {}], [["check"], { DATABASE_URL: "synthetic-private-url" }],
    [["generate"], { MIGRATION_DATABASE_URL: "synthetic-private-url" }],
    [["check", "--environment", "production"], { MIGRATION_DATABASE_URL: "synthetic-private-url" }],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/db-catalog-contracts.mjs", ...args], { encoding: "utf8", env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^db-catalog-contracts: (contract-command-failed|invalid-contract-command)\n$/);
    assert.ok(!result.stderr.includes("synthetic-private-url"));
  }
});

test("regeneration refuses catalog classes that lack complete definition coverage", () => {
  for (const object of [
    { kind: "unsupported", name: "type.synthetic_range", definition: { kind: "r" } },
    { kind: "routine", name: "synthetic_aggregate()", definition: { kind: "a", definition: null } },
  ]) assert.throws(() => buildCatalogContract({ ...contracts.migrations[0], objects: [object] }, sources.migrations[0]), /unsupported-catalog-object/);
});
