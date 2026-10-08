import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, buildSchemaReference, checkMigrationArtifacts,
  manifestPath, migrationDirectory, readMigrationFiles, schemaPath, validateManifest } from "./db-migrations/files.mjs";
import { MigrationError, refuse } from "./db-migrations/errors.mjs";

export async function generateMigrationArtifacts({ directory = migrationDirectory,
  manifestFile = manifestPath, referenceFile = schemaPath } = {}) {
  const files = await readMigrationFiles(directory);
  let prior;
  try { prior = JSON.parse(await readFile(manifestFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") refuse("invalid-migration-manifest"); }
  if (prior) {
    // Generation can append migrations, but cannot bless edits to known files.
    if (!Array.isArray(prior.migrations) || prior.migrations.length > files.length) refuse("migration-history-rewrite-refused");
    validateManifest(prior, files.slice(0, prior.migrations.length));
  }
  await writeFile(manifestFile, JSON.stringify(buildManifest(files), null, 2) + "\n");
  await writeFile(referenceFile, buildSchemaReference(files));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    if (extra.length || !["check", "generate"].includes(mode)) refuse("invalid-artifact-command");
    if (mode === "generate") await generateMigrationArtifacts();
    else await checkMigrationArtifacts();
    process.stdout.write("Migration artifacts " + (mode === "generate" ? "generated" : "verified") + ".\n");
  } catch (error) {
    process.stderr.write("db-migration-artifacts: " + (error instanceof MigrationError ? error.message : "artifact-check-failed") + "\n");
    process.exitCode = 1;
  }
}
