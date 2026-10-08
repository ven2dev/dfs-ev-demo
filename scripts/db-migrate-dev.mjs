import { checkMigrationArtifacts } from "./db-migrations/files.mjs";
import { loadCatalogContracts } from "./db-migrations/contracts.mjs";
import { prepareMigrationContext, readMigrationPlan, runApprovedScratchMigrations } from "./db-migrations/plans.mjs";
import { MigrationError } from "./db-migrations/errors.mjs";
import { createScratchHarness } from "../tests/db/scratch.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Unexpected arguments.");
  const files = await checkMigrationArtifacts();
  const context = await prepareMigrationContext(files, await loadCatalogContracts(files));
  const harness = await createScratchHarness(process.env);
  let result;
  try {
    result = await harness.withDatabase(async (client, expected) => {
      const options = { expected, environment: "test", context, assertTarget: harness.assertTarget };
      const firstPlan = await readMigrationPlan(client, options);
      const first = await runApprovedScratchMigrations(client, { ...options, approvedFingerprint: firstPlan.planFingerprint });
      const repeatPlan = await readMigrationPlan(client, options);
      const repeat = await runApprovedScratchMigrations(client, { ...options, approvedFingerprint: repeatPlan.planFingerprint });
      return { ...first, repeatExecuted: repeat.executed };
    });
  } finally { await harness.close(); }
  process.stdout.write(JSON.stringify({ ...result, scratchRemoved: true }) + "\n");
} catch (error) {
  process.stderr.write("db-migrate-dev: " + (error instanceof MigrationError ? error.message : "scratch-run-failed") + "\n");
  process.exitCode = 1;
}
