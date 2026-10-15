import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { createScratchHarness } from "./scratch.mjs";

// Opt-in diagnosis only. A passing probe does not certify serialized queries;
// the strict no-overlap regression belongs with the executor repair.
it("traces overlapping query submissions for distinct training features", async () => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-query-trace-")));
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(client);
      await runScratchMigrations(client, { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const store = await createLocalPredictiveStore(client, { expected, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(store, client, artifacts, 4, { guardedRecording: true });
      const clock = (await client.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t;
      const request = runRequest(seed, 4, clock);
      const inventory = await store.prepareFittingRun(request);
      const manifest = await store.prepareDataset({ version: "qb-training-read-v1", fittingRunId: request.fittingRunId,
        inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "query-trace-pin" });
      expect(manifest.rows).toHaveLength(4);
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
