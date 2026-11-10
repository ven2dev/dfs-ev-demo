import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Client } from "pg";
import { equalMassSupport, probabilityAt } from "@dfs-ev/domain/empirical";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { withModelArtifacts, readModelArtifacts, type ModelReadInput } from "../../src/featureStore/modelArtifacts.ts";
import { ModelContextError, resolveModelContext, type ModelContext } from "../../src/featureStore/modelContext.ts";
import { ArtifactGovernanceError } from "../../src/featureStore/artifactGovernanceErrors.ts";
import { deleteSources, deleteDatasets, cleanupDeletedObjects } from "../../src/featureStore/governance.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { compositeFixture } from "./composite-authorization-fixture.ts";
import { governanceExamples } from "./artifact-governance-fixture.ts";
import { assertCompositeWork, installCompositeWorkOracle, measureCompositeWork, observeRightsCalls, unionProfiles } from "./composite-read-work.ts";

const refusal = (code: string) => (e: unknown) => (e instanceof ModelContextError || e instanceof ArtifactGovernanceError) && e.code === code;
test("#231 composite model/served-feature authorization and per-probe work budgets", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [], budgets: unknown[] = [];
  const evidence: Record<string, unknown> = { issue: 231, step: 2, fixture: "synthetic lineage/selection controls; no historical availability claim", probes, budgets };
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs231-composite-"))), store = await openLocalObjectStore(root);
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, createReaderConfig, openWriter }) => {
      for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "231_composite_authorization.sql"])
        await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
      const config = await createReaderConfig(); await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
      await admin.query(`GRANT fs231_model_reader TO ${config.user} WITH INHERIT TRUE, SET FALSE`);
      const client = new Client(config); await client.connect();
      const restore = await installCompositeWorkOracle(admin), rights = observeRightsCalls(client);
      const fixture = compositeFixture(writer, store);
      type World = Awaited<ReturnType<typeof fixture.world>>;
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { probes.push({ name, verdict: "pass", details: await run() }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const math = (input: ModelReadInput) => {
        assert(input.context && input.history); JSON.parse(input.files[0].bytes.toString());
        return { featureId: input.context.feature.featureId, n: input.history.length,
          probabilities: probabilityAt(equalMassSupport(input.history.map(h => h.yards)), 150) };
      };
      // Every invocation independently measures P from the database-owned graph,
      // and asserts the exact rights calls per probe, including refused statements.
      const deliver = async (world: World, options: { context?: ModelContext; afterResolve?: (c: ModelContext) => Promise<void>;
        objects?: Pick<ObjectStore, "get">; calculate?: (input: ModelReadInput) => unknown | Promise<unknown>;
        rightsBatches?: number; statements?: number; gets?: number } = {}) => {
        const profiles = await unionProfiles(admin, world.runId, world.feature.id);
        const work = { statements: 0, checks: 0, gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 };
        rights.reset();
        const observed = { query: async (...args: unknown[]) => {
          work.statements++; const sql = String(args[0]); if (sql.includes("authorize_model_")) work.checks++;
          return Reflect.apply(client.query, client, args);
        } } as Pick<Client, "query">;
        const objects = { get: async (key: string) => { work.gets++; return (options.objects ?? store).get(key); } };
        const original = crypto.createHash;
        crypto.createHash = ((...args: Parameters<typeof original>) => { work.hashes++; return original(...args); }) as typeof original;
        syncBuiltinESMExports();
        try {
          const context = options.context ?? await resolveModelContext(observed, world.feature.request);
          await options.afterResolve?.(context);
          const result = await withModelArtifacts(observed, objects, { runId: world.runId, slots: ["descriptor"], context }, options.calculate ?? math);
          assert.deepEqual(result.authorization.decisions.map(d => d.profileId), profiles);
          assert.deepEqual(result.delivery.decisions.map(d => d.profileId), profiles);
          return result;
        } finally {
          crypto.createHash = original; syncBuiltinESMExports();
          const batches = options.rightsBatches ?? 2;
          assert.equal(rights.profiles.length, batches * profiles.length, "rights-call budget = batches × independently derived union profiles");
          for (const profile of profiles) assert.equal(rights.profiles.filter(p => p === profile).length, batches, "one call per distinct union profile in each check");
          assert.equal(work.statements, options.statements ?? (options.context ? 2 : 3));
          assert.equal(work.checks, work.statements - (options.context ? 0 : 1));
          assert.equal(work.gets, options.gets ?? 1); assert.equal(work.hashes, 0);
          budgets.push({ runId: world.runId, featureId: world.feature.id, unionProfiles: profiles, rightsCalls: rights.profiles.length, rightsBatches: batches, work });
        }
      };
      try {
        await check("every n=2..16 uses exactly 3 SQL / 2 union checks / 1 descriptor GET and 2 × P rights calls", async () => {
          const details = [];
          for (let n = 2; n <= 16; n++) for (const overlap of [false, true]) {
            const world = await fixture.world({ n, overlap }), result = await deliver(world);
            assert.equal((result.value as { n: number }).n, n);
            assert.equal((await admin.query("SELECT count(*)::integer AS n FROM fs138.dataset_members WHERE feature_id=$1", [world.feature.id])).rows[0].n, 0);
            details.push({ n, overlap, budget: budgets.at(-1) });
          }
          return details;
        });
        await check("unlabeled independent input, target-label existence/value independence and two QBs in one game", async () => {
          const world = await fixture.world(), first = await deliver(world);
          assert.equal((await admin.query("SELECT count(*)::integer AS n FROM fs138.outcome_labels")).rows[0].n, 0);
          const label = (await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,
            label_version,evidence_mode,state,reasons,flags,value) VALUES($1,$2,$3,'passing_yards',2025,clock_timestamp(),
            'qb-passing-yards-label-v1','retrospective-reconstruction-v1','usable','{}','{}',1) RETURNING label_id`,
          [world.feature.jobId, world.feature.request.playerId, world.feature.request.gameId])).rows[0].label_id;
          assert.deepEqual((await deliver(world)).value, first.value);
          await admin.query("UPDATE fs138.outcome_labels SET value=9999 WHERE label_id=$1", [label]);
          assert.deepEqual((await deliver(world)).value, first.value);
          await admin.query("DELETE FROM fs138.outcome_labels WHERE label_id=$1", [label]);
          assert.deepEqual((await deliver(world)).value, first.value);
          const another = await fixture.feature([world.served.snapshot], { playerId: "other-QB", gameId: world.feature.request.gameId });
          const second = await deliver({ ...world, feature: another });
          assert.notEqual((second.value as { featureId: string }).featureId, (first.value as { featureId: string }).featureId);
          return { targetIndependent: true, distinctQbs: true, trainingMembers: 0 };
        });
        await check("one profile shared by multiple snapshots is checked once; independent and unselected model lineage stays included", async () => {
          const world = await fixture.world(), extra = await fixture.source();
          const secondDataset = await fixture.graph.dataset([extra.snapshot], "strict-point-in-time-v1");
          const both = { ...world, ...await fixture.publish([world.dataset, secondDataset]) };
          const seed = (await admin.query("SELECT to_jsonb(s) AS s FROM fs138.source_snapshots s WHERE snapshot_id=$1", [world.model.snapshot])).rows[0].s;
          const digest = "e".repeat(64);
          const snapshot = (await admin.query(`INSERT INTO fs138.source_snapshots SELECT (jsonb_populate_record(NULL::fs138.source_snapshots,
            $1::jsonb||jsonb_build_object('snapshot_id',gen_random_uuid(),'sha256',$2::text,'object_key','raw/'||$2::text))).* RETURNING snapshot_id`, [seed, digest])).rows[0].snapshot_id;
          await writer.query("INSERT INTO fs138.feature_inputs VALUES($1,$2)", [world.feature.id, snapshot]);
          await deliver(both);
          await fixture.rights(extra.profile, false);
          await assert.rejects(deliver(both, { rightsBatches: 1, statements: 2, gets: 0 }), refusal("model-current-rights-refused"));
          return { sharedProfileDeduplicated: true, unselectedReportLineageRefused: true, budget: budgets.at(-1) };
        });
        await check("exact reference refuses omitted/extra/forged lineage and metadata, older revision and alternate policy", async () => {
          const world = await fixture.world(), context = await resolveModelContext(client, world.feature.request);
          const malformedIds = [];
          for (const pins of [true, false]) for (const kind of ["missing", "null"] as const) {
            const changed = structuredClone(context) as unknown as { feature: { featureId?: string | null } };
            if (kind === "missing") delete changed.feature.featureId; else changed.feature.featureId = null;
            rights.reset();
            await assert.rejects(client.query("SELECT fs138.authorize_model_context_read($1,ARRAY['descriptor'],$2,$3)",
              [world.runId, pins, changed]), { code: "P2317" });
            assert.equal(rights.profiles.length, 0);
            malformedIds.push({ stage: pins ? "Q1" : "Q2", kind, sqlstate: "P2317", rightsCalls: 0 });
          }
          for (const changed of [
            { ...context, snapshotIds: [] }, { ...context, snapshotIds: [randomUUID()] }, { ...context, snapshotIds: [...context.snapshotIds, randomUUID()] },
            { ...context, feature: { ...context.feature, playerId: "forged" } }, { ...context, feature: { ...context.feature, computedAt: "2020-01-01" } },
          ]) await assert.rejects(deliver(world, { context: changed, rightsBatches: 0, statements: 1, gets: 0 }), refusal("model-context-reference-refused"));
          rights.reset();
          await assert.rejects(client.query("SELECT fs138.authorize_model_context_read($1,ARRAY['descriptor'],false,$2)",
            [world.runId, { ...context, feature: { ...context.feature, playerId: "forged-at-Q2" } }]), { code: "P2317" });
          assert.equal(rights.profiles.length, 0);
          const newer = await fixture.feature([world.served.snapshot], { playerId: world.feature.request.playerId,
            gameId: world.feature.request.gameId, supersedes: world.feature.id, n: 8 });
          const forged = { ...context, request: newer.request };
          await assert.rejects(deliver(world, { context: forged, rightsBatches: 0, statements: 1, gets: 0 }), refusal("model-context-reference-refused"));
          await assert.rejects(deliver(world, { context: { ...context, request: { ...context.request, featureVersion: "unknown" } } as unknown as ModelContext,
            rightsBatches: 0, statements: 1, gets: 0 }), refusal("model-context-unsupported-version"));
          // Old request history remains valid at its own knownAsOf. It is not
          // permission to forge an older selection for a later request.
          await deliver(world, { context });
          return { invalidReferencesRefused: 8, malformedIds, forgedQ2Sqlstate: "P2317", forgedQ2RightsCalls: 0, olderAtOriginalKnownAsOfStillValid: true };
        });
        await check("Q2 retains selected values while refreshing flags; caller/callback mutation cannot narrow private scope", async () => {
          // Real distinct sessions simulate a trusted pool while the request
          // still has exactly one resolver, two checks and one descriptor GET.
          const zones = ["America/Los_Angeles", "Asia/Tokyo", "America/New_York"];
          const zoneWorld = await fixture.world();
          const head = await fixture.feature([zoneWorld.served.snapshot], { playerId: zoneWorld.feature.request.playerId,
            gameId: zoneWorld.feature.request.gameId, supersedes: zoneWorld.feature.id, unavailable: true });
          const sessions = [client, new Client(config), new Client(config)];
          const priorZone = (await client.query("SHOW TimeZone")).rows[0].TimeZone as string;
          let timezoneProof;
          await sessions[1].connect(); await sessions[2].connect();
          const calls = sessions.map(observeRightsCalls);
          try {
            // SETs/SHOWs are fixture setup/inspection, outside measured work.
            for (const [i, session] of sessions.entries()) await session.query("SELECT set_config('TimeZone',$1,false)", [zones[i]]);
            const profiles = await unionProfiles(admin, zoneWorld.runId, zoneWorld.feature.id);
            const work = { statements: 0, checks: 0, gets: 0 }, contexts: ModelContext[] = [];
            const resolve = { query: async (...args: unknown[]) => {
              work.statements++; return Reflect.apply(sessions[0].query, sessions[0], args);
            } } as Pick<Client, "query">;
            const context = await resolveModelContext(resolve, zoneWorld.feature.request);
            const checks = { query: async (...args: unknown[]) => {
              const session = sessions[++work.checks]; work.statements++;
              const result = await Reflect.apply(session.query, session, args);
              contexts.push(structuredClone(result.rows[0].access.context)); return result;
            } } as Pick<Client, "query">;
            const result = await withModelArtifacts(checks, { get: key => { work.gets++; return store.get(key); } },
              { runId: zoneWorld.runId, slots: ["descriptor"], context }, math);
            assert.equal((result.value as { featureId: string }).featureId, zoneWorld.feature.id);
            for (const c of [context, ...contexts]) {
              assert.deepEqual(c.feature, context.feature); assert.deepEqual(c.request, context.request);
              assert.deepEqual(c.selection, context.selection); assert.deepEqual(c.snapshotIds, context.snapshotIds);
              assert.equal(c.freshness.headId, head.id); assert.equal(c.freshness.stale, true);
              assert.equal(c.freshness.checkpoint, context.freshness.checkpoint);
              assert.equal(c.freshness.computedAt, context.freshness.computedAt);
              for (const value of [c.request.knownAsOf, c.feature.cutoff, c.feature.checkpoint, c.feature.computedAt,
                c.freshness.checkpoint, c.freshness.computedAt, c.freshness.observedAt]) assert.match(value, /\+00:00$/);
            }
            assert(Date.parse(contexts[0].freshness.observedAt) >= Date.parse(context.freshness.observedAt));
            assert(Date.parse(contexts[1].freshness.observedAt) >= Date.parse(contexts[0].freshness.observedAt));
            for (const receipt of [result.authorization, result.delivery]) {
              assert.match(receipt.checkedAt, /\+00:00$/); assert.deepEqual(receipt.decisions.map(d => d.profileId), profiles);
            }
            assert.deepEqual(work, { statements: 3, checks: 2, gets: 1 });
            assert.equal(calls[0].profiles.length, 0);
            for (const observed of calls.slice(1)) assert.deepEqual([...observed.profiles].sort(), profiles);
            const restoredZones = await Promise.all(sessions.map(async session => (await session.query("SHOW TimeZone")).rows[0].TimeZone));
            assert.deepEqual(restoredZones, zones);
            const settings = (await admin.query(`SELECT proname,proconfig FROM pg_proc WHERE oid=ANY(ARRAY[
              'fs138.resolve_model_context(text,text,text,text,text,timestamptz)'::regprocedure,
              'fs138.authorize_model_scope(uuid,text[],boolean,jsonb)'::regprocedure,
              'fs138.authorize_model_context_read(uuid,text[],boolean,jsonb)'::regprocedure]) ORDER BY proname`)).rows;
            assert.equal(settings.length, 3); for (const row of settings) assert(row.proconfig.includes("TimeZone=UTC"));
            timezoneProof = { zones, restoredZones, settings, work, profiles, rightsCalls: calls.flatMap(c => c.profiles).length,
              context, q1: contexts[0], q2: contexts[1], receipts: [result.authorization, result.delivery] };
          } finally {
            calls.forEach(c => c.close()); await client.query("SELECT set_config('TimeZone',$1,false)", [priorZone]);
            await Promise.all(sessions.slice(1).map(session => session.end()));
          }
          const world = await fixture.world(), reference = await resolveModelContext(client, world.feature.request), selected = reference.feature.featureId;
          const pending = await fixture.feature([world.served.snapshot], { playerId: world.feature.request.playerId,
            gameId: world.feature.request.gameId, supersedes: world.feature.id, unavailable: true, running: true });
          const request = { runId: world.runId, slots: ["descriptor" as const], context: reference };
          const result = await deliver(world, { context: reference, calculate: async input => {
            const output = math(input);
            reference.snapshotIds.length = 0; reference.feature.featureId = randomUUID(); request.runId = randomUUID(); request.slots.length = 0;
            input.context!.request.playerId = "callback-mutated"; input.context!.snapshotIds.length = 0; input.history!.length = 0;
            await writer.query("UPDATE fs138.job_runs SET status='succeeded',finished_at=clock_timestamp() WHERE job_id=$1", [pending.jobId]);
            return output;
          } });
          assert.equal(result.context?.feature.featureId, selected); assert.deepEqual(result.context?.snapshotIds, [world.served.snapshot]);
          assert.equal(result.context?.freshness.stale, true); assert.equal(result.context?.freshness.superseded, true);
          assert.equal((result.value as { n: number }).n, 3);
          return { timezoneProof, immutableScope: true, originalValues: true, updatedFlags: result.context?.freshness };
        });
        await check("pruning the selected revision refuses instead of returning an older still-valid feature", async () => {
          const details = [];
          for (const point of ["resolve", "calculate"] as const) {
          const world = await fixture.world();
          const newer = await fixture.feature([world.served.snapshot], { playerId: world.feature.request.playerId,
            gameId: world.feature.request.gameId, supersedes: world.feature.id, n: 8 });
          const prune = async () => {
            await admin.query("DELETE FROM fs138.feature_inputs WHERE feature_id=$1", [newer.id]);
            await admin.query("DELETE FROM fs138.feature_values WHERE feature_id=$1", [newer.id]);
          };
          await assert.rejects(deliver({ ...world, feature: newer }, { rightsBatches: point === "resolve" ? 0 : 1,
            ...(point === "resolve" ? { afterResolve: prune, statements: 2, gets: 0 }
              : { calculate: async (input: ModelReadInput) => { const value = math(input); await prune(); return value; } })
          }), refusal("model-read-status-refused"));
          assert.equal((await resolveModelContext(client, world.feature.request)).feature.featureId, world.feature.id);
          details.push({ point, oldFeatureStillExists: true, substitutedOldValueDelivered: false,
            typedRefusal: "model-read-status-refused", budget: budgets.at(-1) });
          }
          return details;
        });
        await check("independent model/feature revocation before Q1, during GET or calculation refuses with measured per-probe calls", async () => {
          const details = [];
          for (const side of ["model", "served"] as const) for (const point of ["resolve", "get", "calculate"]) {
            const world = await fixture.world(), change = () => fixture.rights(world[side].profile, false).then(() => {});
            const options = point === "resolve" ? { afterResolve: change, rightsBatches: 1, statements: 2, gets: 0 }
              : point === "get" ? { objects: { get: async (key: string) => { const b = await store.get(key); await change(); return b; } } }
              : { calculate: async (input: ModelReadInput) => { const value = math(input); await change(); return value; } };
            let delivered = false;
            await assert.rejects(deliver(world, options).then(v => { delivered = true; return v; }), refusal("model-current-rights-refused"));
            assert.equal(delivered, false); details.push({ side, point, delivered, budget: budgets.at(-1) });
          }
          return details;
        });
        await check("both deletion APIs and independent feature deletion refuse without reselection or delivery", async () => {
          const details = [];
          for (const side of ["model-source", "model-dataset", "feature-source"] as const) for (const point of ["resolve", "get", "calculate"]) {
            const world = await fixture.world();
            const change = async () => {
              if (side === "model-dataset") await deleteDatasets(writer, [world.dataset.datasetId], "#231 race", 300);
              else await deleteSources(writer, [side === "model-source" ? world.model.snapshot : world.served.snapshot], "#231 race", 300);
            };
            const options = { rightsBatches: point === "resolve" ? 0 : 1,
              ...(point === "resolve" ? { afterResolve: change, statements: 2, gets: 0 }
                : point === "get" ? { objects: { get: async (key: string) => { const b = await store.get(key); await change(); return b; } } }
                : { calculate: async (input: ModelReadInput) => { const v = math(input); await change(); return v; } }) };
            await assert.rejects(deliver(world, options), refusal("model-read-status-refused"));
            if (side === "feature-source") assert.equal((await admin.query("SELECT invalidated_at FROM fs138.model_runs WHERE run_id=$1", [world.runId])).rows[0].invalidated_at, null);
            details.push({ side, point, budget: budgets.at(-1) });
          }
          return details;
        });
        await check("empty/pruned/changed lineage and missing feature or source state fail closed at both boundaries", async () => {
          const details = [];
          for (const kind of ["empty", "extra", "missing", "source-deleted"] as const) for (const point of ["resolve", "calculate"]) {
            const world = await fixture.world(), extra = await fixture.source();
            const change = async () => {
              if (kind === "empty" || kind === "missing") {
                await admin.query("DELETE FROM fs138.feature_inputs WHERE feature_id=$1", [world.feature.id]);
                if (kind === "missing") await admin.query("DELETE FROM fs138.feature_values WHERE feature_id=$1", [world.feature.id]);
              } else if (kind === "extra") await writer.query("INSERT INTO fs138.feature_inputs VALUES($1,$2)", [world.feature.id, extra.snapshot]);
              else if (kind === "source-deleted") await admin.query("UPDATE fs138.source_snapshots SET deleted_at=clock_timestamp() WHERE snapshot_id=$1", [world.served.snapshot]);
            };
            const code = kind === "extra" ? "model-context-reference-refused" : "model-read-status-refused";
            await assert.rejects(deliver(world, { rightsBatches: point === "resolve" ? 0 : 1,
              ...(point === "resolve" ? { afterResolve: change, statements: 2, gets: 0 }
                : { calculate: async (input: ModelReadInput) => { const v = math(input); await change(); return v; } }) }), refusal(code));
            details.push({ kind, point, budget: budgets.at(-1) });
          }
          const world = await fixture.world(), running = await fixture.source(false);
          const feature = await fixture.feature([running.snapshot]);
          await assert.rejects(deliver({ ...world, served: running, feature }, { rightsBatches: 0, statements: 2, gets: 0 }), refusal("model-context-lineage-refused"));
          details.push({ kind: "unfinished-source-job", point: "Q1", budget: budgets.at(-1) });
          return details;
        });
        await check("database work is identical at matched n=2/16 graphs; observer detects hidden scans/writes", async () => {
          const world = await fixture.world({ n: 2 }), matched = [];
          for (const n of [2, 16]) {
            const history = Array.from({ length: n }, (_, i) => ({ gameId: `synthetic-prior-${i}`, kickoff: "2024-01-01T00:00:00Z", yards: i }));
            await admin.query("UPDATE fs138.feature_values SET history=$2,sample_size=$3 WHERE feature_id=$1", [world.feature.id, JSON.stringify(history), n]);
            const context = await resolveModelContext(client, world.feature.request), profiles = await unionProfiles(admin, world.runId, world.feature.id);
            rights.reset();
            const q1 = await measureCompositeWork(client, world.runId, context, true), q2 = await measureCompositeWork(client, world.runId, context, false);
            assertCompositeWork(q1); assertCompositeWork(q2);
            assert.equal(rights.profiles.length, 2 * profiles.length);
            for (const p of profiles) assert.equal(rights.profiles.filter(x => x === p).length, 2);
            matched.push({ n, q1, q2, profiles, rightsCalls: rights.profiles.length });
          }
          assert.deepEqual(matched[0].q1, matched[1].q1); assert.deepEqual(matched[0].q2, matched[1].q2);
          const context = await resolveModelContext(client, world.feature.request);
          const scan = await measureCompositeWork(client, world.runId, context, true, "scan");
          assert(scan.find(r => r.table === "feature_values")!.seq_tup_read > 0);
          const dml = await measureCompositeWork(client, world.runId, context, true, "dml");
          assert.throws(() => assertCompositeWork(dml), /reader DML/);
          const sql = (await admin.query(`SELECT pg_get_functiondef('fs138.authorize_model_scope(uuid,text[],boolean,jsonb)'::regprocedure) AS sql`)).rows[0].sql;
          assert(!/jsonb_array_elements|unnest\([^)]*history|LOOP|FOREACH|FOR (UPDATE|SHARE)|pg_advisory/i.test(sql));
          return { matched, negativeControls: { scanDetected: true, writeDetected: true }, historyExpansion: 0 };
        });
        await check("paused GET and calculation hold no reader transaction/locks and concurrent deletion commits", async () => {
          const details = [];
          for (const point of ["get", "calculate"]) {
            const world = await fixture.world(), paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
            const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const pause = async () => { paused.resolve(); await resume.promise; };
            const pending = deliver(world, { rightsBatches: 1,
              ...(point === "get" ? { objects: { get: async (key: string) => { const b = await store.get(key); await pause(); return b; } } }
                : { calculate: async (input: ModelReadInput) => { const v = math(input); await pause(); return v; } }) });
            const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
            await Promise.race([paused.promise, outcome.then(r => { throw r.error ?? new Error("finished without pause"); })]);
            const concurrent = await openWriter();
            try {
              const activity = (await admin.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
              assert.deepEqual(activity, { state: "idle", xact_start: null });
              const locks = (await admin.query("SELECT locktype,mode FROM pg_locks WHERE pid=$1", [pid])).rows;
              assert.deepEqual(locks, []);
              await concurrent.query("SET statement_timeout='2s'");
              await deleteDatasets(concurrent, [world.dataset.datasetId], "paused #231 reader", 300);
              details.push({ point, activity, locks, concurrentDeletionCommitted: true });
            } finally { resume.resolve(); }
            assert(refusal("model-read-status-refused")((await outcome).error));
          }
          return details;
        });
        await check("missing bytes, callback failures and Q2 connection loss never deliver a private result", async () => {
          const world = await fixture.world(); let delivered = false;
          await assert.rejects(deliver(world, { objects: { get: async () => { throw new Error("missing"); } }, rightsBatches: 1, statements: 2 })
            .then(v => { delivered = true; return v; }), refusal("model-artifact-unavailable"));
          const failed = new Error("private calculation failure");
          await assert.rejects(deliver(world, { calculate: () => { throw failed; }, rightsBatches: 1, statements: 2 }), e => e === failed);
          const context = await resolveModelContext(client, world.feature.request), profiles = await unionProfiles(admin, world.runId, world.feature.id);
          const lost = new Error("Q2 socket lost"); let queries = 0; rights.reset();
          const failQ2 = { query: async (...args: unknown[]) => { if (++queries === 2) throw lost; return Reflect.apply(client.query, client, args); } } as Pick<Client, "query">;
          await assert.rejects(withModelArtifacts(failQ2, store, { runId: world.runId, slots: ["descriptor"], context }, math)
            .then(v => { delivered = true; return v; }), e => e === lost);
          assert.equal(rights.profiles.length, profiles.length); assert.equal(queries, 2); assert.equal(delivered, false);
          return { delivered, missingBytesWithheld: true, callbackFailureWithheld: true, lostQ2Withheld: true };
        });
        await check("model-only reads keep two queries; narrow LOGIN has no unscoped/private-core or writer escape", async () => {
          const world = await fixture.world(), profiles = await unionProfiles(admin, world.runId, world.feature.id);
          let statements = 0;
          const broadRights = observeRightsCalls(reader);
          try {
            const result = await readModelArtifacts({ query: async (...args: unknown[]) => {
              statements++; return Reflect.apply(reader.query, reader, args);
            } } as Pick<Client, "query">, store, { runId: world.runId, slots: ["descriptor"] });
            assert.equal(statements, 2); assert.equal(result.value.files.length, 1);
            const modelProfiles = (await admin.query(`SELECT DISTINCT s.profile_id FROM fs138.model_run_datasets p
              JOIN fs138.dataset_inputs i USING(dataset_id) JOIN fs138.source_snapshots s USING(snapshot_id) WHERE run_id=$1`, [world.runId])).rows;
            assert.equal(broadRights.profiles.length, 2 * modelProfiles.length);
          } finally { broadRights.close(); }
          for (const sql of ["SELECT * FROM fs138.feature_values LIMIT 0", "SELECT * FROM fs138.outcome_labels LIMIT 0",
            "SELECT * FROM fs138.norm_player_game_stats LIMIT 0", "SELECT * FROM fs138.model_runs LIMIT 0",
            "SELECT fs138.authorize_model_read(NULL,ARRAY['descriptor'],true)",
            "SELECT fs138.authorize_model_scope(NULL,ARRAY['descriptor'],true,NULL)",
            "SELECT fs138.publish_model_run('{}','[]')", "SELECT fs138.delete_sources('{}','refuse',0)",
            "SET ROLE fs138_reader", "SET ROLE fs231_model_reader", "SET ROLE fs138_pipeline_writer"])
            await assert.rejects(client.query(sql), { code: "42501" });
          for (const context of [null, [], {}, { request: {} }])
            await assert.rejects(client.query("SELECT fs138.authorize_model_context_read($1,ARRAY['descriptor'],true,$2)", [world.runId, JSON.stringify(context)]), { code: "P2317" });
          const publicFunctions = (await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
            LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE n.nspname='fs138' AND p.proname IN ('authorize_model_scope','authorize_model_context_read','authorize_model_read')
            AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows;
          assert.deepEqual(publicFunctions, []);
          await deliver(world);
          return { modelOnlySql: statements, narrowPublicCoreExecute: false, unionProfileCount: profiles.length };
        });
        await check("common core preserves model-only 0/2504-member and selected-report contracts", async () => {
          const source = await fixture.source(), rows = await governanceExamples(writer, source, 2504), results = [];
          for (const count of [0, 2504]) {
            const dataset = await fixture.graph.dataset([source.snapshot], "retrospective-reconstruction-v1", count ? rows : []);
            const published = await fixture.publish([dataset]);
            for (const slots of [["descriptor"] as const, ["descriptor", "retrospective-reconstruction-v1"] as const]) {
              const broadRights = observeRightsCalls(reader); let statements = 0, gets = 0;
              try {
                const result = await readModelArtifacts({ query: async (...args: unknown[]) => {
                  statements++; return Reflect.apply(reader.query, reader, args);
                } } as Pick<Client, "query">, { get: key => { gets++; return store.get(key); } }, { runId: published.runId, slots });
                assert.equal(statements, 2); assert.equal(gets, slots.length); assert.equal(result.value.datasets[0].rowCount, count);
                const profiles = (await admin.query(`SELECT DISTINCT s.profile_id FROM fs138.model_run_datasets p
                  JOIN fs138.dataset_inputs i USING(dataset_id) JOIN fs138.source_snapshots s USING(snapshot_id) WHERE run_id=$1`, [published.runId])).rows;
                assert.equal(broadRights.profiles.length, 2 * profiles.length);
                results.push({ rows: count, selectedFiles: slots.length, statements, gets, unionProfiles: profiles.length, rightsCalls: broadRights.profiles.length });
              } finally { broadRights.close(); }
            }
          }
          return results;
        });
        await check("shared-retained removal intent still permits unaffected live-run delivery through the common core", async () => {
          const world = await fixture.world(), extra = await fixture.source();
          const strict = await fixture.graph.dataset([extra.snapshot], "strict-point-in-time-v1");
          const sharedReport = world.objects.find(o => o.slot === "retrospective-reconstruction-v1")!;
          const files = await fixture.graph.objects([strict, world.dataset], [await fixture.graph.report(strict),
            { objectKey: sharedReport.objectKey, sha256: sharedReport.fileSha256, byteSize: sharedReport.byteSize }]);
          const identity = (await writer.query("SELECT identity FROM fs138.model_runs WHERE run_id=$1", [world.runId])).rows[0].identity;
          const affected = (await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)", [identity, JSON.stringify(files)])).rows[0].run_id;
          await deleteSources(writer, [extra.snapshot], "#231 shared control", 0); await cleanupDeletedObjects(writer, store);
          const intent = (await writer.query("SELECT outcome FROM fs138.object_removals WHERE object_key=$1", [sharedReport.objectKey])).rows[0];
          assert.equal(intent.outcome, "shared-retained");
          await assert.rejects(deliver({ ...world, runId: affected }, { rightsBatches: 0, statements: 2, gets: 0 }), refusal("model-read-status-refused"));
          await deliver(world);
          return { outcome: intent.outcome, affectedRefused: true, unaffectedDelivered: true };
        });
      } finally { rights.close(); await client.end(); await restore(); }
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.error = String(error); throw error; }
  finally {
    const paths = ["packages/db/proposals/231_composite_authorization.sql", "services/pipeline/src/featureStore/modelArtifacts.ts",
      "services/pipeline/src/featureStore/modelContext.ts", "services/pipeline/tests/feature-store/composite-authorization-fixture.ts",
      "services/pipeline/tests/feature-store/composite-read-work.ts", "services/pipeline/tests/feature-store/composite-authorization.check.mts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    if (process.env.FS231_COMPOSITE_EVIDENCE) await writeFile(process.env.FS231_COMPOSITE_EVIDENCE,
      JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  }
});
