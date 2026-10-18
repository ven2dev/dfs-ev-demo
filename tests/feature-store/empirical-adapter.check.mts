import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { createEmpiricalAdapter, EMPIRICAL_ADAPTER, type EmpiricalRequest, type EmpiricalRead } from "../../src/lib/featureStore/empiricalAdapter.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/lib/featureStore/derived.ts";
import { deleteSources, pruneDerivedVersions } from "../../src/lib/featureStore/governance.ts";
import { startJob, finishJob } from "../../src/lib/featureStore/jobs.ts";
import { openLocalObjectStore } from "../../src/lib/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/lib/featureStore/objectStore.ts";

const probes: { name: string; verdict: string }[] = [];
const paths = ["db/proposals/163_effective_rights.sql", "scripts/feature-store/harness.ts", "src/lib/featureStore/empiricalAdapter.ts", "db/proposals/163_empirical_authorize.sql",
  "db/proposals/163_empirical_history.sql", "db/proposals/163_empirical_reader.sql", "tests/feature-store/empirical-adapter.check.mts"];
const codeHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL("../../" + path, import.meta.url)))])));
const retrospective = "retrospective-reconstruction-v1" as const;
const strict = "strict-point-in-time-v1" as const;
const history = (n = 3) => Array.from({ length: n }, (_, i) => ({ gameId: `prior-${i}`, kickoff: `2024-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`, yards: [-2, 0, 2][i % 3] }));
const unavailable = (read: EmpiricalRead, reason: string) => {
  assert.equal(read.response.status, "unavailable");
  if (read.response.status !== "unavailable") throw new Error("expected-refusal");
  assert.equal(read.response.reason, reason); assert.equal(read.response.rightsScope, "research");
  assert.deepEqual(read.response.adapter, EMPIRICAL_ADAPTER);
  assert.equal("probabilities" in read.response, false); assert.equal("sourceLineage" in read.response, false);
  assert.deepEqual(JSON.parse(read.serialized), read.response);
};

