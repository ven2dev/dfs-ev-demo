import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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

it("QB distinct feature verification serializes direct and batched SQL and drains failed branches before rollback", async () => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-query-queue-")));
  try {
    await harness.withDatabase(async (admin: Client, expected: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(admin);
      await runScratchMigrations(admin, { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(admin);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const producer = await createLocalPredictiveStore(admin, { expected, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(producer, admin, artifacts, 4, { guardedRecording: true });
      const clock = (await admin.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t;
      const request = runRequest(seed, 4, clock), inventory = await producer.prepareFittingRun(request);
      const login = "dfs118_queue_" + randomBytes(8).toString("hex");
      await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER PASSWORD 'disposable-query-queue'`);
      await admin.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
      const config = { ...expected, user: login, password: "disposable-query-queue" }, client = new Client(config);
      let active = 0, overlaps = 0, injected = false, injectFailure = true, rightsChecks = 0;
      const events: string[] = [];
      const strict = new Proxy(client, { get: (object, key) => {
        if (key === "query") return async (...args: unknown[]) => {
          if (active) { overlaps++; throw new Error("overlapping-query-submission"); }
          active++;
          const sql = String(args[0]);
          events.push(sql);
          try {
            // A real failed statement aborts the transaction while sibling
            // verification branches still have queued current-access work.
            if (sql.includes("WITH clock AS MATERIALIZED")) rightsChecks++;
            if (injectFailure && !injected && rightsChecks >= 3) {
              injected = true; await object.query("SELECT 1/0");
            }
            return await Reflect.apply(object.query, object, args);
          } finally { active--; }
        };
        const value = Reflect.get(object, key);
        return typeof value === "function" ? value.bind(object) : value;
      } });
      try {
        await client.connect();
        expect((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
        const store = await createLocalPredictiveStore(strict, { expected: config, assertTarget: (value) => {
          expect(value).toEqual(config); harness.assertTarget(expected);
        } }, artifacts);
        const dataset = { version: "qb-training-read-v1" as const, fittingRunId: request.fittingRunId,
          inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "query-queue-pin" };
        await expect(store.prepareDataset(dataset)).rejects.toMatchObject({ code: "22012" });
        expect(injected).toBe(true);
        expect(events.at(-1)).toBe("ROLLBACK");
        expect(active).toBe(0); expect(overlaps).toBe(0);
        expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_training_datasets")).rows[0].n).toBe(0);
        events.length = 0; injectFailure = false;
        const saved = await store.prepareDataset(dataset);
        expect(saved.rows).toHaveLength(4);
        const page = await store.readDatasetPage({ version: dataset.version, fittingRunId: dataset.fittingRunId,
          inventorySha256: dataset.inventorySha256, datasetId: dataset.datasetId,
          manifestSha256: saved.manifestSha256, cursor: null, limits: { rows: 4, bytes: 8_000_000 } });
        expect(page.rows.map((row) => row.feature.bundle?.player[0].passingYardsSum)).toEqual(seed.examples.map((row) => row.passingYards));
        expect(page.rows.every((row) => row.label.state === "missing")).toBe(true);
        expect(events.at(-1)).toBe("COMMIT");
        expect(active).toBe(0); expect(overlaps).toBe(0);
      } finally {
        await client.end();
        await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`);
      }
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
