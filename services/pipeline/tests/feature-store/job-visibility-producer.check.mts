import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { readNormalizedAsOf, NORMALIZED_AS_OF_SQL, type EvidenceMode } from "../../src/featureStore/asOf.ts";
import { runDerivedJob } from "../../src/featureStore/derived.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import { visibilityPlanNodes } from "./job-visibility-work.ts";

const modes = ["retrospective-reconstruction-v1", "strict-point-in-time-v1"] as const;
const code = { gitSha: "c".repeat(40), contentSha256: sha256(Buffer.from("241 step 3 actual-clock probes")) };
type Revision = { source: string; normalizer: string; snapshot: string; player: string; game: string };

test("#241 normalized and producer completion boundaries", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [];
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, queryCounts }) => {
      const check = async (name: string, run: () => Promise<unknown>) => {
        await t.test(name, async () => {
          try { probes.push({ name, verdict: "pass", details: await run() }); }
          catch (e) { probes.push({ name, verdict: "fail", details: String(e) }); throw e; }
        });
        assert.equal(probes.at(-1)?.verdict, "pass", "stop at first failed probe");
      };
      const clock = async () => (await admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at as string;
      const job = async (kind: "ingest" | "normalize") => (await startJob(writer, {
        kind, codeSha: code.gitSha, policySha256: code.contentSha256, inputSetSha256: sha256(Buffer.from(randomUUID())),
      })).jobId;
      const finish = async (id: string, failed = false) => {
        await finishJob(writer, id, { counts: {}, ...(failed ? { errorCode: "intentional-probe-failure" } : {}) });
        return (await writer.query("SELECT finished_at::text AS at FROM fs138.job_runs WHERE job_id=$1", [id])).rows[0].at as string;
      };
      const seed = async (previous?: Revision, value = 100): Promise<Revision> => {
        const source = await job("ingest"), normalizer = await job("normalize");
        const hash = sha256(Buffer.from(source)), player = previous?.player ?? randomUUID(), game = previous?.game ?? "2025_01_" + randomUUID();
        await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
          VALUES($1,'synthetic','stats',$2,'{}')`, [source, NORMALIZER_VERSION]);
        const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
          decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
          VALUES($1::text,$1::uuid,$2::text,1,'raw/'||$2::text,'text/csv',$2::text,$2::text,4,clock_timestamp(),clock_timestamp(),'retrospective') RETURNING snapshot_id`, [source, hash])).rows[0].snapshot_id;
        // A future target keeps this fixture's strict event boundary after the
        // real producer clocks, without backdating any stored knowledge clock.
        await writer.query(`INSERT INTO fs138.norm_schedule VALUES($1,$2,$3,$4,2025,1,'REG',clock_timestamp()+interval '2 hours','TB','DAL',20,10,'usable','{}')`, [snapshot, NORMALIZER_VERSION, normalizer, game]);
        await writer.query(`INSERT INTO fs138.norm_player_game_stats VALUES($1,$2,$3,$4,$5,'DAL',30,$6,'usable','{}')`, [snapshot, NORMALIZER_VERSION, normalizer, player, game, value]);
        await writer.query(`INSERT INTO fs138.norm_identity VALUES($1,$2,$3,$4,2025,1,'DAL','Clock QB','QB','usable','{}')`, [snapshot, NORMALIZER_VERSION, normalizer, player]);
        await writer.query(`INSERT INTO fs138.norm_participation VALUES($1,$2,$3,$4,$5,10,'usable','{}')`, [snapshot, NORMALIZER_VERSION, normalizer, player, game]);
        return { source, normalizer, snapshot, player, game };
      };
      const read = async (revision: Revision, at: string, mode: EvidenceMode) => {
        const before = queryCounts.reader;
        const rows = await readNormalizedAsOf(reader, { cutoff: at, checkpoint: at, mode });
        assert.equal(queryCounts.reader - before, 1);
        return rows.filter(r => r.snapshotIds.includes(revision.snapshot) || (r.naturalKey.includes(revision.player) || r.naturalKey === revision.game));
      };
      const assertRevision = (rows: Awaited<ReturnType<typeof read>>, expected: Revision) => {
        assert.equal(rows.length, 4); assert.deepEqual(rows.map(r => r.feed).sort(), ["participation", "roster", "schedule", "stats"]);
        for (const row of rows) { assert.deepEqual(row.snapshotIds, [expected.snapshot]); assert.equal(row.state, "usable"); }
      };
      const scope = async (at: string, purpose: string) => (await writer.query("SELECT snapshot_id FROM fs138.qb_job_snapshot_ids(2025,$1,$2,$3) ORDER BY snapshot_id", [at, purpose, NORMALIZER_VERSION])).rows.map(r => r.snapshot_id);
      const context = async (at: string, mode: EvidenceMode, purpose: string) => (await writer.query("SELECT * FROM fs138.qb_job_context(2025,$1,$2,$3,$4)", [at, mode, purpose, NORMALIZER_VERSION])).rows;

      for (const delayed of ["source", "normalizer"] as const) {
        await check(`${delayed}: four families replay before finish, inclusive microseconds, scope and discovery agree`, async () => {
          const old = await seed(); await finish(old.source); await finish(old.normalizer);
          const next = await seed(old, 222); await finish(next[delayed === "source" ? "normalizer" : "source"]);
          const pin = await clock();
          for (const mode of modes) assertRevision(await read(next, pin, mode), old);
          for (const purpose of ["features", "labels"]) assert(!(await scope(pin, purpose)).includes(next.snapshot));
          const finished = await finish(next[delayed]);
          const times = (await admin.query(`SELECT ($1::timestamptz-interval '1 microsecond')::text AS before,$1::timestamptz::text AS exact,
            ($1::timestamptz+interval '1 microsecond')::text AS after`, [finished])).rows[0];
          for (const mode of modes) {
            assertRevision(await read(next, pin, mode), old);
            for (const [boundary, at] of Object.entries(times)) assertRevision(await read(next, at as string, mode), boundary === "before" ? old : next);
            for (const purpose of ["features", "labels"]) {
              assert(!(await scope(pin, purpose)).includes(next.snapshot));
              assert((await scope(times.exact, purpose)).includes(next.snapshot));
              const before = (await context(pin, mode, purpose)).filter(r => r.player_id === old.player && r.game_id === old.game && r.context_game_id === old.game);
              const after = (await context(times.exact, mode, purpose)).filter(r => r.player_id === old.player && r.game_id === old.game && r.context_game_id === old.game);
              assert.equal(before.length, 1); assert.equal(after.length, 1);
              assert.equal(before[0].yards, 100); assert.equal(after[0].yards, 222);
            }
          }
          return { delayed, pin, finished, families: 4, modes: 2, purposes: 2, statementsPerNormalizedRead: 1, alteredClocks: false };
        });
      }
      await check("running/failed normalized and source owners never hide the previous valid head", async () => {
        const old = await seed(); await finish(old.source); await finish(old.normalizer);
        for (const delayed of ["source", "normalizer"] as const) {
          const next = await seed(old, 333); await finish(next[delayed === "source" ? "normalizer" : "source"]);
          for (const mode of modes) assertRevision(await read(next, await clock(), mode), old);
          await finish(next[delayed], true);
          for (const mode of modes) assertRevision(await read(next, await clock(), mode), old);
          for (const purpose of ["features", "labels"]) assert(!(await scope(await clock(), purpose)).includes(next.snapshot));
        }
        return { runningAndFailedExcluded: true, bothOwners: true, families: 4 };
      });
      await check("strict per-game context falls back when a later job finishes after the event boundary", async () => {
        const old = await seed(); await finish(old.source); await finish(old.normalizer);
        const boundary = await clock();
        // Only the synthetic event clock changes. All knowledge clocks retain
        // the ordinary triggers. A late revision must not win strict ranking.
        await admin.query("UPDATE fs138.norm_schedule SET kickoff=$2::timestamptz+interval '1 hour' WHERE snapshot_id=$1", [old.snapshot, boundary]);
        const next = await seed(old, 444);
        await admin.query("UPDATE fs138.norm_schedule SET kickoff=$2::timestamptz+interval '1 hour' WHERE snapshot_id=$1", [next.snapshot, boundary]);
        await finish(next.source); await finish(next.normalizer);
        const at = await clock();
        const strict = (await context(at, modes[1], "features")).find(r => r.player_id === old.player && r.game_id === old.game && r.context_game_id === old.game);
        const retrospective = (await context(at, modes[0], "features")).find(r => r.player_id === old.player && r.game_id === old.game && r.context_game_id === old.game);
        assert.equal(strict.yards, 100); assert.equal(retrospective.yards, 444);
        return { boundary, checkpoint: at, strictYards: strict.yards, retrospectiveYards: retrospective.yards };
      });
      await check("one normalized statement inlines and keeps the legacy data projection", async () => {
        const at = await clock(); const plans = [];
        for (const mode of modes) {
          const plan = (await reader.query("EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + NORMALIZED_AS_OF_SQL, [at, at, mode, NORMALIZER_VERSION])).rows[0]["QUERY PLAN"][0];
          const nodes = visibilityPlanNodes(plan.Plan);
          assert(!nodes.some(n => n["Node Type"] === "Function Scan" && n["Function Name"] === "completed_jobs_at"));
          assert(!nodes.some(n => n["Node Type"] === "LockRows"));
          plans.push({ mode, plan });
        }
        const columns = (await reader.query("SELECT * FROM fs138.normalized_evidence LIMIT 1")).fields.map(f => f.name);
        assert.deepEqual(columns, ["feed", "natural_key", "snapshot_id", "normalizer_version", "data", "profile_id", "available_at", "ingested_at"]);
        return { plans, legacyColumns: columns, helperFunctionScans: 0, locks: 0 };
      });
      await check("new producer uses eight statements, authoritative plan inputs and atomic rollback", async () => {
        for (const mode of modes) for (const kind of ["features", "labels"] as const) {
          const at = await clock(), expected = await scope(at, kind), before = queryCounts.writer;
          const result = await runDerivedJob(writer, kind, { season: 2025, mode, checkpoint: at }, code);
          assert.equal(result.status, "succeeded"); assert.equal(queryCounts.writer - before, 8);
          const inputs = (await reader.query("SELECT snapshot_id FROM fs138.job_inputs WHERE job_id=$1 ORDER BY snapshot_id", [result.jobId])).rows.map(r => r.snapshot_id);
          assert.deepEqual(inputs, expected);
        }
        const before = (await reader.query("SELECT count(*)::integer AS n FROM fs138.feature_values")).rows[0].n;
        await admin.query("REVOKE INSERT ON fs138.feature_inputs FROM fs138_pipeline_writer");
        try { await assert.rejects(runDerivedJob(writer, "features", { season: 2025, mode: modes[0], checkpoint: await clock() }, code), { code: "42501" }); }
        finally { await admin.query("GRANT INSERT ON fs138.feature_inputs TO fs138_pipeline_writer"); }
        assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.feature_values")).rows[0].n, before);
        const failed = (await reader.query("SELECT job_id FROM fs138.job_runs WHERE kind='features' AND status='failed'")).rows;
        assert.equal(failed.length, 1);
        assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.job_inputs WHERE job_id=$1", [failed[0].job_id])).rows[0].n, 0);
        return { newProducerSql: 8, perExampleQueries: 0, partialOutputs: 0, partialLineage: 0, authoritativeInputs: true };
      });
    });
  } finally {
    if (process.env.FEATURE_STORE_241_STEP3_EVIDENCE_PATH) {
      const files = ["packages/db/proposals/138_feature_store.sql", "packages/db/proposals/241_job_visibility.sql",
        "services/pipeline/src/featureStore/asOf.ts", "services/pipeline/src/featureStore/derived.ts",
        "services/pipeline/tests/feature-store/job-visibility-producer.check.mts"];
      const sourceHashes = Object.fromEntries(await Promise.all(files.map(async p => [p, sha256(await readFile(new URL("../../../../" + p, import.meta.url)))])));
      await writeFile(process.env.FEATURE_STORE_241_STEP3_EVIDENCE_PATH, JSON.stringify({ issue: 241, step: 3, runtime: process.version,
        recordedAt: new Date().toISOString(), verdict: probes.length === 6 && probes.every(p => p.verdict === "pass") ? "pass" : "fail", sourceHashes, probes }, null, 2) + "\n", { flag: "wx" });
    }
  }
});
