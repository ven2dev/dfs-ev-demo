import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { databaseAssets } from "@dfs-ev/db/assets";
import { getTemplateReference } from "@dfs-ev/db-tooling/test-support/templates";
import { parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";
import { featureStoreProposals } from "../../scripts/feature-store/fixture-proposals.ts";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";

const readFixtureCatalog = async (admin: Client) => {
  const catalogSql = await readFile(databaseAssets.catalog, "utf8");
  const publicObjects = (await admin.query(catalogSql)).rows;
  const featureObjects = (await admin.query(catalogSql.replaceAll("n.nspname = 'public'", "n.nspname = 'fs138'"))).rows;
  const privileges = (await admin.query(`
    SELECT 'schema' AS kind, nspname AS name, nspacl::text AS acl
      FROM pg_namespace WHERE nspname IN ('public','fs138')
    UNION ALL
    SELECT 'relation', n.nspname || '.' || c.relname, c.relacl::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','fs138')
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public','fs138') AND a.attacl IS NOT NULL
    UNION ALL
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.proacl::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','fs138')
    UNION ALL
    SELECT 'default', coalesce(n.nspname, '') || ':' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text, d.defaclacl::text
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname IN ('public','fs138') OR d.defaclnamespace = 0
    ORDER BY kind, name`)).rows;
  assert.ok(featureObjects.some(({ kind }) => kind === "trigger"));
  assert.ok(featureObjects.some(({ kind }) => kind === "routine"));
  assert.ok(privileges.some(({ acl }) => acl?.includes("fs138_pipeline_writer")));
  return { publicObjects, featureObjects, privileges };
};

test("the feature-store template matches the fresh catalog and refuses stale or changed inputs", async () => {
  const manifest = process.env.TEST_DATABASE_TEMPLATE_MANIFEST;
  assert.ok(manifest, "Run this proof through the guarded feature-store template runner.");
  const timing = process.env.FEATURE_STORE_DB_TIMING;
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-feature-template-proof-"));
  // This probe runs in its own Node test process. Keep the comparison's one
  // intentional fresh migration out of the shared harness timings.
  delete process.env.FEATURE_STORE_DB_TIMING;
  try {
    const reference = await getTemplateReference(process.env, undefined, featureStoreProposals);
    const source = new Client({ ...parseTestDatabaseUrl(process.env.TEST_DATABASE_URL), database: reference.database });
    try { await assert.rejects(source.connect(), /not currently accepting connections/); }
    finally { await source.end(); }
    const changed = join(directory, "241_job_visibility.sql");
    await writeFile(changed, Buffer.concat([
      await readFile(featureStoreProposals[3]), Buffer.from("\n-- changed template input\n"),
    ]), { flag: "wx", mode: 0o600 });
    const changedChain = [...featureStoreProposals.slice(0, -1), pathToFileURL(changed)];
    await assert.rejects(getTemplateReference(process.env, undefined, changedChain), /stale or unsafe/);
    await assert.rejects(getTemplateReference(process.env, undefined, [...featureStoreProposals].reverse()), /stale or unsafe/);
    await assert.rejects(getTemplateReference(process.env), /stale or unsafe/);

    const cloned = await withFeatureStoreDatabase(async ({ admin }) => {
      assert.notEqual(admin.database, reference.database);
      return readFixtureCatalog(admin);
    });
    delete process.env.TEST_DATABASE_TEMPLATE_MANIFEST;
    const fresh = await withFeatureStoreDatabase(async ({ admin }) => readFixtureCatalog(admin));
    assert.deepEqual(cloned, fresh);
  } finally {
    process.env.TEST_DATABASE_TEMPLATE_MANIFEST = manifest;
    if (timing !== undefined) process.env.FEATURE_STORE_DB_TIMING = timing;
    await rm(directory, { recursive: true, force: true });
  }
});
