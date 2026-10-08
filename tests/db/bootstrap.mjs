import { canonicalJson } from "../../scripts/db-catalog.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { prepareMigrationContext } from "../../scripts/db-migrations/plans.mjs";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

// #45 alone bootstraps the fixed primary disposable database. Migration proofs
// retain their separate registered random targets; this never drops public or
// adopts an existing unversioned schema.
export async function bootstrapPrimaryTestDatabase(client, environment) {
  assertNoApplicationCredentials(environment);
  const expected = Object.freeze(parseTestDatabaseUrl(environment.TEST_DATABASE_URL));
  const files = await checkMigrationArtifacts();
  const context = await prepareMigrationContext(files, await loadCatalogContracts(files));
  const options = { expected, files: context.files, verify: createCatalogVerifier(context.contracts),
    assertTarget(config) {
      if (canonicalJson(config) !== canonicalJson(expected)) throw new Error("Primary test target refused.");
    } };
  const first = await runScratchMigrations(client, options);
  const repeat = await runScratchMigrations(client, options);
  return { first, repeat };
}
