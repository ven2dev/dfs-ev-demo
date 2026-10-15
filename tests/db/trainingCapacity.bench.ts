import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore, type PrivateArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { canonical } from "../../src/lib/predictive/validation.ts";
import { TRAINING_SELECTION_SQL, trainingSelectionParameters } from "../../src/lib/predictive/trainingSql.ts";
import type { TrainingRunInventory } from "../../src/lib/predictive/trainingRuns.ts";
import type { TrainingDatasetManifest } from "../../src/lib/predictive/trainingDatasets.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { createScratchHarness } from "./scratch.mjs";
import { compareTrainingCapacity } from "./trainingCapacityComparison.ts";

type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
type Target = { expected: object; assertTarget: (config: object) => void };

type Measurement = { operation: string; count: number; status: "completed" | "refused"; reason: string | null; wallMs: number;
  statements: number; consumerCheckStatements: number; uniqueFiles: number; fileReads: number; wireBytes: number; responseBytes: number;
  sampledPeakRssBytes: number; sampledPeakHeapBytes: number; processHighWaterRssBytes: number; verification: unknown };
const capacityRefusals = new Set(["training-deadline-exceeded", "source-verification-byte-bounds-refused", "training-page-byte-bounds-refused",
  "training-evidence-bounds-refused", "compressed-batch-work-budget-exceeded", "sql-statement-timeout"]);