test("#163 versioned materialized research adapter", { timeout: 120_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs163-adapter-test-")));
  const store = await openLocalObjectStore(root);
  const predict = await createEmpiricalAdapter();
  const clients: Client[] = [];
  const check = async (name: string, run: () => Promise<void>) => t.test(name, async () => {
    try { await run(); probes.push({ name, verdict: "pass" }); }
    catch (error) { probes.push({ name, verdict: "fail" }); throw error; }
  });
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, createWriterConfig }) => {
      await admin.query(await readFile(new URL("../../db/proposals/163_empirical_reader.sql", import.meta.url), "utf8"));
      const config = await createWriterConfig(); assert.match(String(config.user), /^fs138_job_[a-f0-9]{16}$/);
      await admin.query(`REVOKE fs138_pipeline_writer FROM ${config.user}`);
      await admin.query(`GRANT fs163_research_reader TO ${config.user}`);
      const open = async () => { const c = new Client(config); clients.push(c); c.on("error", () => {}); await c.connect(); return c; };
      const reader = await open();
      const clock = async () => (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock as string;
      const job = async (kind: "ingest" | "features" = "features") => {
        const digest = sha256(Buffer.from(randomUUID()));
        return (await startJob(writer, { kind, codeSha: "c".repeat(40), policySha256: digest, inputSetSha256: digest })).jobId;
      };
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES('fs163-synthetic','synthetic','stats','synthetic-contract-v1','{"scope":"synthetic tests only"}')`);
      const source = async () => {
        const sourceJob = await job("ingest");
        const bytes = Buffer.from("synthetic #163 source; no historical-availability claim: " + randomUUID());
        const hash = sha256(bytes); const key = objectKey("raw", bytes); await store.putIfAbsent(key, bytes);
        const id = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,
          media_type,decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
          VALUES('fs163-synthetic',$1,$2,$3,$4,'text/csv',$2,$2,1,clock_timestamp(),clock_timestamp(),'prospective') RETURNING snapshot_id`,
        [sourceJob, hash, bytes.length, key])).rows[0].snapshot_id as string;
        await finishJob(writer, sourceJob, { counts: { syntheticSources: 1 } });
        return id;
      };
      const snapshot = await source();
      const grant = async (uses: string[]) => { await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        VALUES('fs163-synthetic',$1,clock_timestamp(),'synthetic contract probes; research only')`, [uses]); };
      await grant(["research"]);
      const seed = async (options: { mode?: typeof retrospective | typeof strict; rows?: unknown[]; state?: string;
        player?: string; game?: string; cutoff?: string; version?: string; supersedes?: string; snapshotIds?: string[] } = {}): Promise<EmpiricalRequest> => {
        const jobId = await job(); const rows = options.rows ?? history();
        const state = options.state ?? (rows.length < 2 ? "unavailable" : "usable");
        const mode = options.mode ?? retrospective;
        const feature = (await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,
          feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
          VALUES($1,$2,$3,'passing_yards',2025,$4,clock_timestamp(),$5,$6,$7,$8,$9,'{}',$10,$11,'[]',$12)
          RETURNING feature_id`, [jobId, options.player ?? randomUUID(), options.game ?? "synthetic-target", options.cutoff ?? (mode === strict ? "2027-01-01T00:00:00Z" : "2025-09-01T00:00:00Z"),
          options.version ?? FEATURE_VERSION, HISTORY_POLICY, mode, state, state === "usable" ? [] : ["synthetic-unavailable"], rows.length, JSON.stringify(rows), options.supersedes ?? null])).rows[0].feature_id;
        await writer.query("INSERT INTO fs138.feature_inputs SELECT $1,unnest($2::uuid[])", [feature, options.snapshotIds ?? [snapshot]]);
        await finishJob(writer, jobId, { counts: { syntheticFeatures: 1 } });
        return { featureId: feature, knownAsOf: await clock(), line: 0, featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: mode };
      };
      // Commit a writer change after an exact reader statement has completed,
      // before resolving it to the adapter. No sleeps or reader transactions.
      const afterStatement = (nth: number, change: () => Promise<void>) => {
        let seen = 0;
        return new Proxy(reader, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.query, target, args);
            if (++seen === nth) await change();
            return result;
          };
        } });
      };
      try {
        await check("restricted login cannot read labels, normalized evidence or raw manifests, or write derived values", async () => {
          for (const table of ["outcome_labels", "label_inputs", "norm_schedule", "norm_player_game_stats", "norm_identity", "norm_participation", "normalized_evidence"])
            await assert.rejects(reader.query(`SELECT * FROM fs138.${table} LIMIT 0`), { code: "42501" });
          await assert.rejects(reader.query("SELECT source_manifest FROM fs138.source_snapshots LIMIT 0"), { code: "42501" });
          await assert.rejects(reader.query("INSERT INTO fs138.feature_values DEFAULT VALUES"), { code: "42501" });
        });
        const request = await seed();
        await check("lagged features alone reproduce hand probabilities and expose research, clocks, versions and lineage", async () => {
          const result = await predict(reader, request); assert.equal(result.response.status, "available");
          if (result.response.status !== "available") throw new Error("valid-control-refused");
          const output = result.response;
          assert.deepEqual(result.work, { statements: 3, rightsChecks: 2 }); assert.equal(output.sampleSize, 3);
          assert.deepEqual(output.probabilities, { underProbability: 1 / 3, pushProbability: 1 / 3, overProbability: 1 - 1 / 3 - 1 / 3 });
          assert.equal(output.designation, "uncalibrated-interim-hit-rate"); assert.equal(output.calibration, "uncalibrated");
          assert.equal(output.rightsScope, "research"); assert.equal(output.historicalAvailability, "unverified");
          assert(output.flags.includes("historical-availability-unverified")); assert.equal(output.feature.id, request.featureId);
          assert.equal(output.clocks.knownAsOf, request.knownAsOf); assert.equal(output.sourceLineage[0].snapshotId, snapshot);
          const clocks = (await admin.query("SELECT cutoff::text,checkpoint::text,computed_at::text FROM fs138.feature_values WHERE feature_id=$1", [request.featureId])).rows[0];
          assert.equal(output.clocks.predictionCutoff, clocks.cutoff); assert.equal(output.clocks.checkpoint, clocks.checkpoint); assert.equal(output.clocks.computedAt, clocks.computed_at);
          assert.deepEqual(JSON.parse(result.serialized), output);
          assert.equal((await admin.query("SELECT count(*)::integer AS n FROM fs138.outcome_labels")).rows[0].n, 0);
        });
        await check("2, 8 and 16 observations keep the same three-statement/two-rights budget", async () => {
          for (const n of [2, 8, 16]) {
            const result = await predict(reader, await seed({ rows: history(n) })); assert.equal(result.response.status, "available");
            if (result.response.status === "available") assert.equal(result.response.sampleSize, n);
            assert.deepEqual(result.work, { statements: 3, rightsChecks: 2 });
          }
        });
        await check("unknown request versions and malformed inputs refuse before SQL", async () => {
          for (const patch of [{ featureVersion: "unknown" }, { historyPolicy: "unknown" }, { evidenceMode: "unknown" }]) {
            const result = await predict(reader, { ...request, ...patch } as EmpiricalRequest); unavailable(result, "unsupported-version"); assert.equal(result.work.statements, 0);
          }
          for (const patch of [{ featureId: "bad" }, { knownAsOf: "2026-01-01T00:00:00" }, { knownAsOf: "invalid" }, { line: Infinity }]) {
            const result = await predict(reader, { ...request, ...patch }); unavailable(result, "invalid-request"); assert.equal(result.work.statements, 0);
          }
        });
        await check("stored unknown versions cannot be reinterpreted as the supported version", async () => {
          unavailable(await predict(reader, await seed({ version: "unknown" })), "unsupported-version");
        });
        await check("real database knowledge clocks have inclusive as-of selection without backdating", async () => {
          const times = (await admin.query("SELECT computed_at::text AS exact,(computed_at-interval '1 microsecond')::text AS earlier FROM fs138.feature_values WHERE feature_id=$1", [request.featureId])).rows[0];
          assert.equal((await predict(reader, { ...request, knownAsOf: times.exact })).response.status, "available");
          unavailable(await predict(reader, { ...request, knownAsOf: times.earlier }), "feature-after-as-of");
          unavailable(await predict(reader, { ...request, knownAsOf: "2099-01-01T00:00:00Z" }), "future-knowledge-as-of");
        });
        await check("strict and retrospective feature versions remain distinct; no synthetic clock is backdated", async () => {
          // Strict positive is a fictional future target, with sources captured
          // now before its cutoff. This is not real historical strict evidence.
          const positive = await predict(reader, await seed({ mode: strict })); assert.equal(positive.response.status, "available");
          if (positive.response.status === "available") {
            assert.equal(positive.response.historicalAvailability, "snapshot-qualified");
            assert.equal(positive.response.versions.evidenceMode, strict);
          }
          unavailable(await predict(reader, { ...request, evidenceMode: strict }), "unsupported-version");
        });
        await check("missing features, one-game history and unavailable features have explicit tagged refusals", async () => {
          unavailable(await predict(reader, { ...request, featureId: randomUUID() }), "feature-missing");
          unavailable(await predict(reader, await seed({ rows: history(1) })), "insufficient-history");
          unavailable(await predict(reader, await seed({ state: "unavailable" })), "feature-unavailable");
          await assert.rejects(seed({ rows: history(17) }), { code: "23514" });
        });
        await check("materialized history rejects malformed, noninteger, duplicate and mismatched rows", async () => {
          for (const rows of [[...history(), { ...history()[0] }], [{ ...history()[0], yards: "0" }, ...history().slice(1)],
            [{ ...history()[0], yards: .5 }, ...history().slice(1)], [{ ...history()[0], kickoff: "invalid" }, ...history().slice(1)],
            [history()[0], history()[0], history()[2]]]) {
            unavailable(await predict(reader, await seed({ rows })), "invalid-history");
          }
          for (const [rows, reason] of [[history(1), "insufficient-history"], [history(17), "history-limit-exceeded"],
            [history(2), "invalid-history"], [null, "invalid-history"]] as const) {
            const corrupted = new Proxy(reader, { get(target, property) {
              if (property !== "query") return Reflect.get(target, property, target);
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(target.query, target, args);
                if ((args[0] as { text: string }).text.includes("SELECT history FROM")) result.rows = [{ history: rows }];
                return result;
              };
            } });
            unavailable(await predict(corrupted, request), reason);
          }
        });
        await check("target, equal-cutoff and future events refuse identically in both evidence modes", async () => {
          for (const mode of [retrospective, strict]) for (const patch of [{ gameId: "synthetic-target" },
            { kickoff: "2027-01-01T00:00:00.000001Z" }, { kickoff: "2027-01-01T00:00:00.000002Z" }]) {
            unavailable(await predict(reader, await seed({ mode, cutoff: "2027-01-01T00:00:00.000001Z", rows: [{ ...history()[0], ...patch }, ...history().slice(1)] })), "target-or-future-history");
          }
        });
        await check("one microsecond before the event cutoff is accepted in both modes", async () => {
          for (const mode of [retrospective, strict]) {
            const result = await predict(reader, await seed({ mode, cutoff: "2027-01-01T00:00:00.000001Z",
              rows: [{ ...history()[0], kickoff: "2027-01-01T00:00:00.000000Z" }, ...history().slice(1)] }));
            assert.equal(result.response.status, "available");
          }
        });
        await check("pinned values survive corrections with current superseded and stale flags", async () => {
          const player = randomUUID(), game = "synthetic-correction-target";
          const pinned = await seed({ player, game });
          await seed({ player, game, rows: history().map(row => ({ ...row, yards: 999 })), supersedes: pinned.featureId });
          const superseded = await predict(reader, pinned); assert.equal(superseded.response.status, "available");
          if (superseded.response.status === "available") {
            assert.deepEqual(superseded.response.freshness, { stale: false, superseded: true });
            assert(!superseded.response.support.some(point => point.value === 999));
          }
          await seed({ player, game, state: "unavailable" });
          const stale = await predict(reader, pinned); assert.equal(stale.response.status, "available");
          if (stale.response.status === "available") {
            assert.deepEqual(stale.response.freshness, { stale: true, superseded: true });
            assert(stale.response.flags.includes("stale-feature")); assert(stale.response.flags.includes("superseded-feature"));
            assert.equal(stale.response.feature.id, pinned.featureId);
          }
        });
        await check("current rights refusals return no derived values or lineage", async () => {
          await grant([]); unavailable(await predict(reader, request), "current-rights-or-status-refused");
          await grant(["research"]); assert.equal((await predict(reader, request)).response.status, "available");
        });
        await check("expired superseding grants and revocations never revive an older research grant", async () => {
          for (const uses of [["research"], []]) {
            await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,valid_until,rationale)
              VALUES('fs163-synthetic',$1,'2020-01-01','2020-01-02','synthetic expired superseding decision')`, [uses]);
            const result = await predict(reader, request); unavailable(result, "current-rights-or-status-refused");
            assert.equal(result.work.statements, 1);
            await grant(["research"]); assert.equal((await predict(reader, request)).response.status, "available");
          }
        });
        await check("pre-cancellation and an expired request deadline send no query and keep the connection reusable", async () => {
          const controller = new AbortController(); controller.abort();
          const cancelled = await predict(reader, request, { signal: controller.signal }); unavailable(cancelled, "cancelled");
          assert.equal(cancelled.work.statements, 0); assert.equal(cancelled.response.connectionDisposition, "reusable");
          const expired = await predict(reader, request, { deadlineAt: performance.now() - 1 }); unavailable(expired, "deadline-exceeded");
          assert.equal(expired.work.statements, 0); assert.equal((await predict(reader, request)).response.status, "available");
        });
        await check("an in-flight query timeout terminates the connection and returns a discard refusal", async () => {
          const slow = await open();
          const delayed = new Proxy(slow, { get(target, property) {
            if (property !== "query") return Reflect.get(target, property, target);
            return () => target.query({ text: "SELECT pg_sleep(10)", query_timeout: 20 } as import("pg").QueryConfig);
          } });
          const result = await predict(delayed, request); unavailable(result, "deadline-exceeded");
          assert.equal(result.work.statements, 1); assert.equal(result.response.connectionDisposition, "discard");
          await assert.rejects(slow.query("SELECT 1"));
        });
        await check("in-flight caller cancellation terminates the query connection without a follow-up SQL statement", async () => {
          const slow = await open(); const controller = new AbortController();
          const delayed = new Proxy(slow, { get(target, property) {
            if (property !== "query") return Reflect.get(target, property, target);
            return () => { const pending = target.query("SELECT pg_sleep(10)"); setImmediate(() => controller.abort()); return pending; };
          } });
          const result = await predict(delayed, request, { signal: controller.signal }); unavailable(result, "cancelled");
          assert.equal(result.work.statements, 1); assert.equal(result.response.connectionDisposition, "discard");
          await assert.rejects(slow.query("SELECT 1"));
        });
        await check("committed research revocation at either read boundary withholds delivery", async () => {
          for (const boundary of [1, 2]) {
            const raced = afterStatement(boundary, () => grant([]));
            unavailable(await predict(raced, request), "delivery-rights-or-status-refused");
            await grant(["research"]);
            assert.equal((await predict(reader, request)).response.status, "available");
          }
        });
        await check("committed source deletion at either read boundary removes the selected feature and withholds delivery", async () => {
          for (const boundary of [1, 2]) {
            const id = await source(), selected = await seed({ snapshotIds: [id] });
            let deleted: string[] = [];
            const raced = afterStatement(boundary, async () => {
              deleted = (await deleteSources(writer, [id], "synthetic #163 between-query deletion", .02)).feature_ids;
            });
            const result = await predict(raced, selected); unavailable(result, "feature-missing");
            assert(deleted.includes(selected.featureId)); assert.equal(result.work.statements, boundary === 1 ? 2 : 3);
            unavailable(await predict(reader, selected), "feature-missing");
          }
        });
        await check("delivery refuses lineage attached after authorization instead of widening its authorization", async () => {
          const selected = await seed(), extra = await source();
          const raced = afterStatement(2, async () => {
            await writer.query("INSERT INTO fs138.feature_inputs VALUES($1,$2)", [selected.featureId, extra]);
          });
          unavailable(await predict(raced, selected), "delivery-rights-or-status-refused");
          assert.equal((await predict(reader, selected)).response.status, "available");
        });
        await check("pruned exact versions refuse before or during delivery and never fall back to a newer version", async () => {
          for (const boundary of [0, 2]) {
            const player = randomUUID(), game = randomUUID();
            const selected = await seed({ player, game });
            const latest = await seed({ player, game, supersedes: selected.featureId });
            let pruned: string[] = [];
            const prune = async () => { pruned = (await pruneDerivedVersions(writer)).featureIds; };
            if (boundary === 0) await prune();
            const result = await predict(boundary ? afterStatement(boundary, prune) : reader, selected);
            unavailable(result, "feature-missing"); assert(pruned.includes(selected.featureId));
            assert.equal(result.work.statements, boundary ? 3 : 1);
            assert.equal((await predict(reader, latest)).response.status, "available");
          }
        });
        await check("a revocation after the final snapshot illustrates the accepted delivery gap; the next request refuses", async () => {
          const result = await predict(afterStatement(3, () => grant([])), request);
          assert.equal(result.response.status, "available");
          unavailable(await predict(reader, request), "current-rights-or-status-refused");
          await grant(["research"]);
        });
        await check("the absolute request deadline interrupts a query even without a pg query timeout", async () => {
          const slow = await open();
          const delayed = new Proxy(slow, { get(target, property) {
            if (property !== "query") return Reflect.get(target, property, target);
            return () => target.query("SELECT pg_sleep(10)");
          } });
          const result = await predict(delayed, request, { deadlineAt: performance.now() + 40 });
          unavailable(result, "deadline-exceeded"); assert.equal(result.work.statements, 1);
          assert.equal(result.response.connectionDisposition, "discard"); await assert.rejects(slow.query("SELECT 1"));
        });
      } finally { await Promise.all(clients.map(client => client.end())); }
    });
    assert.equal(probes.length, 23, "all adapter contract cases ran");
    assert(probes.every(probe => probe.verdict === "pass"));
  } finally {
    await rm(root, { recursive: true, force: true });
    if (process.env.FEATURE_STORE_EVIDENCE_PATH) await writeFile(process.env.FEATURE_STORE_EVIDENCE_PATH, JSON.stringify({
      schemaVersion: 1, issue: 163, step: 4, checkpoint: "review-1-rights-expiry", runtime: process.version, workload: "synthetic adapter contracts and committed between-query writer races on restricted PostgreSQL connections; no real evaluation or latency claim",
      codeHashes, probes, verdict: probes.length === 23 && probes.every(probe => probe.verdict === "pass") ? "pass" : "fail",
    }, null, 2) + "\n");
  }
});
