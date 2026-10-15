import { randomBytes } from "node:crypto";
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
import { digest } from "../../src/lib/predictive/validation.ts";
import { seedCapacity } from "./trainingCapacityFixtures.ts";
import { createScratchHarness } from "./scratch.mjs";

it("training validation migration preserves evidence and refuses cache policy and temporal bypasses", async () => {
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-memo-")));
  try {
    await harness.withDatabase(async (admin: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget }, files = await checkMigrationArtifacts();
      await ensurePredictiveRoles(admin);
      const verify = createCatalogVerifier(await loadCatalogContracts(files));
      await runScratchMigrations(admin, { ...target, files: files.slice(0, 19), verify });
      await ensureHarnessSession(admin);
      const artifacts = await openArtifactStore(root, 8_000_000), store = await createLocalPredictiveStore(admin, target, artifacts);
      const seed = await seedCapacity(store, admin, artifacts, 9), examples = [seed.examples[0], seed.examples[8]];
      const original = new Map<string, unknown>();
      // Reference answers come from released SQL before applying any wrapper.
      for (const example of examples) for (const id of [example.featureId, example.labelId]) {
        original.set(id, (await admin.query("SELECT predictive_source_consumer_check($1) AS result", [id])).rows[0].result);
      }
      const ledger = (await admin.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      // Fail after verifying the new catalog: DDL and migration history must roll
      // back together, leaving the existing numerical evidence usable.
      await expect(runScratchMigrations(admin, { ...target, files, verify: async (connection: Client, version: number) => {
        await verify(connection, version);
        if (version === 20) throw new Error("injected-training-validation-final-verification");
      } })).rejects.toThrow("injected-training-validation-final-verification");
      expect((await admin.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(ledger);
      expect((await admin.query("SELECT to_regprocedure('public.predictive_training_memo_ready()') AS f")).rows[0].f).toBeNull();
      expect((await admin.query("SELECT predictive_source_consumer_check($1) AS result", [examples[0].featureId])).rows[0].result).toEqual(original.get(examples[0].featureId));
      expect(await runScratchMigrations(admin, { ...target, files, verify })).toMatchObject({ schemaVersion: 20, executed: [20] });
      const upgraded = (await admin.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      expect(upgraded.slice(0, 19)).toEqual(ledger);
      expect(await runScratchMigrations(admin, { ...target, files, verify })).toMatchObject({ schemaVersion: 20, executed: [] });
      expect((await admin.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
      // Inspect the installed effective bodies, including renamed kernels and
      // transitive helpers. Over-approximate identifiers against real public
      // relations/functions so static SQL, qualified/unqualified calls and
      // literal dynamic SQL are included. Memo infrastructure is excluded from
      // the evidence traversal; its pg_temp state is checked separately below.
      const functions = (await admin.query(`SELECT p.proname,p.prosrc FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`)).rows as { proname: string; prosrc: string }[];
      const relations = new Set<string>((await admin.query(`SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows.map((row) => row.relname));
      const memoDefinition = functions.find((fn) => fn.proname === "predictive_training_memo_ready")!.prosrc;
      const memoTables = [...memoDefinition.matchAll(/'(predictive_[a-z0-9_]+)'/g)].map((match) => match[1]).filter((name) => relations.has(name));
      expect(memoTables).toHaveLength(36);
      const pending = ["predictive_source_plan_v2", "predictive_source_plan_v3", "predictive_source_plan_check",
        "predictive_source_witness_at", "predictive_source_consumer_check"], visited = new Set<string>(), dependencies = new Set<string>();
      while (pending.length) {
        const name = pending.pop()!;
        if (visited.has(name) || name.startsWith("predictive_training_memo_")) continue;
        visited.add(name);
        for (const fn of functions.filter((fn) => fn.proname === name)) {
          for (const [token] of fn.prosrc.matchAll(/\bpredictive_[a-z0-9_]+\b/g)) {
            if (relations.has(token)) dependencies.add(token);
            if (!visited.has(token) && functions.some((candidate) => candidate.proname === token)) pending.push(token);
          }
        }
      }
      expect([...dependencies].filter((table) => !memoTables.includes(table)), "uncaptured memo evidence dependencies").toEqual([]);
      expect(dependencies.has("predictive_rights_decisions")).toBe(true);
      expect(dependencies.has("predictive_compressed_publications")).toBe(true);
      const clock = async () =>
        (await admin.query("SELECT predictive_source_time(clock_timestamp()) AS t")).rows[0].t as string;
      const probe = async (work: () => Promise<void>) => {
        await admin.query("BEGIN");
        try { await admin.query("SELECT predictive_training_read_guard()"); await work(); }
        finally { await admin.query("ROLLBACK"); }
      };
      await probe(async () => {
        for (const [id, expectedRecord] of original) {
          const result = (await admin.query("SELECT predictive_source_consumer_check($1) AS result", [id])).rows[0].result;
          expect(result).toEqual(expectedRecord);
          expect((await admin.query("SELECT predictive_source_consumer_check($1) AS result", [id])).rows[0].result).toEqual(expectedRecord);
        }
        expect((await admin.query("SELECT count(*)::integer AS n FROM pg_temp.predictive_training_memo WHERE kind='consumer'")).rows[0].n).toBe(4);
        expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(true);
        await admin.query("LOCK predictive_source_stats_rows IN ROW EXCLUSIVE MODE");
        expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(false);
        for (const [id, expectedRecord] of original) expect((await admin.query("SELECT predictive_source_consumer_check($1) AS result", [id])).rows[0].result).toEqual(expectedRecord);
      });
      expect((await admin.query("SELECT to_regclass('pg_temp.predictive_training_memo') AS relation")).rows[0].relation).toBeNull();
      // After a committed read, PostgreSQL retains the empty TEMP namespace.
      // Catalog administration keeps its strict no-temp boundary and uses a
      // fresh connection, just like the production migration CLI.
      await admin.query("BEGIN"); await admin.query("SELECT predictive_training_read_guard()");
      await admin.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId]); await admin.query("COMMIT");
      expect((await admin.query("SELECT to_regclass('pg_temp.predictive_training_memo') AS relation")).rows[0].relation).toBeNull();
      await expect(runScratchMigrations(admin, { ...target, files, verify })).rejects.toThrow("catalog-search-path-refused");
      const migrator = new Client(expected);
      try {
        await migrator.connect();
        expect(await runScratchMigrations(migrator, { ...target, files, verify })).toMatchObject({ schemaVersion: 20, executed: [] });
      } finally { await migrator.end(); }
      expect((await admin.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
      await probe(async () => {
        for (const example of examples) {
          const req = { profileId: example.profileId, rawGameId: example.prior.rawGameId,
            rawTeam: example.prior.rawHomeTeam, rawPlayerId: example.playerId, cutoff: seed.cutoff }, t = await clock();
          const plan = (await admin.query("SELECT predictive_source_plan_v2($1,$2) AS plan", [req, t])).rows[0].plan;
          await admin.query("SELECT predictive_source_plan_check($1,$2,false)", [plan, t]);
          await admin.query("SELECT predictive_source_plan_check($1,$2,false)", [plan, t]);
          const forged = { ...plan, reason: "forged", planDigest: digest("forged") };
          await admin.query("SAVEPOINT forgery");
          await expect(admin.query("SELECT predictive_source_plan_check($1,$2,false)", [forged, t])).rejects.toThrow("predictive-source-plan-witness-invalid");
          await admin.query("ROLLBACK TO SAVEPOINT forgery");
          const witnessReq = { profileIds: seed.profiles, entityKeys: ["player-game-stats:" + example.prior.gameId + ":" + example.playerId], cutoff: seed.cutoff };
          const oldReq = { ...witnessReq, cutoff: "2026-10-10T00:00:00.000Z" };
          const witness = (await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [witnessReq, t])).rows[0].w;
          const old = (await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [oldReq, t])).rows[0].w;
          expect(witness.heads).toHaveLength(1); expect(old.heads).toHaveLength(0);
          expect(old).toEqual((await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [oldReq, t])).rows[0].w);
          expect(witness).toEqual((await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [witnessReq, t])).rows[0].w);
          const laterReq = { ...witnessReq, cutoff: new Date(Date.parse(seed.cutoff) + 1).toISOString() };
          const later = (await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [laterReq, t])).rows[0].w;
          expect(later).toEqual({ ...witness, cutoff: laterReq.cutoff });
          expect(later).toEqual((await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [laterReq, t])).rows[0].w);
          const boundary = (await admin.query(`SELECT predictive_source_time(b.recorded_at) AS at,
            predictive_source_time(b.recorded_at-interval '1 millisecond') AS before FROM predictive_source_bindings b
            WHERE b.profile_id=$1 AND b.plan->'binding'->'sourceRequest'->>'rawPlayerId'=$2`, [example.profileId, example.playerId])).rows[0];
          for (const cutoff of [boundary.before, boundary.at]) {
            const atBoundary = { ...witnessReq, cutoff };
            expect((await admin.query("SELECT predictive_source_witness_at($1,$2) AS w", [atBoundary, t])).rows[0].w)
              .toEqual((await admin.query("SELECT predictive_source_witness_at_unmemoized($1,$2) AS w", [atBoundary, t])).rows[0].w);
          }
          await admin.query("SAVEPOINT future_clock");
          await expect(admin.query("SELECT predictive_source_witness_at($1,$2)", [witnessReq, oldReq.cutoff])).rejects.toThrow("source-binding-future-cutoff-refused");
          await admin.query("ROLLBACK TO SAVEPOINT future_clock");
        }
      });
      await probe(async () => {
        await admin.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId]);
        await admin.query(`INSERT INTO predictive_rights_decisions VALUES('memo-own-write',$1,$2,'{}',
          date_trunc('milliseconds',clock_timestamp()),NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','same-transaction refusal')`,
        [examples[0].profileId, "rights-" + examples[0].profileId]);
        expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(false);
        await expect(admin.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId])).rejects.toThrow("predictive-source-plan-rights-profile-invalid");
      });

      const login = "dfs118_memo_" + randomBytes(8).toString("hex");
      await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-memo'`);
      await admin.query(`GRANT predictive_replay TO ${login}`);
      const reader = new Client({ ...expected, user: login, password: "disposable-memo" });
      try {
        await reader.connect();
        for (const sql of ["SELECT predictive_training_memo_get('consumer','[]')", "SELECT predictive_training_memo_put('consumer','[]','{}')",
          "SELECT predictive_source_consumer_check_unmemoized('x')", "SELECT predictive_source_witness_at('{}',clock_timestamp())"]) {
          await expect(reader.query(sql)).rejects.toMatchObject({ code: "42501" });
        }
        await reader.query("BEGIN");
        await reader.query("CREATE TEMP TABLE predictive_training_memo(kind text,key jsonb,value jsonb) ON COMMIT DROP");
        await reader.query("SELECT predictive_training_read_guard()");
        await expect(reader.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId])).rejects.toThrow("training-memo-owner-refused");
        await reader.query("ROLLBACK");
        await reader.query("BEGIN"); await reader.query("SELECT predictive_training_read_guard()");
        expect((await reader.query("SELECT predictive_source_consumer_check($1) AS result", [examples[0].featureId])).rows[0].result).toEqual(original.get(examples[0].featureId));
        await reader.query("SAVEPOINT denied");
        await expect(reader.query("INSERT INTO pg_temp.predictive_training_memo VALUES('consumer','x','[]','{}')")).rejects.toMatchObject({ code: "42501" });
        await reader.query("ROLLBACK TO SAVEPOINT denied"); await reader.query("COMMIT");
        expect((await reader.query("SELECT to_regclass('pg_temp.predictive_training_memo') AS relation")).rows[0].relation).toBeNull();

        // A future use-only revocation changes the epoch without changing rows
        // while the reader holds SHARE locks. Current use checks must refuse.
        await admin.query(`INSERT INTO predictive_rights_decisions VALUES('memo-expiring',$1,$2,'{internal-research,outcome-label}',
          date_trunc('milliseconds',clock_timestamp())+interval '2 seconds',NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','scheduled model-input revocation')`,
        [examples[0].profileId, "rights-" + examples[0].profileId]);
        await reader.query("BEGIN"); await reader.query("SELECT predictive_training_read_guard()");
        await reader.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId]);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        await expect(reader.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId])).rejects.toThrow("source-consumer-rights-refused");
        await reader.query("ROLLBACK");
        await admin.query(`INSERT INTO predictive_rights_decisions VALUES('memo-restored',$1,'memo-expiring','{internal-research,model-input,outcome-label}',
          date_trunc('milliseconds',clock_timestamp()),NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','restore fixture uses')`, [examples[0].profileId]);

        // Exercise the plan and witness caches directly. Unlike consumer hits,
        // neither has a separate fresh access check that could mask a missing
        // epoch in its key. Explicit audited clocks avoid wall-clock sleeps;
        // no evidence or ingestion time is backdated to create these probes.
        const boundary = new Date(Date.parse(await clock()) + 600_000).toISOString();
        const beforeBoundary = new Date(Date.parse(boundary) - 1).toISOString();
        for (const [index, example] of examples.entries()) {
          await admin.query(`INSERT INTO predictive_rights_decisions
            SELECT $1,profile_id,id,'{}',$3,NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','scheduled cache epoch probe'
            FROM predictive_rights_decisions d WHERE profile_id=$2 AND NOT EXISTS
              (SELECT 1 FROM predictive_rights_decisions successor WHERE successor.predecessor_id=d.id)`,
          ["memo-epoch-" + index, example.profileId, boundary]);
        }
        await probe(async () => {
          for (const example of examples) {
            const planRequest = { profileId: example.profileId, rawGameId: example.prior.rawGameId,
              rawTeam: example.prior.rawHomeTeam, rawPlayerId: example.playerId, cutoff: seed.cutoff };
            const witnessRequest = { profileIds: [example.profileId],
              entityKeys: ["player-game-stats:" + example.prior.gameId + ":" + example.playerId], cutoff: seed.cutoff };
            const planFunction = example === examples[0] ? "predictive_source_plan_v2" : "predictive_source_plan_v3";
            for (const name of [planFunction, "predictive_source_witness_at"]) {
              const request = name === "predictive_source_witness_at" ? witnessRequest : planRequest;
              const original = (await admin.query(`SELECT ${name}_unmemoized($1,$2) AS result`, [request, beforeBoundary])).rows[0].result;
              expect((await admin.query(`SELECT ${name}($1,$2) AS result`, [request, beforeBoundary])).rows[0].result).toEqual(original);
              expect((await admin.query(`SELECT ${name}($1,$2) AS result`, [request, beforeBoundary])).rows[0].result).toEqual(original);
              const kind = name === "predictive_source_witness_at" ? "witness" : name === "predictive_source_plan_v2" ? "plan-v2-dispatch" : "plan-v3";
              expect((await admin.query("SELECT count(*)::integer AS n FROM pg_temp.predictive_training_memo WHERE kind=$1 AND key->0=$2::jsonb",
                [kind, request])).rows[0].n).toBe(1);
              if (name === "predictive_source_witness_at") {
                const refused = (await admin.query(`SELECT ${name}_unmemoized($1,$2) AS result`, [request, boundary])).rows[0].result;
                expect(refused).toMatchObject({ reason: "rights-not-in-force", heads: [] });
                expect((await admin.query(`SELECT ${name}($1,$2) AS result`, [request, boundary])).rows[0].result).toEqual(refused);
              } else for (const variant of [name + "_unmemoized", name]) {
                await admin.query("SAVEPOINT epoch_refusal");
                await expect(admin.query(`SELECT ${variant}($1,$2)`, [request, boundary])).rejects.toThrow("predictive-source-plan-rights-profile-invalid");
                await admin.query("ROLLBACK TO SAVEPOINT epoch_refusal");
              }
            }
          }
        });

        // No cached success crosses transactions into a mandatory deletion.
        await reader.query("BEGIN"); await reader.query("SELECT predictive_training_read_guard()");
        await reader.query("SELECT predictive_source_consumer_check($1)", [examples[0].featureId]); await reader.query("COMMIT");
        await store.retain({ id: "memo-delete", reason: "provider-request", authority: "disposable validation proof", decidedAt: await clock(),
          scope: { kind: "source", profileIds: [examples[0].profileId], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" });
        await reader.query("BEGIN"); await reader.query("SELECT predictive_training_read_guard()");
        expect((await reader.query("SELECT predictive_source_consumer_check($1) AS result", [examples[0].featureId])).rows[0].result).toBeNull();
        await reader.query("ROLLBACK");
      } finally {
        await reader.end(); await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`);
      }
      process.stdout.write("training validation safety " + JSON.stringify({ migration: files[19].sha256, parity: "CSV/gzip features and final labels",
        guards: ["private helpers", "forged temp relation", "direct cache write", "cutoff/version separation", "forged plan", "own transaction write",
          "scheduled use revocation", "commit/rollback cache disposal", "mandatory deletion"] }) + "\n");
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 120_000);
