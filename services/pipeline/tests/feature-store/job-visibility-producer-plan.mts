import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { FEATURE_JOB_SQL, FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { loadJobVisibilityWorkFixture } from "./job-visibility-work-fixture.ts";
import { visibilityPlanNodes } from "./job-visibility-work.ts";

// Opt-in only: deliberately not *.check.mts, so the standard CI glob cannot
// execute full-season materialization. The measured runner supplies the actual
// Docker mount size; refuse before connecting if its prerequisite is missing.
test("#241 opt-in full-season materialization plan and parity", { timeout: 180_000 }, async () => {
  assert.equal(process.env.FEATURE_STORE_241_FULL_PLAN, "1", "explicit full-plan opt-in required");
  assert(Number(process.env.FEATURE_STORE_241_TMPFS_BYTES) >= 2_147_483_648, "full materialization requires the measured 2 GiB spike mount");
  const record: Record<string, unknown> = { issue: 241, step: 3, verdict: "fail", runtime: process.version,
    actualMountBytes: Number(process.env.FEATURE_STORE_241_TMPFS_BYTES), composeOverride: "compose.feature-store-spike.yml" };
  try {
    await withFeatureStoreDatabase(async database => {
      const { writer, reader } = database;
      const loaded = await loadJobVisibilityWorkFixture(database); record.fixture = loaded.manifest;
      const at = loaded.spec.featuresAsOf, mode = loaded.spec.mode;
      const job = await startJob(writer, { kind: "features", codeSha: "c".repeat(40), policySha256: sha256(Buffer.from("241 work materialization")), inputSetSha256: sha256(Buffer.from(at)) });
      const ids = (await writer.query("SELECT snapshot_id FROM fs138.qb_job_snapshot_ids(2025,$1,'features',$2) ORDER BY snapshot_id", [at, NORMALIZER_VERSION])).rows.map(r => r.snapshot_id);
      const projection = "player_id,game_id,stat,season,cutoff,feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps";
      const existing = (await reader.query(`SELECT ${projection} FROM fs138.feature_values WHERE season=2025 AND evidence_mode=$1 ORDER BY player_id,game_id`, [mode])).rows;
      assert.equal(existing.length, 1948);
      await writer.query("BEGIN");
      try {
        const materialized = (await writer.query("EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + FEATURE_JOB_SQL,
          [job.jobId, 2025, at, mode, NORMALIZER_VERSION, FEATURE_VERSION, HISTORY_POLICY, ids])).rows[0]["QUERY PLAN"][0];
        record.materializationPlan = materialized;
        const nodes = visibilityPlanNodes(materialized.Plan);
        for (const name of ["histories", "gaps"]) {
          const found = nodes.filter(n => n["Subplan Name"] === "CTE " + name); assert.equal(found.length, 1);
          assert.equal(found[0]["Actual Loops"], 1); assert((found[0]["Actual Rows"] as number) > 0);
        }
        assert(!nodes.some(n => n["Node Type"] === "Function Scan" && n["Function Name"] === "completed_jobs_at"));
        const actual = (await writer.query(`SELECT ${projection} FROM fs138.feature_values WHERE job_id=$1 ORDER BY player_id,game_id`, [job.jobId])).rows;
        assert.deepEqual(actual, existing);
        const inputs = (await writer.query("SELECT count(*)::integer AS n FROM fs138.feature_inputs i JOIN fs138.feature_values f USING(feature_id) WHERE f.job_id=$1", [job.jobId])).rows[0].n;
        assert.equal(inputs, 1948 * 16);
        record.producerParity = { rows: actual.length, sha256: sha256(Buffer.from(JSON.stringify(actual))), inputs, snapshots: ids.length, historiesLoops: 1, gapsLoops: 1 };
      } finally { await writer.query("ROLLBACK"); }
      await finishJob(writer, job.jobId, { counts: {}, errorCode: "work-probe-intentionally-rolled-back" });
      assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.feature_values WHERE job_id=$1", [job.jobId])).rows[0].n, 0);
      record.verdict = "pass";
    });
  } finally {
    if (process.env.FEATURE_STORE_241_FULL_PLAN_PATH) {
      const files = ["packages/db/proposals/138_feature_store.sql", "packages/db/proposals/241_job_visibility.sql",
        "services/pipeline/src/featureStore/derived.ts", "services/pipeline/tests/feature-store/job-visibility-producer-plan.mts"];
      record.sourceHashes = Object.fromEntries(await Promise.all(files.map(async p => [p, sha256(await readFile(new URL("../../../../" + p, import.meta.url)))])));
      record.recordedAt = new Date().toISOString(); await writeFile(process.env.FEATURE_STORE_241_FULL_PLAN_PATH, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    }
  }
});
