import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CatalogError, parseCatalogOptions } from "./db-catalog.mjs";
import { checkMigrationArtifacts } from "./db-migrations/files.mjs";
import { readMigrationStatus } from "./db-migrations/core.mjs";
import { MigrationError, refuse } from "./db-migrations/errors.mjs";

export function parseMigrationCommand(args, environment) {
  const [command, ...options] = args;
  if (command === "up") refuse("approved-plan-support-pending");
  if (command !== "status") refuse("forward-only-status-command-required");
  let values;
  try {
    ({ values } = parseArgs({ args: options, options: {
      environment: { type: "string" }, "expected-host-fingerprint": { type: "string" },
      "expected-database": { type: "string" },
    } }));
  } catch { refuse("invalid-migration-options"); }
  const target = parseCatalogOptions(["--environment", values.environment ?? "", "--identity"], environment);
  if (values["expected-host-fingerprint"] !== target.identity.hostFingerprint ||
      values["expected-database"] !== target.config.database) refuse("expected-target-mismatch");
  return target;
}

export async function runMigrationCommand(args, environment) {
  const options = parseMigrationCommand(args, environment);
  const files = await checkMigrationArtifacts();
  const { Client } = options.identity.declaredEnvironment === "test"
    ? await import("pg") : await import("@neondatabase/serverless");
  const client = new Client(options.config);
  try {
    await client.connect();
    const status = await readMigrationStatus(client, options.config, files);
    process.stdout.write(JSON.stringify({ ...status, target: options.identity }) + "\n");
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runMigrationCommand(process.argv.slice(2), process.env); }
  catch (error) {
    process.stderr.write("db-migrate: " + (error instanceof MigrationError || error instanceof CatalogError ? error.message : "status-failed") + "\n");
    process.exitCode = 1;
  }
}
