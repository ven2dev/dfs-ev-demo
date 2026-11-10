import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { buildDataset, DATASET_JOIN_SQL, readDataset, type DatasetRow, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { createEmpiricalAdapter, type EmpiricalRead, type EmpiricalRequest } from "../../src/featureStore/empiricalAdapter.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { measureDatasetPublication } from "./dataset-publication-work.ts";

const mode = "retrospective-reconstruction-v1" as const;
const code = { gitSha: "c".repeat(40), contentSha256: sha256(Buffer.from("241 permanent step 2")) };
type Revision = { id: string; jobId: string; player: string; game: string };
const history = (n = 3) => Array.from({ length: n }, (_, i) => ({ gameId: "prior-" + i, kickoff: "2024-01-01T00:00:00Z", yards: 100 + i }));
const refused = (result: EmpiricalRead, reason: string) => {
  assert.equal(result.response.status, "unavailable");
  assert.equal((result.response as { reason: string }).reason, reason);
  for (const key of ["probabilities", "sourceLineage", "rights", "feature", "support"])
    assert.equal(key in JSON.parse(result.serialized), false, "no partial " + key);
};

test("#241 dataset pins, current freshness and narrow #163 completion", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [];
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dfs241-dataset-")));
  const store = await openLocalObjectStore(directory);
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, createWriterConfig, queryCounts }) => {
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { probes.push({ name, verdict: "pass", details: await run() }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const clock = async () => (await admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at as string;
      const job = async (kind: "features" | "labels" | "ingest") => (await startJob(writer,
        { kind, codeSha: code.gitSha, policySha256: code.contentSha256, inputSetSha256: sha256(Buffer.from(randomUUID())) })).jobId;
      const finish = async (jobId: string, fail = false) => {
        await finishJob(writer, jobId, { counts: {}, ...(fail ? { errorCode: "intentional-test" } : {}) });
        return (await writer.query("SELECT finished_at::text AS at FROM fs138.job_runs WHERE job_id=$1", [jobId])).rows[0].at as string;
      };
      const sourceJob = await job("ingest"), snapshots: string[] = [];
      for (const profile of ["241-stats", "241-roster"]) {
        await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
          VALUES($1,'synthetic','stats','241-test','{}')`, [profile]);
        const hash = sha256(Buffer.from(profile));
        snapshots.push((await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
          decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
          VALUES($1,$2,$3::text,0,'raw/'||$3::text,'text/csv',$3::text,$3::text,1,clock_timestamp(),clock_timestamp(),'prospective') RETURNING snapshot_id`,
        [profile, sourceJob, hash])).rows[0].snapshot_id);
      }
      await finish(sourceJob);
      const grant = async (uses: string[]) => writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        SELECT profile_id,$1::text[],clock_timestamp(),'synthetic 241 completion probes' FROM fs138.source_profiles`, [uses]);
      await grant(["research"]);
      const seed = async (kind: "features" | "labels", options: { previous?: Revision; player?: string; game?: string; unavailable?: boolean; n?: number; version?: string; policy?: string } = {}): Promise<Revision> => {
        const jobId = await job(kind), player = options.previous?.player ?? options.player ?? randomUUID(), game = options.previous?.game ?? options.game ?? "2025-target-" + randomUUID();
        const state = options.unavailable ? "unavailable" : "usable", reasons = options.unavailable ? ["newer-unavailable"] : [];
        const n = options.n ?? 3;
        const row = kind === "features"
          ? (await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,
              evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
              VALUES($1,$2,$3,'passing_yards',2025,'2025-09-01',clock_timestamp(),$4,$5,$6,$7,$8,'{}',$9,$10,'[]',$11) RETURNING feature_id AS id`,
          [jobId, player, game, options.version ?? FEATURE_VERSION, options.policy ?? HISTORY_POLICY, mode, state, reasons, n, JSON.stringify(history(n)), options.previous?.id ?? null])).rows[0]
          : (await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value,supersedes_id)
              VALUES($1,$2,$3,'passing_yards',2025,clock_timestamp(),$4,$5,$6,$7,'{}',$8,$9) RETURNING label_id AS id`,
          [jobId, player, game, options.version ?? LABEL_VERSION, mode, state, reasons, options.unavailable ? null : 222, options.previous?.id ?? null])).rows[0];
        await writer.query(`INSERT INTO fs138.${kind === "features" ? "feature_inputs" : "label_inputs"} SELECT $1,unnest($2::uuid[])`, [row.id, snapshots]);
        return { id: row.id, jobId, player, game };
      };
      const pair = async () => {
        const f = await seed("features"); await finish(f.jobId);
        const l = await seed("labels", { player: f.player, game: f.game }); await finish(l.jobId);
        return { f, l };
      };
      const specAt = (at: string): DatasetSpec => ({ mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
        historyPolicy: HISTORY_POLICY, featuresAsOf: at, labelsAsOf: at, includeRetrospective: true, includeSuperseded: true });
      const values = (spec: DatasetSpec) => [spec.featureVersion, spec.labelVersion, spec.historyPolicy, spec.mode,
        spec.featuresAsOf, spec.labelsAsOf, spec.includeRetrospective, spec.includeSuperseded];
      const select = async (spec: DatasetSpec) => (await reader.query<{ rows: DatasetRow[] }>(DATASET_JOIN_SQL, values(spec))).rows[0].rows;
      const one = (rows: DatasetRow[], revision: Revision) => { const r = rows.find(r => r.playerId === revision.player && r.gameId === revision.game); assert(r); return r; };

      for (const kind of ["features", "labels"] as const) await check(`${kind}: independent pin excludes a later completion and includes the exact microsecond`, async () => {
        const original = await pair(), old = kind === "features" ? original.f : original.l;
        const next = await seed(kind, { previous: old }); const pin = await clock();
        const before = one(await select(specAt(pin)), old);
        assert.equal(kind === "features" ? before.featureId : before.labelId, old.id);
        const finishedAt = await finish(next.jobId);
        const after = await clock();
        const pinned = { ...specAt(after), [kind === "features" ? "featuresAsOf" : "labelsAsOf"]: pin };
        const unchanged = one(await select(pinned), old);
        assert.equal(kind === "features" ? unchanged.featureId : unchanged.labelId, old.id);
        assert(unchanged.flags.includes(kind === "features" ? "superseded-feature" : "superseded-label"));
        const clocks = (await admin.query(`SELECT ($1::timestamptz-interval '1 microsecond')::text AS before,
          $1::timestamptz::text AS exact,($1::timestamptz+interval '1 microsecond')::text AS after`, [finishedAt])).rows[0];
        const answers = [];
        for (const [boundary, at] of Object.entries(clocks)) {
          const row = one(await select({ ...specAt(after), [kind === "features" ? "featuresAsOf" : "labelsAsOf"]: at }), old);
          const selected = kind === "features" ? row.featureId : row.labelId;
          assert.equal(selected, boundary === "before" ? old.id : next.id); answers.push({ boundary, at, selected });
        }
        return { pin, finishedAt, oldId: old.id, newId: next.id, answers, statementsPerSelection: 1 };
      });

      await check("current freshness ignores running/failed jobs and unrelated versions; unavailable completed heads set both flags", async () => {
        const original = await pair(), pin = await clock(), spec = specAt(pin);
        for (const kind of ["features", "labels"] as const) {
          const previous = kind === "features" ? original.f : original.l;
          const newer = await seed(kind, { previous, unavailable: true });
          assert.deepEqual(one(await select(spec), previous).flags, []);
          await finish(newer.jobId, true);
          assert.deepEqual(one(await select(spec), previous).flags, []);
          const unrelated = await seed(kind, { previous, unavailable: true, version: "unrelated-version" }); await finish(unrelated.jobId);
        }
        const otherPolicy = await seed("features", { previous: original.f, policy: "unrelated-policy", unavailable: true }); await finish(otherPolicy.jobId);
        assert.deepEqual(one(await select(spec), original.f).flags, []);
        for (const kind of ["features", "labels"] as const) {
          const previous = kind === "features" ? original.f : original.l;
          const next = await seed(kind, { previous, unavailable: true }); await finish(next.jobId);
        }
        const row = one(await select(spec), original.f);
        assert.equal(row.featureId, original.f.id); assert.equal(row.labelId, original.l.id);
        assert.deepEqual(row.flags, ["stale-feature", "stale-label", "superseded-feature", "superseded-label"]);
        const latest = one(await select(specAt(await clock())), original.f);
        assert.equal(latest.featureId, original.f.id); assert.equal(latest.labelId, original.l.id);
        assert.equal((await select({ ...spec, includeSuperseded: false })).some(r => r.playerId === row.playerId), false);
        return { retainedFeature: row.featureId, retainedLabel: row.labelId, flags: row.flags, includeSupersededFalseExcludes: true };
      });

      await check("build and governed delivery preserve 8/2 and 3/2/1, with zero transaction hashes or payload reads", async () => {
        const spec = specAt(await clock()), before = queryCounts.writer;
        const result = (await measureDatasetPublication([writer, store, spec, code]))!;
        assert.equal(queryCounts.writer - before, 8); assert.equal(result.work.rightsQueries, 2);
        let gets = 0; const readBefore = queryCounts.reader;
        const bytes = await readDataset(reader, { ...store, get: async key => { gets++; return store.get(key); } }, result.datasetId);
        assert.equal(queryCounts.reader - readBefore, 3); assert.equal(gets, 1); assert.equal(sha256(bytes), result.fileSha256);
        await grant([]); let writes = 0;
        await assert.rejects(buildDataset(writer, { ...store, putIfAbsent: async (key, bytes) => { writes++; return store.putIfAbsent(key, bytes); } }, spec, code), /current-rights/);
        assert.equal(writes, 0); await grant(["research"]);
        return { buildStatements: 8, buildRightsChecks: 2, deliveryStatements: 3, deliveryRightsChecks: 2, gets,
          hashesInTransaction: 0, payloadReadsInTransaction: 0, noUploadWhenDenied: true };
      });

      await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/163_empirical_reader.sql")), "utf8"));
      const config = await createWriterConfig();
      await admin.query(`REVOKE fs138_pipeline_writer FROM ${config.user}; GRANT fs163_research_reader TO ${config.user}`);
      const narrow = new Client(config); await narrow.connect();
      const predict = await createEmpiricalAdapter();
      const request = (f: Revision, knownAsOf: string): EmpiricalRequest => ({ featureId: f.id, knownAsOf, line: 100,
        featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: mode });

      try {
      await check("#163 exact feature pin uses completion, preserves typed refusal and never releases partial values", async () => {
        const f = await seed("features"), pin = await clock();
        refused(await predict(narrow, request(f, pin)), "feature-unavailable");
        const finishedAt = await finish(f.jobId);
        refused(await predict(narrow, request(f, pin)), "feature-after-as-of");
        const before = (await admin.query("SELECT ($1::timestamptz-interval '1 microsecond')::text AS at", [finishedAt])).rows[0].at;
        refused(await predict(narrow, request(f, before)), "feature-after-as-of");
        const available = await predict(narrow, request(f, finishedAt)); assert.equal(available.response.status, "available");
        assert.deepEqual(available.work, { statements: 3, rightsChecks: 2 });
        for (const table of ["outcome_labels", "norm_player_game_stats"]) await assert.rejects(narrow.query(`SELECT * FROM fs138.${table}`), { code: "42501" });
        await assert.rejects(narrow.query("SELECT counts FROM fs138.job_runs"), { code: "42501" });
        return { pin, finishedAt, beforeFinish: "feature-after-as-of", exact: "available", partialDelivery: false, narrowLogin: true };
      });

      await check("#163 current heads use completion and Q2 refreshes stale flags without selecting newer values", async () => {
        const f = await seed("features"); await finish(f.jobId); const pinned = request(f, await clock());
        const newer = await seed("features", { previous: f, unavailable: true });
        const current = await predict(narrow, pinned); assert.equal(current.response.status, "available");
        if (current.response.status === "available") assert.deepEqual(current.response.freshness, { stale: false, superseded: false });
        let calls = 0;
        const raced = new Proxy(narrow, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return async (...args: unknown[]) => { const result = await Reflect.apply(target.query, target, args); if (++calls === 2) await finish(newer.jobId); return result; };
        } });
        const refreshed = await predict(raced, pinned); assert.equal(refreshed.response.status, "available");
        if (refreshed.response.status === "available") {
          assert.deepEqual(refreshed.response.freshness, { stale: true, superseded: true }); assert.equal(refreshed.response.feature.id, f.id);
        }
        assert.equal(calls, 3);
        return { q1Flags: { stale: false, superseded: false }, q2Flags: { stale: true, superseded: true }, statements: calls, retainedId: f.id };
      });

      await check("#163 every n=2..16 uses three statements, two checks and exactly 2P rights calls on real narrow LOGIN", async () => {
        const rightsSql = await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/163_effective_rights.sql")), "utf8");
        await admin.query(rightsSql.replace("CREATE FUNCTION fs138.effective_rights", "CREATE FUNCTION fs138.visibility_original_rights"));
        await admin.query(`GRANT EXECUTE ON FUNCTION fs138.visibility_original_rights(text,timestamptz,timestamptz) TO fs163_research_reader;
          CREATE OR REPLACE FUNCTION fs138.effective_rights(p_profile text,p_valid_at timestamptz,p_known_at timestamptz)
          RETURNS TABLE(decision_id uuid,allowed_uses text[]) LANGUAGE plpgsql STABLE AS $$ BEGIN
          RAISE NOTICE 'fs241-rights:%',p_profile;
          RETURN QUERY SELECT * FROM fs138.visibility_original_rights(p_profile,p_valid_at,p_known_at); END $$`);
        const profiles: string[] = [], onNotice = (notice: { message?: string }) => { if (notice.message?.startsWith("fs241-rights:")) profiles.push(notice.message.slice(13)); };
        narrow.on("notice", onNotice);
        const results = [];
        try {
          for (let n = 2; n <= 16; n++) {
            const f = await seed("features", { n }); await finish(f.jobId);
            const expected = (await admin.query(`SELECT DISTINCT s.profile_id FROM fs138.feature_inputs i
              JOIN fs138.source_snapshots s USING(snapshot_id) WHERE feature_id=$1 ORDER BY profile_id`, [f.id])).rows.map(r => r.profile_id);
            profiles.length = 0; const sql: string[] = [];
            const measured = new Proxy(narrow, { get(target, property) {
              if (property !== "query") return Reflect.get(target, property, target);
              return (...args: unknown[]) => { const q = args[0]; sql.push(typeof q === "string" ? q : (q as { text: string }).text); return Reflect.apply(target.query, target, args); };
            } });
            const result = await predict(measured, request(f, await clock())); assert.equal(result.response.status, "available");
            assert.equal(sql.length, 3); assert.equal(sql.filter(q => q.includes("selection_reason")).length, 2);
            assert.deepEqual(profiles.sort(), [...expected, ...expected].sort());
            assert(!sql.some(q => /FOR\s+(UPDATE|SHARE)|LOCK\s+TABLE|pg_advisory/i.test(q)));
            results.push({ n, statements: sql.length, checks: 2, profiles: expected, rightsCalls: profiles.length });
          }
        } finally {
          narrow.removeListener("notice", onNotice);
          await admin.query(rightsSql.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
          await admin.query("DROP FUNCTION fs138.visibility_original_rights(text,timestamptz,timestamptz)");
        }
        return results;
      });
      } finally { await narrow.end(); }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (process.env.FEATURE_STORE_241_STEP2_EVIDENCE_PATH) {
      const paths = ["packages/db/proposals/241_job_visibility.sql", "packages/db/proposals/163_empirical_authorize.sql", "packages/db/proposals/163_empirical_reader.sql",
        "services/pipeline/src/featureStore/datasets.ts", "services/pipeline/tests/feature-store/job-visibility-dataset.check.mts", "services/pipeline/tests/feature-store/empirical-adapter.check.mts"];
      const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
      await writeFile(process.env.FEATURE_STORE_241_STEP2_EVIDENCE_PATH, JSON.stringify({ issue: 241, step: 2, kind: "completion-dataset-and-direct-reader",
        recordedAt: new Date().toISOString(), runtime: process.version, sourceHashes, verdict: probes.length === 7 && probes.every(p => p.verdict === "pass") ? "pass" : "fail", probes }, null, 2) + "\n", { flag: "wx" });
    }
  }
});
