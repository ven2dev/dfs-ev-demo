import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { createScratchHarness } from "./scratch.mjs";

// Nested plans are diagnostic: instrumentation overhead is NOT capacity time.
it("profiles nested QB run and byte-backed preparation through restricted roles", async () => {
  const size = Number(process.env.PREDICTIVE_PROFILE_ROWS ?? 16);
  if (![4, 16, 64].includes(size)) throw new Error("training-profile-size-refused");
  const candidate = process.env.PREDICTIVE_PROFILE_WITNESS_POPULATION === "1";
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-profile-")));
  try {
    await harness.withDatabase(async (admin: Client, expected: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(admin);
      await runScratchMigrations(admin, { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(admin);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const producer = await createLocalPredictiveStore(admin, { expected, assertTarget: harness.assertTarget }, artifacts);
      const seed = await seedCapacity(producer, admin, artifacts, size, { guardedRecording: true });
      const clock = (await admin.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t;
      const request = runRequest(seed, Math.min(size, 16), clock), inventory = await producer.prepareFittingRun(request);
      const proposals = [];
      if (candidate) {
        const path = "db/proposals/training_witness_population.sql", sql = await readFile(path, "utf8");
        await admin.query(sql);
        proposals.push({ path, sha256: createHash("sha256").update(sql).digest("hex") });
      }
      await admin.query("ANALYZE");
      const login = "dfs118_profile_" + randomBytes(8).toString("hex");
      await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER PASSWORD 'disposable-nested-profile'`);
      await admin.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
      // Owner/admin configures instrumentation; measured APIs do not acquire
      // permission to LOAD modules or bypass recorder/replay roles.
      for (const [name, value] of Object.entries({ session_preload_libraries: "auto_explain", client_min_messages: "notice",
        "auto_explain.log_min_duration": "10ms", "auto_explain.log_nested_statements": "on",
        "auto_explain.log_analyze": "on", "auto_explain.log_buffers": "on", "auto_explain.log_timing": "off",
        "auto_explain.log_format": "json", "auto_explain.log_level": "notice", "auto_explain.log_parameter_max_length": "0" }))
        await admin.query(`ALTER ROLE ${login} SET ${name}='${value}'`);
      const config = { ...expected, user: login, password: "disposable-nested-profile" };
      const measurements: unknown[] = [], plans: { phase: string; durationMs: number; plan: unknown }[] = [];
      const statements = new Map<string, { sha256: string; sql: string; calls: number; wallMs: number }>();
      let phase = "setup", inFlight = 0, overlaps = 0;
      const sourceHashes: Record<string, string> = {};
      for (const file of ["src/lib/predictive/persistence.ts", "src/lib/predictive/queryQueue.ts", "src/lib/predictive/batchEvidence.ts",
        "tests/db/trainingProfile.bench.ts", "tests/db/trainingCapacityFixtures.ts"])
        sourceHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
      try {
        // Fresh connection for each phase, even after timeout/cancellation.
        for (const operation of ["read-run", "prepare-dataset"] as const) {
          const client = new Client(config);
          client.on("notice", (notice) => {
            const match = /^duration: ([\d.]+) ms\s+plan:\s*([\s\S]+)$/.exec(notice.message ?? "");
            if (match) plans.push({ phase, durationMs: Number(match[1]), plan: JSON.parse(match[2]) });
          });
          try {
            await client.connect();
            expect((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
            const strict = new Proxy(client, { get: (object, key) => {
              if (key === "query") return async (...args: unknown[]) => {
                if (inFlight) { overlaps++; throw new Error("training-profile-overlapping-query"); }
                inFlight++;
                const sql = String(args[0]), sha256 = createHash("sha256").update(sql).digest("hex");
                const identity = phase + ":" + sha256;
                const group = statements.get(identity) ?? { sha256, sql, calls: 0, wallMs: 0 };
                statements.set(identity, group); group.calls++;
                const started = performance.now();
                try { return await Reflect.apply(object.query, object, args); }
                finally { group.wallMs += performance.now() - started; inFlight--; }
              };
              const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
            } });
            const store = await createLocalPredictiveStore(strict, { expected: config, assertTarget: (value) => {
              expect(value).toEqual(config); harness.assertTarget(expected);
            } }, artifacts);
            phase = operation;
            const started = performance.now();
            let status = "completed", reason: string | null = null;
            try {
              if (operation === "read-run") expect((await store.readFittingRun(request.fittingRunId))?.rows).toHaveLength(request.slots.length);
              else expect((await store.prepareDataset({ version: "qb-training-read-v1", fittingRunId: request.fittingRunId,
                inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "nested-profile-pin" })).rows)
                .toHaveLength(request.slots.length);
            } catch (error) {
              reason = error instanceof Error ? error.message : "unknown-error";
              if (!["training-deadline-exceeded"].includes(reason)) throw error;
              status = "refused";
            }
            measurements.push({ operation, status, reason, instrumentedWallMs: Math.round(performance.now() - started) });
          } finally { await client.end(); phase = "setup"; }
        }
        expect(overlaps).toBe(0); expect(inFlight).toBe(0);
        expect(plans.some((entry) => entry.phase === "read-run")).toBe(true);
        expect(plans.some((entry) => entry.phase === "prepare-dataset")).toBe(true);
        process.stdout.write("nested training profile evidence " + JSON.stringify({ version: "training-nested-profile-v1",
          measuredAt: new Date().toISOString(), applicationRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
          sourceHashes, proposals, migrations: files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 })),
          scope: { sourcePlayers: size, sourceProfiles: seed.profiles.length, selectedRows: request.slots.length,
            historySlots: 1, opponentContext: false, frozenPrefixOnly: !candidate, bindParameterLogging: false,
            plansContainSyntheticConstants: true,
            diagnosticNotCapacity: true, minimumNestedDurationMs: 10, node: process.version,
            postgres: (await admin.query("SHOW server_version")).rows[0].server_version },
          measurements, overlaps, statements: [...statements].filter(([key]) => !key.startsWith("setup:")).map(([key, group]) => ({
            phase: key.split(":")[0], ...group, wallMs: Math.round(group.wallMs) })), plans }) + "\n");
      } finally { await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`); }
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
