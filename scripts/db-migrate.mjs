import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CatalogError, parseCatalogOptions, validateOutputPath } from "./db-catalog.mjs";
import { checkMigrationArtifacts } from "./db-migrations/files.mjs";
import { readMigrationStatus } from "./db-migrations/core.mjs";
import { loadCatalogContracts } from "./db-migrations/contracts.mjs";
import { prepareMigrationContext, readMigrationPlan } from "./db-migrations/plans.mjs";
import { MigrationError, refuse } from "./db-migrations/errors.mjs";

export function parseMigrationCommand(args, environment) {
  const [command, ...options] = args;
  if (!["status", "plan", "up"].includes(command)) refuse("forward-only-migration-command-required");
  let values;
  try {
    ({ values } = parseArgs({ args: options, options: {
      environment: { type: "string" }, "expected-host-fingerprint": { type: "string" },
      "expected-database": { type: "string" },
      output: { type: "string" }, "approved-plan-fingerprint": { type: "string" },
    } }));
  } catch { refuse("invalid-migration-options"); }
  if (command === "up") {
    if (!/^[0-9a-f]{64}$/.test(values["approved-plan-fingerprint"] ?? "")) refuse("approved-plan-fingerprint-required");
    // No remote mutation entry point before the owner supplies the outstanding
    // catalog disposition, transport and recovery evidence. Local up proofs
    // call the shared approved-plan engine on registered scratch databases.
    refuse(values.environment === "test" ? "scratch-up-only" : "owner-rollout-evidence-pending");
  }
  if (values["approved-plan-fingerprint"] !== undefined ||
      (command === "status" && values.output !== undefined)) refuse("invalid-migration-options");
  if (command === "plan" && !values.output) refuse("plan-output-required");
  const target = parseCatalogOptions(["--environment", values.environment ?? "", "--identity"], environment);
  if (values["expected-host-fingerprint"] !== target.identity.hostFingerprint ||
      values["expected-database"] !== target.config.database) refuse("expected-target-mismatch");
  return { ...target, command, output: values.output };
}

export async function runMigrationCommand(args, environment) {
  const options = parseMigrationCommand(args, environment);
  const output = options.command === "plan" ? await validateOutputPath(options.output) : null;
  const files = await checkMigrationArtifacts();
  const context = options.command === "plan" ? await prepareMigrationContext(files, await loadCatalogContracts(files)) : null;
  const { Client } = options.identity.declaredEnvironment === "test"
    ? await import("pg") : await import("@neondatabase/serverless");
  const client = new Client(options.config);
  try {
    await client.connect();
    if (options.command === "status") {
      const status = await readMigrationStatus(client, options.config, files);
      process.stdout.write(JSON.stringify({ ...status, target: options.identity }) + "\n");
      return 0;
    }
    const plan = await readMigrationPlan(client, { expected: options.config,
      environment: options.identity.declaredEnvironment, context });
    await writeFile(output, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // Private SQL definitions/differences stay in the owner-selected artifact.
    process.stdout.write(JSON.stringify({ planFingerprint: plan.planFingerprint, executable: plan.executable,
      refusalCode: plan.refusalCode, schemaVersion: plan.observed.schemaVersion, targetVersion: plan.targetVersion,
      operations: plan.operations, mismatchCount: plan.verification.reduce((sum, report) => sum + report.differences.length, 0),
      target: plan.target }) + "\n");
    return plan.executable ? 0 : 1;
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runMigrationCommand(process.argv.slice(2), process.env); }
  catch (error) {
    process.stderr.write("db-migrate: " + (error instanceof MigrationError || error instanceof CatalogError ? error.message : "command-failed") + "\n");
    process.exitCode = 1;
  }
}
