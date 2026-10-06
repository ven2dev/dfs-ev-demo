import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, collectCatalog } from "./db-catalog.mjs";
import { checkConnectedTarget, ledgerSql } from "./db-migrations/core.mjs";
import { buildCatalogContract, contractDirectory, contractFilename, contractSources, contractText } from "./db-migrations/contracts.mjs";
import { checkMigrationArtifacts } from "./db-migrations/files.mjs";
import { MigrationError, refuse } from "./db-migrations/errors.mjs";
import { createScratchHarness } from "../tests/db/scratch.mjs";

// Bootstrap directly from reviewed SQL, independent of the verifier it builds.
// Every prefix has its own registered scratch database; the shared DB is never
// modified, and all scratch DBs are removed before artifacts are written.
export async function buildCatalogContracts(harness, files) {
  const sources = await contractSources(files);
  const artifacts = new Map();
  async function capture(statements, source) {
    return harness.withDatabase(async (client, expected) => {
      harness.assertTarget(expected);
      await checkConnectedTarget(client, expected);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
        await client.query("SET LOCAL standard_conforming_strings = on");
        await client.query("SET LOCAL search_path = public");
        for (const sql of statements) await client.query(sql);
        const contract = buildCatalogContract(await collectCatalog(client, expected), source);
        await client.query("ROLLBACK");
        return contractText(contract);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
  artifacts.set("ledger.json", await capture([ledgerSql], sources.ledger));
  for (const [index, file] of files.entries()) {
    artifacts.set(contractFilename(file.version), await capture(files.slice(0, index + 1).map((file) => file.sql), sources.migrations[index]));
  }
  return artifacts;
}

export async function checkCatalogContractArtifacts(artifacts, directory = contractDirectory) {
  const differences = [];
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const entry of entries) {
    if (!artifacts.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) differences.push("Unexpected contract artifact: " + entry.name);
  }
  for (const [name, expected] of artifacts) {
    const entry = entries.find((entry) => entry.name === name);
    if (!entry) { differences.push("Missing contract artifact: " + name); continue; }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (await readFile(join(directory, name), "utf8") !== expected) differences.push("Changed contract artifact: " + name);
  }
  return differences.sort();
}

export async function runCatalogContractCommand(args, environment) {
  const [mode, ...extra] = args;
  if (extra.length || !["check", "generate"].includes(mode)) refuse("invalid-contract-command");
  const files = await checkMigrationArtifacts();
  const harness = await createScratchHarness(environment);
  let artifacts;
  try { artifacts = await buildCatalogContracts(harness, files); }
  finally { await harness.close(); }
  if (mode === "check") {
    const differences = await checkCatalogContractArtifacts(artifacts);
    if (differences.length) {
      process.stdout.write(differences.join("\n") + "\n");
      refuse("catalog-contract-drift");
    }
  } else {
    // Refuse extras/symlinks rather than following them or deleting history.
    const differences = await checkCatalogContractArtifacts(artifacts);
    if (differences.some((difference) => difference.startsWith("Unexpected"))) refuse("catalog-contract-files-mismatch");
    await mkdir(contractDirectory, { recursive: true });
    for (const [name, value] of artifacts) await writeFile(join(contractDirectory, name), value);
  }
  process.stdout.write(canonicalJson({ contracts: artifacts.size, postgresMajor: 18,
    result: mode === "check" ? "verified" : "generated", scratchRemoved: true }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCatalogContractCommand(process.argv.slice(2), process.env); }
  catch (error) {
    process.stderr.write("db-catalog-contracts: " + (error instanceof MigrationError ? error.message : "contract-command-failed") + "\n");
    process.exitCode = 1;
  }
}
