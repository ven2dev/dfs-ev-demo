import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore, type PrivateArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import type { TrainingRunInventory } from "../../src/lib/predictive/trainingRuns.ts";
import type { TrainingDatasetManifest } from "../../src/lib/predictive/trainingDatasets.ts";
import type { TrainingHistoricalLabelRequest, TrainingPageRequest } from "../../src/lib/predictive/trainingReads.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { createVerifiedTrainingSpike } from "./prototypes/verifiedTraining.ts";
import { checkVerifiedTrainingParity } from "./prototypes/verifiedTrainingParity.ts";
import { createScratchHarness } from "./scratch.mjs";

type Mode = "baseline" | "prototype";
type Target = { expected: object; assertTarget: (config: object) => void };
type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
type Spike = Awaited<ReturnType<typeof createVerifiedTrainingSpike>>;
type Stat = { userid: number; queryid: string; toplevel: boolean; query: string; calls: number; hits: number; reads: number; ms: number };
type Measurement = { trial: number; mode: Mode; operation: string; rows: number; sample: number; status: "completed" | "refused";
  reason: string | null; wallMs: number; statements: number; uniqueFiles: number; fileVerifications: number;
  rightsQueries: number; sharedBufferHits: number; sharedBufferReads: number; responseBytes: number; sql: { calls: number; hash: string; preview: string; wallMs: number }[];
  nested: Stat[] };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const stats = async (admin: Client) => (await admin.query(`SELECT userid,queryid::text,toplevel,query,calls::float8,
  shared_blks_hit::float8 AS hits,shared_blks_read::float8 AS reads,total_exec_time::float8 AS ms
  FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE '%pg_stat_activity%'`)).rows as Stat[];
const deltaStats = (before: Stat[], after: Stat[]) => {
  const old = new Map(before.map((row) => [row.userid + ":" + row.queryid + ":" + row.toplevel, row]));
  return after.map((row) => {
    const prior = old.get(row.userid + ":" + row.queryid + ":" + row.toplevel);
    return { ...row, calls: row.calls - (prior?.calls ?? 0), hits: row.hits - (prior?.hits ?? 0), reads: row.reads - (prior?.reads ?? 0), ms: row.ms - (prior?.ms ?? 0) };
  }).filter((row) => row.calls > 0);
};

