import { checkMigrationArtifacts } from "./db-migrations/files.mjs";
import { runScratchMigrations } from "./db-migrations/core.mjs";
import { verifyCandidateTables } from "./db-migrations/candidates.mjs";
import { MigrationError } from "./db-migrations/errors.mjs";
import { createScratchHarness } from "../tests/db/scratch.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Unexpected arguments.");
  const files = await checkMigrationArtifacts();
  const harness = await createScratchHarness(process.env);
  let result;
  try {
    result = await harness.withDatabase(async (client, expected) => {
      const options = { expected, files, assertTarget: harness.assertTarget, verify: verifyCandidateTables };
      const first = await runScratchMigrations(client, options);
      const repeat = await runScratchMigrations(client, options);
      return { ...first, repeatExecuted: repeat.executed };
    });
  } finally { await harness.close(); }
  process.stdout.write(JSON.stringify({ ...result, scratchRemoved: true }) + "\n");
} catch (error) {
  process.stderr.write("db-migrate-dev: " + (error instanceof MigrationError ? error.message : "scratch-run-failed") + "\n");
  process.exitCode = 1;
}