const measure = async <T>(client: Client, target: Target, artifacts: PrivateArtifactStore, operation: string, count: number,
  work: (store: Store) => Promise<T>, measurements: Measurement[]) => {
  const login = "dfs118_capacity_" + randomBytes(8).toString("hex");
  await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-capacity'`);
  await client.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
  const expected = { ...target.expected, user: login, password: "disposable-capacity" }, connection = new Client(expected);
  const sql: string[] = [], reads: { ref: string; bytes: number }[] = [];
  const observed = new Proxy(connection, { get: (object, key) => {
    if (key === "query") return (...args: unknown[]) => {
      sql.push(typeof args[0] === "string" ? args[0] : "");
      return Reflect.apply(object.query, object, args);
    };
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } });
  const files = { ...artifacts, database: { ...artifacts.database,
    read: async (...args: Parameters<typeof artifacts.database.read>) => {
      reads.push({ ref: args[0], bytes: args[2] }); return artifacts.database.read(...args);
    }, readBinary: async (...args: Parameters<typeof artifacts.database.readBinary>) => {
      reads.push({ ref: args[0], bytes: args[2] }); return artifacts.database.readBinary(...args);
    } } };
  try {
    await connection.connect();
    expect((await connection.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
    const store = await createLocalPredictiveStore(observed, { expected, assertTarget: (config) => {
      expect(config).toEqual(expected); target.assertTarget(target.expected);
    } }, files);
    sql.length = 0;
    let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
    const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
    const timer = setInterval(sample, 10), started = performance.now();
    let result: T | null = null, reason: string | null = null;
    try { result = await work(store); }
    catch (error) {
      reason = error instanceof Error && "code" in error && error.code === "57014" ? "sql-statement-timeout" :
        error instanceof Error ? error.message : "unknown-error";
      if (!capacityRefusals.has(reason)) throw error;
    } finally { sample(); clearInterval(timer); }
    measurements.push({ operation, count, status: reason ? "refused" : "completed", reason,
      wallMs: Math.round(performance.now() - started), statements: sql.length,
      consumerCheckStatements: sql.filter((statement) => statement.includes("predictive_source_consumer_check")).length,
      uniqueFiles: new Set(reads.map(({ ref }) => ref)).size, fileReads: reads.length,
      wireBytes: [...new Map(reads.map((row) => [row.ref, row.bytes])).values()].reduce((a, b) => a + b, 0),
      responseBytes: result === null ? 0 : Buffer.byteLength(canonical(result)), sampledPeakRssBytes: peakRss, sampledPeakHeapBytes: peakHeap,
      processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
      verification: result && typeof result === "object" && "verification" in result ? result.verification : null });
    if (result !== null) {
      expect(new Set(reads.map(({ ref }) => ref)).size).toBe(reads.length);
      expect((await connection.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
    }
    return result;
  } finally { await connection.end(); await client.query(`DROP OWNED BY ${login}`); await client.query(`DROP ROLE ${login}`); }
};

it("measures independent QB training records with default budgets and exact evidence", async () => {
  if (process.env.PREDICTIVE_CAPACITY_INTERLEAVED === "1") { await compareTrainingCapacity(); return; }
  const max = Number(process.env.PREDICTIVE_CAPACITY_MAX_ROWS ?? 64);
  if (![1, 16, 64].includes(max)) throw new Error("capacity-size-refused");
  const reviewDrafts = process.env.PREDICTIVE_CAPACITY_REVIEW_DRAFTS === "1";
  const requireComplete = process.env.PREDICTIVE_CAPACITY_REQUIRE_COMPLETE === "1";
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-capacity-")));
  const measurements: Measurement[] = [], plans: unknown[] = [];
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(client);
      await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(client);
      // Reserved forward DDL is measured separately while #106's 0021 is
      // pending. Never manufacture an ordered prefix or catalog approval.
      const drafts: { file: string; sha256: string }[] = [];
      if (reviewDrafts) for (const name of ["0022_predictive_training_liveness.sql", "0023_predictive_training_indexed_closure.sql",
        "0024_predictive_training_readable_contracts.sql"]) {
        const sql = await readFile(new URL("../../db/proposals/"+name, import.meta.url), "utf8");
        await client.query(sql);
        drafts.push({ file: name, sha256: createHash("sha256").update(sql).digest("hex") });
      }
      const artifacts = await openArtifactStore(root, 8_000_000), store = await createLocalPredictiveStore(client, target, artifacts);
      const seedStarted = performance.now(), seed = await seedCapacity(store, client, artifacts, max, { guardedRecording: true });
      process.stdout.write("capacity seed " + JSON.stringify({ rows: max, wallMs: Math.round(performance.now() - seedStarted) }) + "\n");
      await client.query("SET track_functions='pl'");
      await client.query("ANALYZE");
      const labelsAsOf = (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
      for (const count of [1, 16, 64].filter((n) => n <= max)) {
        const request = runRequest(seed, count, labelsAsOf);
        const explain = async (name: string, sql: string, values: unknown[], guarded = false) => {
          if (guarded) { await client.query("BEGIN"); await client.query("SELECT predictive_training_read_guard()"); }
          try {
            const plan = (await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values)).rows[0]["QUERY PLAN"][0];
            const functions = (await client.query(`SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions
              WHERE calls>0 AND (funcname LIKE 'predictive_source_%' OR funcname LIKE 'predictive_training_%') ORDER BY total_time DESC LIMIT 16`)).rows;
            plans.push({ name, count, plan, functions });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "57014")) throw error;
            plans.push({ name, count, status: "refused", reason: "sql-statement-timeout", statementCeilingMs: 15_000 });
          } finally { if (guarded) await client.query("ROLLBACK"); }
        };
        await explain("run-selection", TRAINING_SELECTION_SQL, [...trainingSelectionParameters(request, labelsAsOf)]);
        await explain("consumer-check-function", "SELECT public.predictive_source_consumer_check(id) FROM unnest($1::text[]) id",
          [seed.examples.slice(0, count).map((row) => row.featureId)]);
        await explain("guarded-consumer-check-function", "SELECT public.predictive_source_consumer_check(id) FROM unnest($1::text[]) id",
          [seed.examples.slice(0, count).map((row) => row.featureId)], true);
        await explain("guarded-label-check-function", "SELECT public.predictive_source_consumer_check(id) FROM unnest($1::text[]) id",
          [seed.examples.slice(0, count).map((row) => row.labelId)], true);
        const inventory = await measure<TrainingRunInventory>(client, target, artifacts, "prepare-run", count,
          (reader) => reader.prepareFittingRun(request), measurements);
        if (inventory) {
          expect(inventory.rows).toHaveLength(count);
          const datasetRequest = { version: "qb-training-read-v1" as const, fittingRunId: inventory.request.fittingRunId,
            inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "capacity-pin-" + count };
          const manifest = await measure<TrainingDatasetManifest>(client, target, artifacts, "prepare-dataset", count,
            (reader) => reader.prepareDataset(datasetRequest), measurements);
          if (manifest) {
            expect(manifest.rows).toHaveLength(count);
            await explain("retained-closure", "SELECT public.predictive_training_dataset_closure($1,$2)",
              [manifest.fittingRunId,manifest.datasetId], true);
            plans.push({ name: "retained-closure", count, references: manifest.closure.references.length, blobs: manifest.closure.blobs.length,
              chargedWireBytes: manifest.closure.blobs.reduce((sum, row) => sum + Number(row.byteSize), 0),
              serializedManifestBytes: Buffer.byteLength(canonical(manifest)),
              chargedBytes: (await client.query("SELECT charged_bytes FROM predictive_training_datasets WHERE id=$1", [manifest.datasetId])).rows[0].charged_bytes });
            for (const rows of [...new Set([1, Math.min(count, 16), count])]) {
              const page = await measure(client, target, artifacts, "page-" + rows, count, (reader) => reader.readDatasetPage({
                version: datasetRequest.version, fittingRunId: datasetRequest.fittingRunId, inventorySha256: datasetRequest.inventorySha256,
                datasetId: datasetRequest.datasetId, manifestSha256: manifest.manifestSha256, cursor: null, limits: { rows, bytes: 8_000_000 } }), measurements);
              if (page) {
                expect(page.rows).toHaveLength(rows);
                for (const row of page.rows) {
                  const example = seed.examples.find((value) => value.playerId === row.slot.playerId)!;
                  expect(row.feature.state).toBe("usable"); expect(row.feature.bundle?.player[0]).toMatchObject({ passingYardsSum: example.passingYards });
                  expect(row.label.state).toBe("missing"); expect(row.label.outcome).toBeNull();
                }
                expect(page.fittingReady).toBe(false);
              }
            }
          }
        }
        const labels = await measure(client, target, artifacts, "current-labels", count, (reader) => reader.readCurrentLabels({
          version: "qb-training-read-v1", selection: { market: "player_pass_yds", stat: "passing_yards", labelVersion: "source-final-label-v1", profileIds: seed.profiles },
          keys: seed.examples.slice(0, count).map((row) => ({ playerId: row.playerId, gameId: row.prior.gameId, seasonType: "REG" as const, labelRef: null })),
          limits: { rows: count, bytes: 8_000_000 } }), measurements);
        if (labels) {
          expect(labels.counts.usable).toBe(count);
          for (const row of labels.rows) expect(row.outcome?.value).toBe(seed.examples.find((value) => value.playerId === row.key.playerId)!.passingYards);
        }
        process.stdout.write("capacity checkpoint " + JSON.stringify({ count, measurements: measurements.filter((m) => m.count === count) }) + "\n");
      }
      process.stdout.write("training capacity evidence " + JSON.stringify({ version: "synthetic-training-capacity-v1", measuredAt: new Date().toISOString(),
        runtime: { node: process.version, postgres: (await client.query("SHOW server_version")).rows[0].server_version, platform: platform(), arch: arch(),
          logicalCpus: cpus().length, cpu: cpus()[0]?.model },
        scope: { players: max, groups: Math.ceil(max / 8), sourceProfiles: seed.profiles.length, historySlots: 1, candidate: "stats-v1:player_pass_yds",
          compressedGroups: Math.floor(Math.ceil(max / 8) / 2), populationCoverage: "unqualified", datasetLabels: "missing", labelsReadSeparately: true },
        migrations: files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 })), drafts, measurements, plans }) + "\n");
      if (max === 1 || requireComplete) expect(measurements.filter((row) => row.status !== "completed"), "capacity refusals are not successful reads").toEqual([]);
      expect(measurements.some((row) => row.status === "completed")).toBe(true);
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
