import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { measure } from "./trainingCapacityComparison.ts";
import { createScratchHarness } from "./scratch.mjs";

// Isolate one SQL optimization with identical current application/queue code.
// It is a diagnostic comparison, not the final combined foundation gate.
it("compares witness population reuse on identical snapshots with unchanged API deadlines", async () => {
  const size = Number(process.env.PREDICTIVE_CAPACITY_MAX_ROWS ?? 64);
  if (![4, 64].includes(size)) throw new Error("witness-capacity-size-refused");
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-witness-capacity-")));
  const measurements: Parameters<typeof measure>[6] = [];
  const order = ["baseline", "drafts", "drafts", "baseline"] as const;
  try {
    await harness.withDatabase(async (source: Client, template: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(source);
      await runScratchMigrations(source, { expected: template, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(source);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const producer = await createLocalPredictiveStore(source, { expected: template, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(producer, source, artifacts, size, { guardedRecording: true });
      const clock = (await source.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t as string;
      const widths = size === 4 ? [4] : [1, 16];
      const inventories = new Map();
      for (const rows of widths) inventories.set(rows, await producer.prepareFittingRun(runRequest(seed, rows, clock)));
      const sourceHashes: Record<string, string> = {};
      for (const path of ["src/lib/predictive/persistence.ts", "src/lib/predictive/queryQueue.ts", "src/lib/predictive/batchEvidence.ts",
        "tests/db/trainingWitnessCapacity.bench.ts", "tests/db/trainingCapacityComparison.ts", "tests/db/trainingCapacityFixtures.ts"])
        sourceHashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
      const path = "db/proposals/training_witness_population.sql", sql = await readFile(path, "utf8");
      const postgres = (await source.query("SHOW server_version")).rows[0].server_version;
      await source.end();
      const expectedRows = new Map<number, unknown>();
      for (const [trial, mode] of order.entries()) await harness.withDatabase(async (admin: Client, expected: object) => {
        if (mode === "drafts") await admin.query(sql);
        await admin.query("ANALYZE");
        // Equal lock/function warm-up. API memo state is transaction-local and
        // therefore empty on every fresh restricted API connection below.
        await admin.query("BEGIN"); await admin.query("SELECT predictive_training_read_guard()"); await admin.query("ROLLBACK");
        for (const rows of widths) {
          const inventory = inventories.get(rows), request = inventory.request;
          const target = { expected, assertTarget: harness.assertTarget }, header = { trial, mode, rows };
          const read = await measure(admin, target, artifacts, createLocalPredictiveStore, { ...header, operation: "read-run" },
            (store) => store.readFittingRun(request.fittingRunId), measurements);
          if (read) {
            expect(read.inventorySha256).toBe(inventory.inventorySha256);
            expect(read.rows).toEqual(inventory.rows);
          }
          const manifest = await measure(admin, target, artifacts, createLocalPredictiveStore, { ...header, operation: "prepare-dataset" },
            (store) => store.prepareDataset({ version: request.version, fittingRunId: request.fittingRunId,
              inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "witness-capacity-pin-" + rows }), measurements);
          if (!manifest) continue;
          expect(manifest.rows).toHaveLength(rows);
          const page = await measure(admin, target, artifacts, createLocalPredictiveStore, { ...header, operation: "read-page" },
            (store) => store.readDatasetPage({ version: request.version, fittingRunId: request.fittingRunId,
              inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId,
              manifestSha256: manifest.manifestSha256, cursor: null, limits: { rows, bytes: 8_000_000 } }), measurements);
          if (page) {
            expect(page.rows.map((row) => row.feature.bundle?.player[0].passingYardsSum)).toEqual(seed.examples.slice(0, rows).map((row) => row.passingYards));
            expect(page.rows.every((row) => row.label.state === "missing")).toBe(true);
            if (!expectedRows.has(rows)) expectedRows.set(rows, page.rows);
            expect(page.rows).toEqual(expectedRows.get(rows));
          }
        }
      }, { template });
      process.stdout.write("witness training capacity evidence " + JSON.stringify({ version: "training-witness-capacity-v1",
        measuredAt: new Date().toISOString(), applicationRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        sourceHashes, proposals: [{ path, sha256: createHash("sha256").update(sql).digest("hex") }],
        migrations: files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 })),
        runtime: { node: process.version, postgres, cpu: cpus()[0]?.model }, order,
        scope: { sourcePlayers: size, sourceProfiles: seed.profiles.length, selectedWidths: widths,
          historySlots: 1, opponentContext: false, selectedLabels: "missing", sameSeedSnapshot: true,
          freshRestrictedConnectionsPerApi: true, sameApplicationBothModes: true, nestedInstrumentation: false,
          baseline: "frozen-prefix20-with-serialized-client", drafts: "prefix20-plus-witness-population-only",
          includesReviewDrafts0022to0024: false, fittingRunsPreparedBeforeCloning: true,
          fullCapacityGate: false, comparisonAcceptsDeadlineRefusals: true },
        measurements, candidateTarget: { readMs: 7000, preparationMs: 21000 },
        candidateWithinHeadroom: measurements.filter((row) => row.mode === "drafts").length === widths.length * 3 * 2 &&
          measurements.filter((row) => row.mode === "drafts").every((row) => row.status === "completed" && row.wallMs <=
            (row.operation === "prepare-dataset" ? 21000 : 7000)) }) + "\n");
      expect(measurements.length).toBeGreaterThan(0);
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 900_000);
