import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReadinessManifest, readinessManifestArtifact } from "../../scripts/db-readiness-manifest.mjs";
import { buildManifest, checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";

test("readiness generation binds the explicit minimum to validated migration and table contracts", async () => {
  const files = await checkMigrationArtifacts();
  const manifest = buildManifest(files);
  const contracts = await loadCatalogContracts(files);
  const current = buildReadinessManifest(manifest, contracts, { minimumVersion: 2 });
  assert.equal(current.requiredTables.length, 17);
  assert.equal(current.maximumKnownVersion, 2);
  assert.deepEqual(current.migrations, manifest.migrations);
  const baseline = buildReadinessManifest(manifest, contracts, { minimumVersion: 1 });
  assert.equal(baseline.requiredTables.length, 8);
  for (const minimumVersion of [undefined, 0, -1, 3, "2", 1.5]) {
    assert.throws(() => buildReadinessManifest(manifest, contracts, { minimumVersion }));
  }
  assert.throws(() => buildReadinessManifest(manifest, contracts, { minimumVersion: 2, extra: true }));
});

test("readiness artifact checks reject missing or stale runtime manifests without rewriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-readiness-"));
  const outputPath = join(directory, "manifest.ts");
  try {
    await assert.rejects(readinessManifestArtifact("check", { outputPath }));
    await readinessManifestArtifact("generate", { outputPath });
    await readinessManifestArtifact("check", { outputPath });
    const good = await readFile(outputPath, "utf8");
    for (const bad of [good.replace('"minimumVersion": 2', '"minimumVersion": 1'),
      good.replace('"maximumKnownVersion": 2', '"maximumKnownVersion": 3'), good + "// drift\n"]) {
      await writeFile(outputPath, bad);
      await assert.rejects(readinessManifestArtifact("check", { outputPath }), /readiness-manifest-drift/);
      assert.equal(await readFile(outputPath, "utf8"), bad);
    }
    await assert.rejects(readinessManifestArtifact("unsupported", { outputPath }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
