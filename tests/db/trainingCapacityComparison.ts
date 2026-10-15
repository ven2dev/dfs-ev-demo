import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { expect } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore, type PrivateArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import type { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { canonical } from "../../src/lib/predictive/validation.ts";
import type { TrainingRunInventory } from "../../src/lib/predictive/trainingRuns.ts";
import type { TrainingDatasetManifest } from "../../src/lib/predictive/trainingDatasets.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { createScratchHarness } from "./scratch.mjs";

type Factory = typeof createLocalPredictiveStore;
type Store = Awaited<ReturnType<Factory>>;
type Target = { expected: object; assertTarget: (config: object) => void };
type SqlGroup = { sha256: string; preview: string; calls: number; totalWallMs: number; maxWallMs: number };
type Measurement = { trial: number; mode: "baseline" | "drafts"; operation: string; rows: number;
  status: "completed" | "refused"; reason: string | null; wallMs: number; statements: number;
  uniqueFiles: number; fileReads: number; responseBytes: number; sqlGroups: SqlGroup[] };
const BASELINE = "938fa00ccac61fed9222e4fedb4bec96547b1941";
const refusal = (error: unknown) => error instanceof Error && "code" in error && error.code === "57014" ?
  "sql-statement-timeout" : error instanceof Error ? error.message : "unknown-error";

const measure = async <T>(admin: Client, target: Target, artifacts: PrivateArtifactStore, factory: Factory,
  header: Pick<Measurement, "trial" | "mode" | "operation" | "rows">, work: (store: Store) => Promise<T>, measurements: Measurement[]) => {
  const login = "dfs118_pair_" + randomBytes(8).toString("hex");
  await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-paired-capacity'`);
  await admin.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
  const expected = { ...target.expected, user: login, password: "disposable-paired-capacity" }, client = new Client(expected);
  let collecting = false, statements = 0;
  const groups = new Map<string, SqlGroup>(), reads: string[] = [];
  const observed = new Proxy(client, { get: (object, key) => {
    if (key === "query") return (...args: unknown[]) => {
      if (!collecting) return Reflect.apply(object.query, object, args);
      const sql = typeof args[0] === "string" ? args[0] : "query-config";
      const normalized = sql.replace(/\s+/g, " ").trim(), sha256 = createHash("sha256").update(normalized).digest("hex");
      const group = groups.get(sha256) ?? { sha256, preview: normalized.slice(0, 240), calls: 0, totalWallMs: 0, maxWallMs: 0 };
      groups.set(sha256, group); group.calls++; statements++;
      const started = performance.now();
      return Reflect.apply(object.query, object, args).finally(() => {
        const elapsed = performance.now() - started;
        group.totalWallMs += elapsed; group.maxWallMs = Math.max(group.maxWallMs, elapsed);
      });
    };
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } });
  const files = { ...artifacts, database: { ...artifacts.database,
    read: async (...args: Parameters<typeof artifacts.database.read>) => { reads.push(args[0]); return artifacts.database.read(...args); },
    readBinary: async (...args: Parameters<typeof artifacts.database.readBinary>) => { reads.push(args[0]); return artifacts.database.readBinary(...args); } } };
  try {
    await client.connect();
    expect((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
    const store = await factory(observed, { expected, assertTarget: (config) => {
      expect(config).toEqual(expected); target.assertTarget(target.expected);
    } }, files);
    let result: T | null = null, reason: string | null = null;
    collecting = true;
    const started = performance.now();
    try { result = await work(store); }
    catch (error) {
      reason = refusal(error);
      if (!["training-deadline-exceeded", "sql-statement-timeout"].includes(reason)) throw error;
    } finally { collecting = false; }
    const row: Measurement = { ...header, status: reason ? "refused" : "completed", reason,
      wallMs: Math.round(performance.now() - started), statements, uniqueFiles: new Set(reads).size,
      fileReads: reads.length, responseBytes: result === null ? 0 : Buffer.byteLength(canonical(result)),
      sqlGroups: [...groups.values()].map((group) => ({ ...group, totalWallMs: Math.round(group.totalWallMs), maxWallMs: Math.round(group.maxWallMs) }))
        .sort((a, b) => b.totalWallMs - a.totalWallMs) };
    measurements.push(row);
    process.stdout.write("paired capacity measurement " + JSON.stringify({ ...row, sqlGroups: undefined }) + "\n");
    if (result !== null) expect(new Set(reads).size).toBe(reads.length);
    return result;
  } finally { await client.end(); await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`); }
};

export const compareTrainingCapacity = async () => {
  const max = Number(process.env.PREDICTIVE_CAPACITY_MAX_ROWS ?? 64);
  if (![1, 64].includes(max)) throw new Error("paired-capacity-size-refused");
  const baselineRoot = process.env.PREDICTIVE_CAPACITY_BASELINE_ROOT;
  if (!baselineRoot) throw new Error("paired-capacity-baseline-required");
  // Verify the archived historical runtime before importing it. The module is
  // used only in this owned benchmark; no historical implementation is shipped.
  const tree = execFileSync("git", ["ls-tree", "-rz", BASELINE, "src", "scripts", "tests/db/target.mts"]).toString().split("\0").filter(Boolean);
  for (const entry of tree) {
    const [, , , oid, path] = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry)!;
    const bytes = await readFile(join(baselineRoot, path));
    expect(createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), path).toBe(oid);
  }
  const baselineModule = join(baselineRoot, "src/lib/predictive/persistence.ts"), currentModule = resolve("src/lib/predictive/persistence.ts");
  const factories: { baseline: Factory; drafts: Factory } = {
    baseline: (await import(/* @vite-ignore */ pathToFileURL(baselineModule).href)).createLocalPredictiveStore,
    drafts: (await import(/* @vite-ignore */ pathToFileURL(currentModule).href)).createLocalPredictiveStore,
  };
  const sourceSha256: Record<string, string> = {};
  for (const [mode, path] of [["baseline", baselineModule], ["drafts", currentModule]])
    sourceSha256[mode] = createHash("sha256").update(await readFile(path)).digest("hex");
  const applicationRevision = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  const benchmarkSha256: Record<string, string> = {};
  for (const file of ["tests/db/trainingCapacityComparison.ts", "tests/db/trainingCapacityFixtures.ts",
    "tests/db/trainingCapacity.bench.ts", "tests/db/scratch.mjs"])
    benchmarkSha256[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-paired-")));
  const measurements: Measurement[] = [], closurePlans: unknown[] = [], order = ["baseline", "drafts", "drafts", "baseline"] as const;
  const expectedClosures = new Map<number, unknown>();
  const setupStarted = performance.now();
  try {
    await harness.withDatabase(async (source: Client, template: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      expect(files).toHaveLength(20);
      await ensurePredictiveRoles(source);
      await runScratchMigrations(source, { expected: template, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(source);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const seedStore = await factories.baseline(source, { expected: template, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(seedStore, source, artifacts, max, { guardedRecording: true });
      const labelsAsOf = (await source.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t as string;
      const postgres = (await source.query("SHOW server_version")).rows[0].server_version as string;
      const sourceSnapshot = (await source.query(`SELECT (SELECT count(*) FROM predictive_source_consumers)::integer AS consumers,
        (SELECT count(*) FROM predictive_training_runs)::integer AS runs,
        (SELECT count(*) FROM predictive_observations)::integer AS observations`)).rows[0];
      const setupMs = Math.round(performance.now() - setupStarted);
      process.stdout.write("paired capacity seed " + JSON.stringify({ max, setupMs, sourceSnapshot }) + "\n");
      // Close every connection to the immutable seed before cloning. Every
      // trial starts from these exact rows, without another publication cycle.
      await source.end();
      const proposals = await Promise.all(["0022_predictive_training_liveness.sql", "0023_predictive_training_indexed_closure.sql",
        "0024_predictive_training_readable_contracts.sql"].map(async (file) => ({ file,
          sql: await readFile(new URL("../../db/proposals/" + file, import.meta.url), "utf8") })));
      for (const [trial, mode] of order.entries()) await harness.withDatabase(async (admin: Client, expected: object) => {
        const target = { expected, assertTarget: harness.assertTarget };
        if (mode === "drafts") for (const proposal of proposals) await admin.query(proposal.sql);
        await admin.query("ANALYZE");
        expect((await admin.query(`SELECT (SELECT count(*) FROM predictive_source_consumers)::integer AS consumers,
          (SELECT count(*) FROM predictive_training_runs)::integer AS runs,
          (SELECT count(*) FROM predictive_observations)::integer AS observations`)).rows[0]).toEqual(sourceSnapshot);
        // Equal warm-up for both modes; all timed operations use real restricted
        // connections. Deadlines retire their connection and the next API gets
        // a fresh login, preserving the released interruption contract.
        await admin.query("BEGIN"); await admin.query("SELECT predictive_training_read_guard()"); await admin.query("ROLLBACK");
        for (const rows of [1, 16].filter((n) => n <= max)) {
          const header = { trial, mode, rows }, request = runRequest(seed, rows, labelsAsOf);
          const inventory = await measure<TrainingRunInventory>(admin, target, artifacts, factories[mode], { ...header, operation: "prepare-run" },
            (reader) => reader.prepareFittingRun(request), measurements);
          if (!inventory) continue;
          expect(inventory.rows).toHaveLength(rows);
          // Both versions derive the closure from the assigned inventory, so
          // it can be probed even when later byte-backed sealing times out.
          for (let repeat = 0; repeat < 3; repeat++) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL statement_timeout='15s'");
              await admin.query("SELECT predictive_training_read_guard()");
              const values = [inventory.request.fittingRunId, request.slots[0].datasetId];
              const plan = (await admin.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT predictive_training_dataset_closure($1,$2)", values)).rows[0]["QUERY PLAN"][0];
              const closure = (await admin.query("SELECT predictive_training_dataset_closure($1,$2) AS c", values)).rows[0].c;
              if (!expectedClosures.has(rows)) expectedClosures.set(rows, closure);
              expect(closure).toEqual(expectedClosures.get(rows));
              closurePlans.push({ ...header, repeat, plan, references: closure.references.length, blobs: closure.blobs.length });
            } finally { await admin.query("ROLLBACK"); }
          }
          const manifest = await measure<TrainingDatasetManifest>(admin, target, artifacts, factories[mode], { ...header, operation: "prepare-dataset" },
            (reader) => reader.prepareDataset({ version: "qb-training-read-v1", fittingRunId: inventory.request.fittingRunId,
              inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "capacity-pin-" + rows }), measurements);
          if (manifest) {
            expect(manifest.rows).toHaveLength(rows);
            expect(manifest.closure).toEqual(expectedClosures.get(rows));
            expect(manifest.rows.every((row) => row.feature.state === "usable" && row.label.state === "missing")).toBe(true);
          }
        }
      }, { template });
      process.stdout.write("paired training capacity evidence " + JSON.stringify({ version: "synthetic-training-interleaved-v1", measuredAt: new Date().toISOString(),
        baselineRevision: BASELINE, applicationRevision, sourceSha256, benchmarkSha256, order, sourceSnapshot, setupMs,
        runtime: { node: process.version, postgres, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
        scope: { sourceInventoryPlayers: max, sourceProfiles: seed.profiles.length, selectedWidths: [1,16].filter((n) => n <= max),
          historySlots: 1, opponentContext: false, repetitionsPerMode: 2, fullCapacityMatrix: false,
          sameProcessAndSeedSnapshot: true, freshRestrictedConnectionsPerApi: true,
          closureProbesBeforeDatasetPreparation: true, sqlTimingIncludesClientQueueWait: true },
        migrations: files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 })),
        drafts: proposals.map(({ file, sql }) => ({ file, sha256: createHash("sha256").update(sql).digest("hex") })), measurements, closurePlans }) + "\n");
      expect(measurements.filter((row) => row.status === "completed")).not.toHaveLength(0);
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
};
