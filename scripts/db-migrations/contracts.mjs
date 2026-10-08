import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, collectCatalog, fingerprint } from "../db-catalog.mjs";
import { compareCatalogs, validateSnapshot } from "../compare-db-catalog.mjs";
import { ledgerSql } from "./core.mjs";
import { RUNNER_VERSION } from "./files.mjs";
import { MigrationError, refuse } from "./errors.mjs";

export const contractDirectory = fileURLToPath(new URL("../../db/catalog-contracts/", import.meta.url));
export const contractFilename = (version) => String(version).padStart(4, "0") + ".json";
export const contractText = (contract) => JSON.stringify(JSON.parse(canonicalJson(contract)), null, 2) + "\n";

export async function contractSources(files) {
  const catalogSqlSha256 = fingerprint(await readFile(new URL("../../db/catalog.sql", import.meta.url)));
  return {
    ledger: { catalogSqlSha256, ledgerSqlSha256: fingerprint(ledgerSql), runnerVersion: RUNNER_VERSION },
    migrations: files.map((file, index) => ({ catalogSqlSha256,
      migrations: files.slice(0, index + 1).map(({ version, filename, sha256 }) => ({ version, filename, sha256 })),
    })),
  };
}

export function buildCatalogContract(snapshot, source) {
  validateSnapshot(snapshot);
  if (snapshot.objects.some((object) => object.kind === "unsupported" ||
      (object.kind === "routine" && object.definition.kind === "a"))) refuse("unsupported-catalog-object");
  const catalog = { postgresMajor: snapshot.postgresMajor, schema: snapshot.schema, objects: snapshot.objects };
  return { contractVersion: 1, formatVersion: 1, ...catalog,
    catalogFingerprint: fingerprint(canonicalJson(catalog)), source };
}

export function validateCatalogContract(contract, source) {
  try { validateSnapshot(contract); } catch { refuse("invalid-catalog-contract"); }
  if (contract.contractVersion !== 1 || contract.postgresMajor !== 18 ||
      Object.keys(contract).sort().join(",") !== "catalogFingerprint,contractVersion,formatVersion,objects,postgresMajor,schema,source") {
    refuse("invalid-catalog-contract");
  }
  if (canonicalJson(contract.source) !== canonicalJson(source)) refuse("catalog-contract-source-mismatch");
  if (contract.catalogFingerprint !== buildCatalogContract(contract, source).catalogFingerprint) {
    refuse("catalog-contract-fingerprint-mismatch");
  }
}

// Load and bind reviewed contracts before connecting or starting a transaction.
// No fingerprint is silently updated at runtime.
export async function loadCatalogContracts(files, directory = contractDirectory) {
  const names = ["ledger.json", ...files.map((file) => contractFilename(file.version))].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  if (canonicalJson(entries.map((entry) => entry.name).sort()) !== canonicalJson(names) ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) refuse("catalog-contract-files-mismatch");
  const sources = await contractSources(files);
  async function load(name, source) {
    let contract;
    try { contract = JSON.parse(await readFile(join(directory, name), "utf8")); }
    catch { refuse("invalid-catalog-contract"); }
    validateCatalogContract(contract, source);
    return contract;
  }
  const ledger = await load("ledger.json", sources.ledger);
  const migrations = [];
  for (const [index, file] of files.entries()) {
    migrations.push(await load(contractFilename(file.version), sources.migrations[index]));
  }
  return { ledger, migrations };
}

export async function compareCandidateCatalog(client, contracts, version, { includeLedger = true } = {}) {
  const contract = contracts.migrations[version - 1];
  if (!contract || !Number.isInteger(version) || version < 1) refuse("unknown-candidate-schema-version");
  // Include the ledger's exact objects. Prefix/name filtering could hide drift
  // or an unexpected object whose name happens to resemble the ledger.
  const expected = { ...contract, objects: includeLedger
    ? [...contract.objects, ...contracts.ledger.objects] : contract.objects };
  return compareCatalogs(expected, await collectCatalog(client));
}

export function createCatalogVerifier(contracts) {
  return async (client, version) => {
    const differences = await compareCandidateCatalog(client, contracts, version);
    if (differences.length) {
      const error = new MigrationError("candidate-catalog-mismatch");
      // Keep the complete report available to local proofs and future planning.
      // Operational CLIs print only the fixed code, never private definitions.
      error.differences = differences;
      throw error;
    }
  };
}
