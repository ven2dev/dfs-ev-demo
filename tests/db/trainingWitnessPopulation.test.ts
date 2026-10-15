import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv } from "../predictive/fixtures/source.ts";
import { seedCapacity, runRequest } from "./trainingCapacityFixtures.ts";
import { createScratchHarness } from "./scratch.mjs";

it("QB witness population draft preserves filtered history, routing, rights epochs and restricted consumer replay", async () => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-witness-population-")));
  try {
    await harness.withDatabase(async (admin: Client, expected: object) => {
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(admin);
      await runScratchMigrations(admin, { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(admin);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const producer = await createLocalPredictiveStore(admin, { expected, assertTarget: harness.assertTarget }, artifacts);
      // Includes distinct CSV/gzip profiles and independently known values.
      const seed = await seedCapacity(producer, admin, artifacts, 9, { guardedRecording: true });
      const clock = async () => (await admin.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t as string;
      const keys = seed.examples.map((row) => "player-game-stats:" + row.prior.gameId + ":" + row.playerId).sort();
      const missing = "player-game-stats:" + seed.examples[0].prior.gameId + ":00-9999999";
      const selections = [[], [keys[0]], [keys.at(-1)!], [keys[0], keys.at(-1)!].sort(), [missing], keys];
      const request = runRequest(seed, 9, await clock()), inventory = await producer.prepareFittingRun(request);
      const original = await producer.readFittingRun(request.fittingRunId);
      const settings = async () => (await admin.query(`SELECT proowner,proacl,prosecdef,provolatile,proconfig
        FROM pg_proc WHERE oid='predictive_source_witness_at(jsonb,timestamptz)'::regprocedure`)).rows[0];
      const beforeSettings = await settings();
      const proposal = await readFile(new URL("../../db/proposals/training_witness_population.sql", import.meta.url), "utf8");
      await admin.query(proposal);
      expect(await settings()).toEqual(beforeSettings);

      const compare = async (cutoff: string, at: string) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SELECT predictive_training_read_guard()");
          const results = [];
          for (const entityKeys of selections) {
            const input = { profileIds: seed.profiles, entityKeys, cutoff };
            const reference = (await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [input, at])).rows[0].w;
            expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [input, at])).rows[0].w).toEqual(reference);
            expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [input, at])).rows[0].w).toEqual(reference);
            results.push(reference);
          }
          // Every entity view used one complete reconstruction, rather than
          // one reconstruction per entity. Only immutable results are shared.
          expect((await admin.query("SELECT count(*)::integer AS n FROM pg_temp.predictive_training_memo WHERE kind='witness-population'")).rows[0].n).toBe(1);
          return results;
        } finally { await admin.query("ROLLBACK"); }
      };
      const usable = await compare(seed.cutoff, await clock());
      expect(usable[0].heads).toHaveLength(9);
      expect(usable[4].missingEntityKeys).toEqual([missing]);
      const boundary = (await admin.query(`SELECT predictive_source_time(min(recorded_at)-interval '1 millisecond') AS t
        FROM predictive_source_bindings`)).rows[0].t as string;
      expect((await compare(boundary, await clock()))[5].missingEntityKeys).toEqual(keys);
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT predictive_training_read_guard()");
        const t = await clock();
        for (const cutoff of [seed.cutoff, boundary, seed.cutoff]) for (const profileIds of [seed.profiles, [seed.profiles[0]]]) {
          const input = { profileIds, entityKeys: [keys[0]], cutoff };
          const reference = (await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [input, t])).rows[0].w;
          expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [input, t])).rows[0].w).toEqual(reference);
        }
        expect((await admin.query("SELECT count(*)::integer AS n FROM pg_temp.predictive_training_memo WHERE kind='witness-population'")).rows[0].n).toBe(4);
        // A warmed key cannot bypass the future-clock check.
        await admin.query("SAVEPOINT future_clock");
        await expect(admin.query("SELECT predictive_source_witness_at($1,$2)", [{ profileIds: seed.profiles,
          entityKeys: [keys[0]], cutoff: seed.cutoff }, boundary])).rejects.toThrow("source-binding-future-cutoff-refused");
        await admin.query("ROLLBACK TO SAVEPOINT future_clock");
      } finally { await admin.query("ROLLBACK"); }
      // Without SHARE guards no result is reused. A write-capable lock in the
      // same transaction likewise disables both population and entity caches.
      const unguarded = { profileIds: seed.profiles, entityKeys: [keys[0]], cutoff: seed.cutoff };
      expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [unguarded, await clock()])).rows[0].w).toEqual(usable[1]);
      expect((await admin.query("SELECT to_regclass('pg_temp.predictive_training_memo') AS t")).rows[0].t).toBeNull();
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT predictive_training_read_guard()");
        await admin.query("SELECT predictive_source_witness_at($1,$2)", [unguarded, await clock()]);
        await admin.query(`INSERT INTO predictive_rights_decisions
          SELECT 'population-own-write',profile_id,id,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,
            date_trunc('milliseconds',clock_timestamp()),'synthetic','same-transaction cache invalidation'
          FROM predictive_rights_decisions d WHERE profile_id='capacity-context' AND NOT EXISTS
            (SELECT 1 FROM predictive_rights_decisions n WHERE n.predecessor_id=d.id)`);
        expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(false);
        const t = await clock(), reference = (await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [unguarded, t])).rows[0].w;
        expect(reference.reason).toBe("rights-not-in-force");
        expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [unguarded, t])).rows[0].w).toEqual(reference);
      } finally { await admin.query("ROLLBACK"); }

      const login = "dfs118_population_" + randomBytes(8).toString("hex");
      await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER PASSWORD 'disposable-population'`);
      await admin.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
      const config = { ...expected, user: login, password: "disposable-population" }, reader = new Client(config);
      try {
        await reader.connect();
        const store = await createLocalPredictiveStore(reader, { expected: config, assertTarget: (value) => {
          expect(value).toEqual(config); harness.assertTarget(expected);
        } }, artifacts);
        expect(await store.readFittingRun(request.fittingRunId)).toEqual(original);
        const saved = await store.prepareDataset({ version: request.version, fittingRunId: request.fittingRunId,
          inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "population-proof-pin" });
        const page = await store.readDatasetPage({ version: request.version, fittingRunId: request.fittingRunId,
          inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId,
          manifestSha256: saved.manifestSha256, cursor: null, limits: { rows: 9, bytes: 8_000_000 } });
        expect(page.rows.map((row) => row.feature.bundle?.player[0].passingYardsSum)).toEqual(seed.examples.map((row) => row.passingYards));
        expect(page.rows.every((row) => row.label.state === "missing")).toBe(true);
        await expect(reader.query("SELECT predictive_source_witness_at('{}',clock_timestamp())")).rejects.toMatchObject({ code: "42501" });
      } finally { await reader.end(); await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`); }

      const publish = async (bad: boolean) => {
        const rows = seed.examples.filter((row) => row.profileId === seed.profiles[0]).map((row) => ({
          player_id: row.playerId, position: "QB", game_id: row.prior.rawGameId, season: "2026", week: "6", season_type: "REG",
          team: row.prior.rawHomeTeam, opponent_team: row.prior.rawAwayTeam, attempts: "25", passing_yards: bad ? "invalid" : "999" }));
        const input = sourceClaimFixture(bad ? "population-unresolved" : "population-stale", "player", sourceCsv("player", rows));
        input.profile.id = seed.profiles[0]; input.artifact.profileId = input.profile.id;
        input.rightsDecisions = []; input.capturedAt = await clock();
        await producer.publishSourceStats(input);
        return clock();
      };
      const stale = await compare(await publish(false), await clock());
      expect(stale[1].withheld.some((row: { routing: string }) => row.routing === "known-destinations")).toBe(true);
      expect(stale[4].withheld).toEqual([]);
      const unresolved = await compare(await publish(true), await clock());
      expect(unresolved[4].withheld.some((row: { routing: string; entityKeys: string[] }) => row.routing === "unresolved" && !row.entityKeys.length)).toBe(true);
      expect(unresolved[4].missingEntityKeys).toEqual([]);
      // Later source captures never rewrite the earlier view, even after the
      // complete unfiltered population has been cached for another cutoff.
      expect(await compare(seed.cutoff, await clock())).toEqual(usable);

      const at = new Date(Date.parse(await clock()) + 600_000).toISOString();
      await admin.query(`INSERT INTO predictive_rights_decisions
        SELECT 'population-scheduled',profile_id,id,'{}',$1,NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','witness epoch probe'
        FROM predictive_rights_decisions d WHERE profile_id='capacity-context' AND NOT EXISTS
          (SELECT 1 FROM predictive_rights_decisions n WHERE n.predecessor_id=d.id)`, [at]);
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT predictive_training_read_guard()");
        const input = { profileIds: seed.profiles, entityKeys: [keys[0]], cutoff: seed.cutoff };
        const before = new Date(Date.parse(at) - 1).toISOString();
        expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [input, before])).rows[0].w).toEqual(usable[1]);
        const reference = (await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [input, at])).rows[0].w;
        expect(reference).toMatchObject({ reason: "rights-not-in-force", heads: [], missingEntityKeys: [] });
        expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [input, at])).rows[0].w).toEqual(reference);
        expect((await admin.query("SELECT count(*)::integer AS n FROM pg_temp.predictive_training_memo WHERE kind='witness-population'")).rows[0].n).toBe(2);
        for (const entityKeys of [[keys[0], keys[0]], ["not-an-entity"], [null]]) {
          await admin.query("SAVEPOINT malformed");
          await expect(admin.query("SELECT predictive_source_witness_at($1,$2)", [{ ...input, entityKeys }, before]))
            .rejects.toThrow("predictive-source-witness-request-refused");
          await admin.query("ROLLBACK TO SAVEPOINT malformed");
        }
      } finally { await admin.query("ROLLBACK"); }
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 120_000);
