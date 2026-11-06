import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { Client, type QueryConfig } from "pg";
import { predictQbModel, type PredictionRead, type PredictionRequest } from "@dfs-ev/pipeline/feature-store/predict";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { deleteSources, deleteDatasets } from "../../src/featureStore/governance.ts";
import { resolveModelContext, type ModelContext } from "../../src/featureStore/modelContext.ts";
import { readModelArtifacts } from "../../src/featureStore/modelArtifacts.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { predictionDatabaseFixture } from "./prediction-db-fixture.ts";
import { assertCompositeWork, installCompositeWorkOracle, measureCompositeWork, observeRightsCalls,
  unionProfiles } from "./composite-read-work.ts";
import { readCounterDelta, type ReadCounters } from "./artifact-read-work.ts";

const refused = (read: PredictionRead, reason: string, disposition = "reusable") => {
  const response = { status: "unavailable", reason };
  assert.deepEqual(read.response, response); assert.deepEqual(JSON.parse(read.serialized), response);
  assert.equal(read.connectionDisposition, disposition);
};
const available = (read: PredictionRead) => {
  assert.equal(read.response.status, "available", JSON.stringify(read.response));
  if (read.response.status !== "available") throw new Error("expected available prediction");
  assert.deepEqual(JSON.parse(read.serialized), read.response);
  assert(!("connectionDisposition" in read.response));
  return read.response;
};
type BoundedQuery = QueryConfig & { query_timeout: number };