it("measures the #127 verify-on-write spike with interleaved unchanged-deadline evidence", async () => {
  const population = Number(process.env.SPIKE127_QBS ?? 9), targets = Number(process.env.SPIKE127_TARGET_GAMES ?? (population === 64 ? 4 : 1));
  if (![9, 64, 256].includes(population)) throw new Error("spike-population-refused");
  const widths = population === 9 ? [9] : [16, 64, 256];
  const repeats = Number(process.env.SPIKE127_REPEATS ?? 3);
  if (![1, 3, 10].includes(repeats)) throw new Error("spike-repeats-refused");
  const output = process.env.SPIKE127_EVIDENCE;
  if (!output || !/^docs\/evidence\/predictive-127-[a-z0-9-]+\.json$/.test(output)) throw new Error("spike-evidence-path-required");
  const baseline = execFileSync("git", ["rev-parse", "4064557"]).toString().trim();
  // The old production path is literally unchanged on this experiment branch.
  const original = execFileSync("git", ["show", baseline + ":src/lib/predictive/persistence.ts"]);
  expect(await readFile("src/lib/predictive/persistence.ts")).toEqual(original);
  const proposalPath = "db/proposals/spike127_verified_reads.sql", proposal = await readFile(proposalPath, "utf8");
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs127-")));
  const measurements: Measurement[] = [], correctness: { case: string; passed: boolean; details?: unknown }[] = [];
  const order: Mode[] = ["baseline", "prototype", "prototype", "baseline"];
  const hashes: Record<string, string> = {};
  for (const path of [proposalPath, "tests/db/prototypes/verifiedTraining.ts", "tests/db/verifiedTraining.bench.ts",
    "tests/db/prototypes/verifiedTrainingParity.ts", "tests/db/trainingCapacityFixtures.ts", "src/lib/predictive/persistence.ts", "src/lib/predictive/trainingReads.ts",
    "src/lib/predictive/artifacts.ts", "src/lib/predictive/training.ts", "tests/db/scratch.mjs"])
    hashes[path] = sha(await readFile(path));
  const setupStarted = performance.now();
  let setup: object = {}, prefix: object[] = [], postgres = "unknown", experimentFailure: string | null = null;
  const measure = async <T>(admin: Client, target: Target, artifacts: PrivateArtifactStore,
    header: Pick<Measurement, "trial" | "mode" | "operation" | "rows" | "sample">,
    work: (store: Store, spike: Spike, client: Client, files: PrivateArtifactStore) => Promise<T>) => {
    const login = "dfs127_" + randomBytes(8).toString("hex"), password = "disposable-spike";
    await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await admin.query(`GRANT predictive_recorder,predictive_replay,predictive_harness TO ${login}`);
    const expected = { ...target.expected, user: login, password }, client = new Client(expected);
    const apiTarget = { expected, assertTarget: (config: object) => { expect(config).toEqual(expected); target.assertTarget(target.expected); } };
    const sql = new Map<string, { calls: number; hash: string; preview: string; wallMs: number }>();
    const reads: string[] = [];
    let collecting = false;
    const observed = new Proxy(client, { get(object, key) {
      if (key === "query") return (...args: unknown[]) => {
        if (!collecting) return Reflect.apply(object.query, object, args);
        const query = String(args[0]).replace(/\s+/g, " ").trim(), hash = sha(query);
        const group = sql.get(hash) ?? { calls: 0, hash, preview: query.slice(0, 180), wallMs: 0 };
        sql.set(hash, group); group.calls++;
        const start = performance.now();
        return Reflect.apply(object.query, object, args).finally(() => { group.wallMs += performance.now() - start; });
      };
      const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
    } });
    const files: PrivateArtifactStore = { ...artifacts, database: { ...artifacts.database,
      read: async (...args) => { reads.push(args[0]); return artifacts.database.read(...args); },
      readBinary: async (...args) => { reads.push(args[0]); return artifacts.database.readBinary(...args); } } };
    try {
      await client.connect();
      expect((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
      const store = await createLocalPredictiveStore(observed, apiTarget, files), spike = await createVerifiedTrainingSpike(observed, apiTarget, files);
      await admin.query("SELECT public.pg_stat_statements_reset(0::oid,(SELECT oid FROM pg_database WHERE datname=current_database()),0::bigint)");
      const before = await stats(admin);
      let result: T | null = null, reason: string | null = null;
      collecting = true;
      const start = performance.now();
      try { result = await work(store, spike, observed, files); }
      catch (error) {
        reason = error instanceof Error && "code" in error && error.code === "57014" ? "sql-statement-timeout" : error instanceof Error ? error.message : "unknown";
        if (!["training-deadline-exceeded", "sql-statement-timeout"].includes(reason)) throw error;
      } finally { collecting = false; }
      const wallMs = performance.now() - start, nested = deltaStats(before, await stats(admin));
      const top = nested.filter((row) => row.toplevel);
      const row: Measurement = { ...header, status: reason ? "refused" : "completed", reason, wallMs,
        statements: [...sql.values()].reduce((n, group) => n + group.calls, 0), uniqueFiles: new Set(reads).size, fileVerifications: reads.length,
        rightsQueries: nested.filter((row) => row.query.includes("current_rights c ON c.profile_id=r.profile") || row.query.includes("purpose = ANY(d.allowed_uses)")).reduce((n, row) => n + row.calls, 0),
        sharedBufferHits: top.reduce((n, row) => n + row.hits, 0), sharedBufferReads: top.reduce((n, row) => n + row.reads, 0),
        responseBytes: result === null ? 0 : Buffer.byteLength(canonical(result)), sql: [...sql.values()], nested: nested.sort((a, b) => b.ms - a.ms).slice(0, 12) };
      measurements.push(row);
      process.stdout.write("spike127 measurement " + JSON.stringify({ ...row, sql: undefined, nested: undefined }) + "\n");
      await writeEvidence();
      return result;
    } finally { await client.end(); await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`); }
  };
  const writeEvidence = async () => {
    const prototype = measurements.filter((row) => row.mode === "prototype"), p95 = (rows: Measurement[]) => {
      if (!rows.length || rows.some((row) => row.status !== "completed")) return null;
      return rows.map((row) => row.wallMs).sort((a, b) => a - b)[Math.ceil(rows.length * 0.95) - 1];
    };
    const byOperation = [...new Set(measurements.map((row) => row.operation))].flatMap((operation) => widths.map((rows) => {
      const samples = prototype.filter((row) => row.operation === operation && row.rows === rows);
      return { operation, rows, samples: samples.length, completed: samples.filter((row) => row.status === "completed").length, p95Ms: p95(samples) };
    }));
    const timed = prototype.filter((row) => !row.operation.startsWith("record-"));
    const targetRows = prototype.filter((row) => row.rows === 256), seal = targetRows.filter((row) => row.operation === "seal");
    const writes = ["record-feature", "record-label"].map((operation) => {
      const median = (mode: Mode) => {
        const values = measurements.filter((row) => row.mode === mode && row.operation === operation && row.status === "completed").map((row) => row.wallMs).sort((a, b) => a - b);
        return values.length ? values[Math.floor(values.length / 2)] : null;
      };
      const old = median("baseline"), current = median("prototype");
      return { operation, baselineMedianMs: old, prototypeMedianMs: current, overheadPercent: old && current ? (current / old - 1) * 100 : null,
        pass: old !== null && current !== null && current <= old * 1.2 };
    });
    const targets = [
      { target: "seal-256-at-most-5s", pass: seal.length === 2 && seal.every((row) => row.status === "completed" && row.wallMs <= 5000) },
      ...["page", "labels"].map((operation) => ({ target: operation + "-256-p95-at-most-1s", p95Ms: p95(targetRows.filter((row) => row.operation === operation)),
        pass: targetRows.filter((row) => row.operation === operation).length === repeats * 2 && p95(targetRows.filter((row) => row.operation === operation)) !== null && p95(targetRows.filter((row) => row.operation === operation))! <= 1000 })),
      { target: "at-least-30-percent-deadline-headroom", pass: timed.length > 0 && timed.every((row) => row.status === "completed" && row.wallMs <= (["seal", "prepare-run"].includes(row.operation) ? 21000 : 7000)) },
      { target: "one-rights-query-per-request", pass: timed.length > 0 && timed.every((row) => row.rightsQueries === 1) },
      { target: "file-verifications-at-most-unique-files", pass: timed.length > 0 && timed.every((row) => row.fileVerifications <= row.uniqueFiles) },
      { target: "flat-client-sql-statements", pass: ["seal", "page", "labels"].every((operation) => {
        const rows = prototype.filter((row) => row.operation === operation && row.status === "completed");
        return new Set(rows.map((row) => row.rows)).size === widths.length && new Set(rows.map((row) => row.statements)).size === 1;
      }) },
      { target: "feature-and-label-recording-overhead-at-most-20-percent", pass: writes.every((row) => row.pass) },
      { target: "correctness-parity-including-adversarial-certification", pass: correctness.length > 0 && correctness.every((check) => check.passed) },
      { target: "required-fixture-widths-executed", pass: [64, 256].includes(population) && widths.every((width) =>
        ["baseline", "prototype"].every((mode) => measurements.some((row) => row.mode === mode && row.operation === "seal" && row.rows === width))) },
    ];
    await writeFile(output, JSON.stringify({ version: "verify-on-write-spike-v1", measuredAt: new Date().toISOString(), baseline,
      applicationRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(), sourceHashes: hashes, migrations: prefix,
      runtime: { node: process.version, postgres, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
      setup, workload: { population, distinctTargetEventsPerQb: population === 64 ? 4 : 1, widths, repeatsPerArm: repeats,
        historySlots: 1, opponentContext: false, targetLabels: "missing", historicalLabels: "usable", populationQualified: false }, order,
      protocol: { sameSeed: true, restrictedFreshConnectionPerApi: true, baselinePagesAndLabelsChunkSize: 64, prototypeMaxRows: 256,
        p95Method: "nearest-rank; empirical small-sample result, not a tail-confidence bound", statements: "client calls; nested SQL separately reported",
        buffers: "pg_stat_statements top-level shared blocks, excluding observer queries; cumulative hits, not unique physical pages",
        guardRemoved: false, deletionChanged: false, deadlines: { readMs: 10000, preparationMs: 30000 },
        rightsQueries: "nested set-based authorization statements (prototype) or SQL rights-allow evaluations (baseline)",
        certificatesCreatedDuringCheckedIngestion: true, metadataRecorder: "preserves frozen selection rules; consumes certificates" },
      experimentFailure, targets, summaries: byOperation, writes, correctness, measurements }, null, 2) + "\n");
  };
  try {
    await harness.withDatabase(async (source: Client, template: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      expect(files).toHaveLength(20);
      prefix = files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 }));
      await ensurePredictiveRoles(source);
      await runScratchMigrations(source, { expected: template, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(source);
      await source.query("CREATE EXTENSION pg_stat_statements");
      await source.query(proposal);
      postgres = (await source.query("SHOW server_version")).rows[0].server_version;
      const artifacts = await openArtifactStore(root, 8_000_000);
      const observedSeed = new Proxy(source, { get(object, key) {
        if (key === "query") return (...args: unknown[]) => {
          if (typeof args[0] === "string") args[0] = args[0].replace(/\bpredictive_record_source_consumer\(/g, "spike127_record_source_consumer(");
          return Reflect.apply(object.query, object, args);
        };
        const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
      } });
      const producer = await createLocalPredictiveStore(observedSeed, { expected: template, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(producer, observedSeed, artifacts, population, { guardedRecording: true, targetGames: targets });
      const clock = (await source.query("SELECT predictive_source_time(clock_timestamp()) AS clock")).rows[0].clock as string;
      const candidate = await createVerifiedTrainingSpike(source, { expected: template, assertTarget: harness.assertTarget }, artifacts);
      const inventories = new Map<number, TrainingRunInventory>(), readManifests = new Map<number, TrainingDatasetManifest>();
      for (const width of widths) {
        const request = runRequest(seed, width, clock);
        inventories.set(width, await candidate.prepareFittingRun(request));
        const readRequest = { ...request, fittingRunId: "read-" + request.fittingRunId, evaluationPlanId: "read-" + request.evaluationPlanId,
          slots: request.slots.map((slot) => ({ ...slot, datasetId: "read-" + slot.datasetId })) };
        const inventory = await candidate.prepareFittingRun(readRequest);
        const manifest = await candidate.prepareDataset({ version: request.version, fittingRunId: readRequest.fittingRunId,
          inventorySha256: inventory.inventorySha256, datasetId: readRequest.slots[0].datasetId, pinId: "read-pin-" + width });
        const expectedClosure = (await source.query("SELECT predictive_training_dataset_closure($1,$2) AS closure", [readRequest.fittingRunId, manifest.datasetId])).rows[0].closure;
        expect(manifest.closure).toEqual(expectedClosure);
        correctness.push({ case: "certificate-union-matches-frozen-full-closure-" + width, passed: true });
        readManifests.set(width, manifest);
      }
      setup = { ms: performance.now() - setupStarted, artifactsRootPersisted: false,
        consumers: (await source.query("SELECT count(*)::integer AS n FROM predictive_source_consumers")).rows[0].n,
        certificates: (await source.query("SELECT count(*)::integer AS n FROM spike127_certificates")).rows[0].n };
      process.stdout.write("spike127 seed " + JSON.stringify(setup) + "\n");
      await writeEvidence();
      await source.end();
      if (population === 9) {
        await checkVerifiedTrainingParity(harness, template, artifacts, root, seed, readManifests.get(widths[0])!, clock, correctness);
        await writeEvidence();
      }
      for (const [trial, mode] of order.entries()) await harness.withDatabase(async (admin: Client, expected: object) => {
        const target = { expected, assertTarget: harness.assertTarget };
        await admin.query("ANALYZE");
        for (const width of widths) {
          const base = inventories.get(width)!, manifest = readManifests.get(width)!;
          const fresh = { ...base.request, fittingRunId: "timed-" + base.request.fittingRunId, evaluationPlanId: "timed-" + base.request.evaluationPlanId };
          const prepared = await measure(admin, target, artifacts, { trial, mode, operation: "prepare-run", rows: width, sample: 0 },
            (store, spike) => (mode === "baseline" ? store : spike).prepareFittingRun(fresh));
          if (prepared) {
            expect(prepared.rows).toEqual(base.rows);
            expect(prepared.protectedUses).toEqual(base.protectedUses);
            correctness.push({ case: mode + "-inventory-rows-and-protected-uses-" + width + "-" + trial, passed: true });
          }
          const sealed = await measure(admin, target, artifacts, { trial, mode, operation: "seal", rows: width, sample: 0 },
            (store, spike) => (mode === "baseline" ? store : spike).prepareDataset({ version: base.request.version,
              fittingRunId: base.request.fittingRunId, inventorySha256: base.inventorySha256,
              datasetId: base.request.slots[0].datasetId, pinId: "timed-pin-" + width }));
          if (sealed) {
            expect(sealed.rows).toEqual(base.rows);
            expect(sealed.closure).toEqual((await admin.query("SELECT predictive_training_dataset_closure($1,$2) AS closure", [base.request.fittingRunId, sealed.datasetId])).rows[0].closure);
          }
          const distinct = [...new Map(seed.examples.slice(0, width).map((row) => [row.playerId, row])).values()];
          // At 64 QBs x4 targets, historical label requests have 64 distinct
          // player/game keys. Four games per player do not fabricate 256 labels.
          const labelRequest: TrainingHistoricalLabelRequest = { version: "qb-training-read-v1", labelsAsOf: clock,
            selection: { market: "player_pass_yds", stat: "passing_yards", labelVersion: "source-final-label-v1", profileIds: seed.profiles },
            keys: distinct.map((row) => ({ playerId: row.playerId, gameId: row.prior.gameId, seasonType: "REG", labelRef: null })),
            limits: { rows: Math.min(64, distinct.length), bytes: 8_000_000 } };
          for (let sample = 0; sample < repeats; sample++) {
            const pageRequest: TrainingPageRequest = { version: "qb-training-read-v1", fittingRunId: manifest.fittingRunId,
              inventorySha256: manifest.inventorySha256, datasetId: manifest.datasetId, manifestSha256: manifest.manifestSha256,
              cursor: null, limits: { rows: Math.min(64, width), bytes: 8_000_000 } };
            const page = await measure(admin, target, artifacts, { trial, mode, operation: "page", rows: width, sample }, async (store, spike) => {
              if (mode === "prototype") return spike.readDatasetPage(pageRequest, width);
              const rows = []; let cursor: string | null = null;
              do { const part = await store.readDatasetPage({ ...pageRequest, cursor }); rows.push(...part.rows); cursor = part.nextCursor; } while (cursor && rows.length < width);
              return { rows };
            });
            if (page) {
              expect(page.rows).toHaveLength(width);
              const expected = new Map(seed.examples.map((row) => [row.playerId, row.passingYards]));
              expect(page.rows.map((row) => row.feature.bundle?.player[0].passingYardsSum)).toEqual(base.rows.map((row) => row.feature.state === "usable" ? expected.get(row.slot.playerId) : undefined));
              expect(page.rows.map((row) => row.feature.state)).toEqual(base.rows.map((row) => row.feature.state));
              expect(page.rows.map((row) => row.feature.reference?.id)).toEqual(base.rows.map((row) => row.feature.reference?.id));
              expect(page.rows.every((row) => row.label.state === "missing")).toBe(true);
            }
            const labels = await measure(admin, target, artifacts, { trial, mode, operation: "labels", rows: distinct.length, sample }, async (store, spike) => {
              if (mode === "prototype") return spike.readLabelsAt(labelRequest);
              const rows = [];
              for (let offset = 0; offset < labelRequest.keys.length; offset += 64) {
                const part = await store.readLabelsAt({ ...labelRequest, keys: labelRequest.keys.slice(offset, offset + 64), limits: { ...labelRequest.limits, rows: Math.min(64, distinct.length) } });
                rows.push(...part.rows);
              }
              return { rows };
            });
            if (labels) {
              expect(labels.rows.map((row) => row.outcome?.value)).toEqual(distinct.map((row) => row.passingYards));
              expect(labels.rows.map((row) => row.reference?.id)).toEqual(distinct.map((row) => row.labelId));
            }
          }
        }
        for (const kind of ["feature", "label"] as const) for (let sample = 0; sample < 3; sample++) {
          const id = kind === "feature" ? seed.examples[0].featureId : seed.examples[0].labelId;
          const body = (await admin.query("SELECT body FROM predictive_source_consumers WHERE id=$1", [id])).rows[0].body;
          await measure(admin, target, artifacts, { trial, mode, operation: "record-" + kind, rows: 1, sample }, async (_store, _spike, client, files) => {
            const bytes = canonical(body), hash = digest(bytes);
            await files.database.write(bytes, hash);
            await client.query("BEGIN");
            try {
              await client.query("SELECT predictive_training_read_guard()");
              const head = kind === "label" ? sample === 0 ? id : "write-label-" + (sample - 1) : null;
              const fn = mode === "baseline" ? "predictive_record_source_consumer" : "spike127_record_source_consumer";
              const result = (await client.query(`SELECT public.${fn}($1,$2,$3) AS record`, ["write-" + kind + "-" + sample, head, body])).rows[0].record;
              await client.query("COMMIT"); return result;
            } catch (error) { await client.query("ROLLBACK"); throw error; }
          });
        }
      }, { template });
      await writeEvidence();
    });
  } catch (error) {
    experimentFailure = error instanceof Error ? error.message : "unknown-error";
    await writeEvidence();
    throw error;
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 7_200_000);