test("#167 actual handler: composite work, point-in-time delivery, withdrawal and interruption", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [], budgets: unknown[] = [];
  const evidence: Record<string, unknown> = { issue: 168, step: 0, kind: "local-prediction-behavior",
    fixture: "Synthetic producer/registry controls on loopback PostgreSQL 18.6 / 512 MiB; not real-fixture speed qualification", probes, budgets };
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs167-handler-"))), store = await openLocalObjectStore(root);
  const sessions: Client[] = [];
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, createReaderConfig, openWriter }) => {
      for (const name of ["165_model_manifests.sql", "166_artifact_governance.sql", "229_mandatory_recovery.sql", "231_composite_authorization.sql"])
        await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)), "utf8"));
      const config = { ...await createReaderConfig(), statement_timeout: 300 }; await admin.query(`REVOKE fs138_reader FROM ${config.user}`);
      await admin.query(`GRANT fs231_model_reader TO ${config.user} WITH INHERIT TRUE, SET FALSE`);
      const open = async () => { const c = new Client(config); c.on("error", () => {}); sessions.push(c); await c.connect(); return c; };
      const client = await open(), fixture = predictionDatabaseFixture(writer, store);
      const restore = await installCompositeWorkOracle(admin);
      type World = Awaited<ReturnType<typeof fixture.world>>;
      type Hook = () => void | Promise<void>;
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { probes.push({ name, verdict: "pass", details: await run() }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const invoke = async (world: World, options: { session?: Client; request?: PredictionRequest;
        afterResolve?: Hook; duringGet?: Hook; beforeQ2?: Hook; mutateQ1?: (access: Record<string, unknown>) => void;
        forge?: boolean; expected?: { sql: number; checks: number; gets: number; batches: number };
        measure?: boolean; signal?: AbortSignal; deadlineAt?: number; sleepAt?: string; loseQ2?: boolean; cancelSql?: AbortController;
        objects?: { get: (key: string) => Promise<Buffer> } } = {}) => {
        const session = options.session ?? client, observer = observeRightsCalls(session);
        const profiles = await unionProfiles(admin, world.runId, world.feature.id);
        const work = { sql: 0, checks: 0, gets: 0, heads: 0, puts: 0, deletes: 0, lists: 0, hashes: 0 };
        const trace: string[] = [], counters: { q1?: ReadCounters; q2?: ReadCounters } = {};
        const observations: { q1?: ModelContext; q2?: ModelContext; receipts: unknown[]; queryTimeouts: number[] } = { receipts: [], queryTimeouts: [] };
        let control = false;
        const change = async (hook?: Hook) => { control = true; try { await hook?.(); } finally { control = false; } };
        const observed = { query: async (query: BoundedQuery) => {
          const stage = query.text.includes("resolve_model_context") ? "context" : query.values?.[2] ? "Q1" : "Q2";
          work.sql++; if (stage !== "context") work.checks++; trace.push(stage);
          assert(Number.isInteger(query.query_timeout) && query.query_timeout! > 0 && query.query_timeout! <= 300);
          observations.queryTimeouts.push(query.query_timeout!);
          if (stage === "Q2") await change(options.beforeQ2);
          let actual = query;
          if (options.forge && stage === "Q1") {
            const scope = JSON.parse(String(query.values![3])); scope.feature.sampleSize++;
            actual = { ...query, values: [...query.values!.slice(0, 3), JSON.stringify(scope)] };
          }
          if (options.sleepAt === stage) actual = { ...query, text: "SELECT pg_sleep(10)", values: [] };
          else if (options.measure && stage !== "context") actual = { ...query,
            text: "SELECT fs138.measure_composite_read($1,$2,$3,NULL) AS measured",
            values: [query.values![0], JSON.parse(String(query.values![3])), query.values![2]] };
          const pending = session.query(actual);
          if (options.sleepAt === stage && options.cancelSql) setImmediate(() => options.cancelSql!.abort());
          const result = await pending;
          if (options.measure && stage !== "context") {
            const m = result.rows[0].measured;
            assert.deepEqual(m.forbiddenLocks, []);
            const delta = readCounterDelta(m.before, m.after); assertCompositeWork(delta);
            counters[stage === "Q1" ? "q1" : "q2"] = delta;
            result.rows = [{ access: m.result }];
          }
          if (stage === "context") await change(options.afterResolve);
          else {
            const access = result.rows[0]?.access;
            if (access) {
              observations[stage === "Q1" ? "q1" : "q2"] = structuredClone(access.context);
              observations.receipts.push(structuredClone(access.authorization));
              if (stage === "Q1") options.mutateQ1?.(access);
            }
            if (stage === "Q2" && options.loseQ2) throw Object.assign(new Error("synthetic lost final SQL reply"), { code: "08006" });
          }
          return result;
        } } as Pick<Client, "query">;
        const objects = new Proxy({ get: async (key: string) => {
          work.gets++; trace.push("GET:descriptor"); assert.equal(key, world.descriptor.objectKey);
          const bytes = await (options.objects ?? store).get(key); await change(options.duringGet); return bytes;
        } }, { get(target, property) {
          if (["head", "putIfAbsent", "delete", "list"].includes(String(property))) return () => {
            throw new Error("unexpected non-GET storage work: " + String(property));
          };
          return Reflect.get(target, property);
        } });
        const originalHash = crypto.createHash;
        crypto.createHash = ((...args: Parameters<typeof originalHash>) => {
          if (!control) work.hashes++; return originalHash(...args);
        }) as typeof originalHash; syncBuiltinESMExports();
        try {
          const result = await predictQbModel(observed, objects, options.request ?? world.request,
            { signal: options.signal, deadlineAt: options.deadlineAt });
          // This harness owns the session; the handler only reports disposition.
          if (result.connectionDisposition === "discard") void session.end().catch(() => {});
          const expected = options.expected ?? { sql: 3, checks: 2, gets: 1, batches: 2 };
          assert.equal(work.sql, expected.sql); assert.equal(work.checks, expected.checks); assert.equal(work.gets, expected.gets);
          assert.equal(work.hashes, 0); assert.equal(observer.profiles.length, expected.batches * profiles.length,
            "per-probe rights budget = completed batches × independently derived union profile count");
          for (const p of profiles) assert.equal(observer.profiles.filter(x => x === p).length, expected.batches);
          const budget = { runId: world.runId, featureId: world.feature.id, profiles, rightsCalls: observer.profiles.length,
            expected, work, trace, available: result.response.status === "available" };
          budgets.push(budget);
          return { result, budget, counters, observations };
        } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); observer.close(); }
      };
      try {
        await check("every n=2..16 and overlapping/independent lineage uses 3 SQL / 2 checks / 1 descriptor GET / 2P rights calls", async () => {
          const allN = [];
          for (let n = 2; n <= 16; n++) for (const overlap of [false, true]) {
            const world = await fixture.world({ n, overlap }), output = await invoke(world), response = available(output.result);
            assert.equal(response.forecast.sampleCount, n); assert.equal(response.context.feature.sampleSize, n);
            assert.deepEqual(output.budget.trace, ["context", "Q1", "GET:descriptor", "Q2"]);
            assert.equal((await admin.query("SELECT count(*)::int AS n FROM fs138.dataset_members WHERE feature_id=$1", [world.feature.id])).rows[0].n, 0);
            allN.push({ n, overlap, budget: output.budget });
          }
          return allN;
        });
        await check("Q1 declared sampleSize drives math; mismatched history refuses before Q2 with no partial fields", async () => {
          const world = await fixture.world();
          const output = await invoke(world, { mutateQ1: access => { (access.history as unknown[]).pop(); },
            expected: { sql: 2, checks: 1, gets: 1, batches: 1 } });
          refused(output.result, "materialization-refused"); return output.budget;
        });
        await check("new permitted revisions during GET retain selected values but refresh Q2 flags and distinct receipt decisions", async () => {
          const world = await fixture.world(), original = available((await invoke(world)).result);
          const output = await invoke(world, { duringGet: async () => {
            await fixture.feature([world.served.snapshot], { playerId: world.request.playerId, gameId: world.request.gameId,
              supersedes: world.feature.id, unavailable: true });
            await fixture.rights(world.model.profile, true); await fixture.rights(world.served.profile, true);
          } });
          const response = available(output.result);
          assert.deepEqual(response.forecast, original.forecast); assert.equal(response.context.feature.featureId, world.feature.id);
          assert.equal(output.observations.q1!.freshness.stale, false);
          assert.equal(response.context.freshness.stale, true); assert.equal(response.context.freshness.superseded, true);
          assert.deepEqual(response.context, output.observations.q2);
          assert.deepEqual(response.authorization, output.observations.receipts[0]); assert.deepEqual(response.delivery, output.observations.receipts[1]);
          assert.notDeepEqual(response.authorization, response.delivery);
          for (const first of response.authorization.decisions)
            assert.notEqual(first.decisionId, response.delivery.decisions.find(d => d.profileId === first.profileId)!.decisionId);
          return { selected: world.feature.id, q1: output.observations.q1, q2: response.context,
            receipts: [response.authorization, response.delivery], budget: output.budget };
        });
        await check("target labels never affect availability or probabilities and same-game QBs remain distinct", async () => {
          const world = await fixture.world(), baseline = available((await invoke(world)).result);
          const label = (await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,
            label_version,evidence_mode,state,reasons,flags,value) VALUES($1,$2,$3,'passing_yards',2025,clock_timestamp(),
            'qb-passing-yards-label-v1','retrospective-reconstruction-v1','usable','{}','{}',1) RETURNING label_id`,
          [world.feature.jobId, world.request.playerId, world.request.gameId])).rows[0].label_id;
          assert.deepEqual(available((await invoke(world)).result).forecast, baseline.forecast);
          await admin.query("UPDATE fs138.outcome_labels SET value=9999 WHERE label_id=$1", [label]);
          assert.deepEqual(available((await invoke(world)).result).forecast, baseline.forecast);
          await admin.query("DELETE FROM fs138.outcome_labels WHERE label_id=$1", [label]);
          assert.deepEqual(available((await invoke(world)).result).forecast, baseline.forecast);
          const other = await fixture.feature([world.served.snapshot], { playerId: "QB-B", gameId: world.request.gameId });
          const response = available((await invoke({ ...world, feature: other,
            request: { ...world.request, ...other.request } })).result);
          assert.equal(response.gameId, baseline.gameId); assert.notEqual(response.playerId, baseline.playerId);
          assert.notEqual(response.context.feature.featureId, baseline.context.feature.featureId);
          return { labelsCreatedChangedRemoved: true, sameGameDistinct: true };
        });
        await check("mode compatibility permits both modes and explicitly refuses retrospective serving under a strict-only run", async () => {
          const strict = "strict-point-in-time-v1", retro = "retrospective-reconstruction-v1", details = [];
          const mismatch = await fixture.world({ modes: [strict], mode: retro });
          refused((await invoke(mismatch, { expected: { sql: 2, checks: 1, gets: 1, batches: 1 } })).result, "evidence-mode-mismatch");
          for (const mode of [strict, retro] as const) {
            const world = await fixture.world({ modes: [strict, retro], mode });
            assert.equal(available((await invoke(world)).result).model.evidenceMode, mode); details.push(mode);
          }
          return { mismatchRefused: true, accepted: details };
        });
        await check("knowledge time uses job completion and preserves the pinned previous answer after completion", async () => {
          const world = await fixture.world(), pending = await fixture.feature([world.served.snapshot], {
            playerId: world.request.playerId, gameId: world.request.gameId, supersedes: world.feature.id, n: 8, running: true });
          const between = await fixture.clock(), request = { ...world.request, knownAsOf: between };
          const before = available((await invoke(world, { request })).result);
          await writer.query("UPDATE fs138.job_runs SET status='succeeded',finished_at=clock_timestamp() WHERE job_id=$1", [pending.jobId]);
          const after = available((await invoke(world, { request })).result);
          assert.equal(before.context.feature.featureId, world.feature.id); assert.deepEqual(after.forecast, before.forecast);
          assert.equal(after.context.feature.featureId, before.context.feature.featureId); assert(after.context.freshness.superseded);
          const latest = { ...world, feature: { ...pending, request: { ...pending.request, knownAsOf: await fixture.clock() } },
            request: { ...request, knownAsOf: await fixture.clock() } };
          assert.equal(available((await invoke(latest)).result).context.feature.featureId, pending.id);
          const unavailable = await fixture.feature([world.served.snapshot], { playerId: world.request.playerId,
            gameId: world.request.gameId, supersedes: pending.id, unavailable: true });
          const lastValid = available((await invoke(latest, { request: { ...latest.request, knownAsOf: unavailable.request.knownAsOf } })).result);
          assert.equal(lastValid.context.feature.featureId, pending.id); assert(lastValid.context.selection.lastValid);
          assert(lastValid.context.freshness.stale && lastValid.context.freshness.superseded);
          return { pendingComputedAt: pending.computedAt, between, before: before.context, after: after.context, lastValid: lastValid.context };
        });
        await check("P2311–P2316 initial diagnostics remain distinct and refuse without partial results", async () => {
          const world = await fixture.world(), details = [];
          const controls: [Partial<PredictionRequest>, string, number][] = [
            [{ knownAsOf: "bad" }, "model-context-request-refused", 0],
            [{ featureVersion: "unknown" as PredictionRequest["featureVersion"] }, "model-context-unsupported-version", 0],
            [{ knownAsOf: "2099-01-01T00:00:00Z" }, "model-context-future-knowledge", 1],
            [{ gameId: "missing" }, "model-context-unavailable", 1]];
          for (const [patch, reason, sql] of controls) {
            const output = await invoke(world, { request: { ...world.request, ...patch }, expected: { sql, checks: 0, gets: 0, batches: 0 } });
            refused(output.result, reason); details.push({ reason, budget: output.budget });
          }
          const small = await fixture.feature([world.served.snapshot], { n: 1 });
          refused((await invoke({ ...world, feature: small, request: { ...world.request, ...small.request } },
            { expected: { sql: 1, checks: 0, gets: 0, batches: 0 } })).result, "model-context-insufficient-history");
          const empty = await fixture.feature([]);
          refused((await invoke({ ...world, feature: empty, request: { ...world.request, ...empty.request } },
            { expected: { sql: 1, checks: 0, gets: 0, batches: 0 } })).result, "model-context-lineage-refused");
          return { details, insufficientHistory: true, emptyLineage: true };
        });
        await check("forged references stay P2317; genuine pruning with an older survivor stays P1666 at Q1 and Q2", async () => {
          const forged = await fixture.world();
          refused((await invoke(forged, { forge: true, expected: { sql: 2, checks: 1, gets: 0, batches: 0 } })).result, "model-context-reference-refused");
          const details = [];
          for (const point of ["resolve", "get"]) {
            const world = await fixture.world(), newer = await fixture.feature([world.served.snapshot], {
              playerId: world.request.playerId, gameId: world.request.gameId, supersedes: world.feature.id, n: 8 });
            const selected = { ...world, feature: newer, request: { ...world.request, ...newer.request } };
            const prune = async () => {
              await admin.query("DELETE FROM fs138.feature_inputs WHERE feature_id=$1", [newer.id]);
              await admin.query("DELETE FROM fs138.feature_values WHERE feature_id=$1", [newer.id]);
            };
            const output = await invoke(selected, { ...(point === "resolve" ? { afterResolve: prune } : { duringGet: prune }),
              expected: { sql: point === "resolve" ? 2 : 3, checks: point === "resolve" ? 1 : 2,
                gets: point === "resolve" ? 0 : 1, batches: point === "resolve" ? 0 : 1 } });
            refused(output.result, "model-read-status-refused");
            assert.equal((await resolveModelContext(client, world.feature.request)).feature.featureId, world.feature.id);
            details.push({ point, budget: output.budget, survivor: world.feature.id });
          }
          return { forgedRefused: true, details };
        });
        await check("independent model/feature rights refusals before Q1, during GET and after math withhold every field", async () => {
          const details = [];
          for (const side of ["model", "served"] as const) for (const point of ["resolve", "get", "math"]) {
            const world = await fixture.world(), revoke = () => fixture.rights(world[side].profile, false).then(() => {});
            const output = await invoke(world, { ...(point === "resolve" ? { afterResolve: revoke } : point === "get" ? { duringGet: revoke } : { beforeQ2: revoke }),
              expected: { sql: point === "resolve" ? 2 : 3, checks: point === "resolve" ? 1 : 2,
                gets: point === "resolve" ? 0 : 1, batches: point === "resolve" ? 1 : 2 } });
            refused(output.result, "model-current-rights-refused"); details.push({ side, point, budget: output.budget });
          }
          return details;
        });
        await check("both deletion APIs and independent served-source deletion win over retained values at every boundary", async () => {
          const details = [];
          for (const side of ["model-source", "model-dataset", "feature-source"]) for (const point of ["resolve", "get", "math"]) {
            const world = await fixture.world(), remove = async () => {
              if (side === "model-dataset") await deleteDatasets(writer, [world.datasets[0].datasetId], "#167 handler race", 300);
              else await deleteSources(writer, [side === "model-source" ? world.model.snapshot : world.served.snapshot], "#167 handler race", 300);
            };
            const output = await invoke(world, { ...(point === "resolve" ? { afterResolve: remove } : point === "get" ? { duringGet: remove } : { beforeQ2: remove }),
              expected: { sql: point === "resolve" ? 2 : 3, checks: point === "resolve" ? 1 : 2,
                gets: point === "resolve" ? 0 : 1, batches: point === "resolve" ? 0 : 1 } });
            refused(output.result, "model-read-status-refused"); details.push({ side, point, budget: output.budget });
          }
          return details;
        });
        await check("actual handler Q1/Q2 database work matches n=2/16 and observers detect hidden scans and DML", async () => {
          const world = await fixture.world({ n: 2 }), matched = [];
          for (const n of [2, 16]) {
            const history = Array.from({ length: n }, (_, i) => ({ gameId: `prior-${i}`, kickoff: "2024-01-01T00:00:00Z", yards: i * 100 }));
            await admin.query("UPDATE fs138.feature_values SET history=$2,sample_size=$3 WHERE feature_id=$1", [world.feature.id, JSON.stringify(history), n]);
            const output = await invoke(world, { measure: true }); available(output.result);
            matched.push({ n, ...output.counters, budget: output.budget });
          }
          assert.deepEqual(matched[0].q1, matched[1].q1); assert.deepEqual(matched[0].q2, matched[1].q2);
          const context = await resolveModelContext(client, world.feature.request);
          const scan = await measureCompositeWork(client, world.runId, context, true, "scan");
          assert(scan.find(r => r.table === "feature_values")!.seq_tup_read > 0);
          const dml = await measureCompositeWork(client, world.runId, context, true, "dml");
          assert.throws(() => assertCompositeWork(dml), /reader DML/);
          return { matched, negativeControls: { scanDetected: true, writeDetected: true } };
        });
        await check("paused GET/private math handoff holds no reader transaction or locks while deletion commits", async () => {
          const details = [], pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          for (const point of ["get", "math"]) {
            const world = await fixture.world(), concurrent = await openWriter();
            let activity: unknown, locks: unknown;
            const inspectAndDelete = async () => {
              activity = (await admin.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
              locks = (await admin.query("SELECT locktype,mode FROM pg_locks WHERE pid=$1", [pid])).rows;
              assert.deepEqual(activity, { state: "idle", xact_start: null }); assert.deepEqual(locks, []);
              await concurrent.query("SET statement_timeout='2s'");
              await deleteDatasets(concurrent, [world.datasets[0].datasetId], "#167 paused handler", 300);
            };
            const output = await invoke(world, { ...(point === "get" ? { duringGet: inspectAndDelete } : { beforeQ2: inspectAndDelete }),
              expected: { sql: 3, checks: 2, gets: 1, batches: 1 } });
            refused(output.result, "model-read-status-refused"); details.push({ point, activity, locks, concurrentDeletionCommitted: true });
          }
          return details;
        });
        await check("real narrow LOGIN cannot read private tables, switch roles or execute writer/unscoped functions; model-only remains 2 SQL", async () => {
          for (const sql of ["SELECT * FROM fs138.feature_values LIMIT 0", "SELECT * FROM fs138.outcome_labels LIMIT 0",
            "SELECT * FROM fs138.model_runs LIMIT 0", "SELECT * FROM fs138.norm_player_game_stats LIMIT 0",
            "SET ROLE fs138_reader", "SET ROLE fs231_model_reader", "SET ROLE fs138_pipeline_writer",
            "SELECT fs138.authorize_model_read(NULL,ARRAY['descriptor'],true)", "SELECT fs138.authorize_model_scope(NULL,ARRAY['descriptor'],true,NULL)",
            "SELECT fs138.delete_sources('{}','refuse',0)", "SELECT fs138.publish_model_run('{}','[]')"])
            await assert.rejects(client.query(sql), { code: "42501" });
          const world = await fixture.world(); let sql = 0;
          await readModelArtifacts({ query: async (...args: unknown[]) => { sql++; return Reflect.apply(reader.query, reader, args); } } as Pick<Client, "query">,
            store, { runId: world.runId, slots: ["descriptor"] });
          assert.equal(sql, 2); return { realLogin: config.user, modelOnlySql: sql };
        });
        await check("missing/corrupt descriptor and a lost Q2 reply deliver no partial result", async () => {
          const world = await fixture.world();
          refused((await invoke(world, { objects: { get: async () => { throw new Error("missing bytes"); } },
            expected: { sql: 2, checks: 1, gets: 1, batches: 1 } })).result, "model-artifact-unavailable");
          const original = await store.get(world.descriptor.objectKey), corrupt = Buffer.alloc(original.length, 120);
          refused((await invoke(world, { objects: { get: async () => corrupt },
            expected: { sql: 2, checks: 1, gets: 1, batches: 1 } })).result, "descriptor-mismatch");
          const session = await open();
          refused((await invoke(world, { session, loseQ2: true })).result, "connection-interrupted", "discard");
          return { missingRefused: true, corruptRefused: true, lostFinalReplyRefused: true };
        });
        await check("pre-expiry/abort does zero work and reuses the idle connection; late GET completion cannot run Q2", async () => {
          const world = await fixture.world(), controller = new AbortController(); controller.abort();
          const zero = { sql: 0, checks: 0, gets: 0, batches: 0 };
          refused((await invoke(world, { signal: controller.signal, expected: zero })).result, "cancelled");
          refused((await invoke(world, { deadlineAt: performance.now() - 1, expected: zero })).result, "deadline-exceeded");
          available((await invoke(world)).result);
          const pause = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
          const pending = invoke(world, { signal: pause.signal, duringGet: async () => { entered.resolve(); await release.promise; },
            expected: { sql: 2, checks: 1, gets: 1, batches: 1 } });
          await entered.promise; pause.abort(); const output = await pending; refused(output.result, "cancelled");
          release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(output.budget.trace, ["context", "Q1", "GET:descriptor"]);
          available((await invoke(world)).result);
          return { zeroWork: true, sameClientReusable: true, noLateQuery: true, budget: output.budget };
        });
        await check("real sleeping SQL is interrupted at context/Q1/Q2 and ends each dedicated connection without follow-up SQL", async () => {
          const details = [];
          for (const stage of ["context", "Q1", "Q2"]) for (const kind of ["deadline", "abort"]) {
            const world = await fixture.world(), session = await open();
            const controller = new AbortController();
            const output = await invoke(world, { session, sleepAt: stage,
              ...(kind === "abort" ? { signal: controller.signal, cancelSql: controller } : {}), expected: {
              sql: stage === "context" ? 1 : stage === "Q1" ? 2 : 3,
              checks: stage === "context" ? 0 : stage === "Q1" ? 1 : 2,
              gets: stage === "Q2" ? 1 : 0, batches: stage === "Q2" ? 1 : 0 } });
            refused(output.result, kind === "abort" ? "cancelled" : "deadline-exceeded", "discard");
            await assert.rejects(session.query("SELECT 1")); details.push({ stage, kind, budget: output.budget, disposed: true });
          }
          return details;
        });
      } finally { await Promise.all(sessions.map(c => c.end())); await restore(); }
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } catch (error) { evidence.verdict = "fail"; evidence.error = String(error); throw error; }
  finally {
    const paths = ["services/pipeline/src/featureStore/predict.ts", "services/pipeline/src/featureStore/predictionHelpers.ts",
      "services/pipeline/src/featureStore/predictionClock.ts", "services/pipeline/src/featureStore/predictionOwner.ts",
      "services/pipeline/src/featureStore/modelArtifacts.ts", "services/pipeline/src/featureStore/modelContext.ts",
      "packages/db/proposals/231_composite_authorization.sql", "services/pipeline/tests/feature-store/prediction-db-fixture.ts",
      "services/pipeline/tests/feature-store/prediction-handler.check.mts", "services/pipeline/tests/feature-store/composite-read-work.ts"];
    evidence.sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
      [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
    evidence.sourceBlobIds = Object.fromEntries(paths.map(path => [path,
      execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim()]));
    await rm(root, { recursive: true, force: true });
    if (process.env.FS168_HANDLER_EVIDENCE) await writeFile(process.env.FS168_HANDLER_EVIDENCE,
      JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  }
});
