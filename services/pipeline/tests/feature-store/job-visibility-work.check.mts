import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { DATASET_JOIN_SQL, datasetContentSha256, type DatasetRow, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { loadJobVisibilityWorkFixture } from "./job-visibility-work-fixture.ts";
import { assertDatasetVisibilityPlan, DATASET_SLICE_BUDGET, jobPageBudget, visibilityPlanNodes, type JobPageBudget, type VisibilityPlanNode } from "./job-visibility-work.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";

test("#241 live dataset current-head CI plan and buffer budgets on pinned real graph", { timeout: 120_000 }, async () => {
  const plans: unknown[] = [];
  let verdict = "fail", fixture: unknown;
  try {
    const full = process.env.FEATURE_STORE_241_FULL_DATASET === "1";
    if (full) assert(Number(process.env.FEATURE_STORE_241_TMPFS_BYTES) >= 2_147_483_648, "full dataset plan requires measured 2 GiB opt-in");
    await withFeatureStoreDatabase(async database => {
      const { admin, writer, reader } = database;
      assert.match((await admin.query("SELECT version() AS version")).rows[0].version, /PostgreSQL 18\.6\b/, "review fixture/server change before remeasurement");
      const loaded = await loadJobVisibilityWorkFixture(database, full ? "full" : "dataset-ci"); fixture = loaded.manifest;
      if (!full) assert.equal(loaded.manifest.modes[0].contentSha256, DATASET_SLICE_BUDGET.contentSha256, "slice budget/content pin");
      const values = (spec: DatasetSpec) => [spec.featureVersion, spec.labelVersion, spec.historyPolicy, spec.mode,
        spec.featuresAsOf, spec.labelsAsOf, spec.includeRetrospective, spec.includeSuperseded];
      const run = async (name: string, spec: DatasetSpec) => {
        // Observer transaction only, outside all product work counts. ANALYZE,
        // the reader-role plan and its heap/index sizes share one transaction.
        await admin.query("BEGIN");
        try {
          await admin.query("ANALYZE fs138.job_runs,fs138.feature_values,fs138.outcome_labels");
          await admin.query("SET LOCAL ROLE fs138_reader");
          const plan = (await admin.query("EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + DATASET_JOIN_SQL, values(spec))).rows[0]["QUERY PLAN"][0] as { Plan: VisibilityPlanNode };
          const record: { name: string; plan: typeof plan; jobPages?: JobPageBudget; budget?: unknown; negativeControls?: unknown } = { name, plan }; plans.push(record);
          record.jobPages = await jobPageBudget(admin, plan);
          record.budget = assertDatasetVisibilityPlan(plan, record.jobPages, loaded.manifest.naturalKeys);
          const twice = structuredClone(plan), extraPage = structuredClone(plan);
          const current = (p: typeof plan) => visibilityPlanNodes(p.Plan).find(n => n["Subplan Name"] === "CTE current_jobs")!;
          current(twice)["Actual Loops"] = 2;
          current(extraPage)["Shared Read Blocks"] = record.jobPages.ceiling + 1;
          assert.throws(() => assertDatasetVisibilityPlan(twice, record.jobPages!, loaded.manifest.naturalKeys), /current_jobs must execute once/);
          assert.throws(() => assertDatasetVisibilityPlan(extraPage, record.jobPages!, loaded.manifest.naturalKeys), /current_jobs: buffer hits\+reads/);
          for (const scope of ["root", "current_f", "current_l"]) {
            const excessive = structuredClone(plan);
            const node = scope === "root" ? excessive.Plan : visibilityPlanNodes(excessive.Plan).find(n => n["Subplan Name"] === "CTE " + scope)!;
            node["Shared Hit Blocks"] = 1_000_000;
            assert.throws(() => assertDatasetVisibilityPlan(excessive, record.jobPages!, loaded.manifest.naturalKeys), /buffer hits/);
          }
          record.negativeControls = { repeatedMaterializationRefused: true, extraPageRefused: true };
          await admin.query("COMMIT");
        } catch (error) { await admin.query("ROLLBACK"); throw error; }
        return (await reader.query<{ rows: DatasetRow[] }>(DATASET_JOIN_SQL, values(spec))).rows[0].rows;
      };
      for (const mode of ["retrospective-reconstruction-v1", "strict-point-in-time-v1"] as const) {
        const spec = { ...loaded.spec, mode };
        const rows = await run(mode, spec), expected = loaded.manifest.modes.find((m: { mode: string }) => m.mode === mode);
        assert.equal(rows.length, expected.rows); assert.equal(datasetContentSha256(spec, rows), expected.contentSha256);
      }
      const old = (await reader.query<{ rows: DatasetRow[] }>(DATASET_JOIN_SQL, values(loaded.spec))).rows[0].rows[0]; assert(old);
      const digest = sha256(Buffer.from("241 real active correction work proof"));
      const job = await startJob(writer, { kind: "features", codeSha: "c".repeat(40), policySha256: digest, inputSetSha256: digest });
      await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,evidence_mode,
        state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
        SELECT $1,player_id,game_id,stat,season,cutoff,clock_timestamp(),feature_version,history_policy,evidence_mode,
        'unavailable',ARRAY['241-active-correction'],flags,sample_size,history,history_gaps,feature_id FROM fs138.feature_values WHERE feature_id=$2`, [job.jobId, old.featureId]);
      await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,
        state,reasons,flags,value,supersedes_id)
        SELECT $1,player_id,game_id,stat,season,clock_timestamp(),label_version,evidence_mode,
        'unavailable',ARRAY['241-active-correction'],flags,NULL,label_id FROM fs138.outcome_labels WHERE label_id=$2`, [job.jobId, old.labelId]);
      await finishJob(writer, job.jobId, { counts: { activeFeature: 1, activeLabel: 1 } });
      await writer.query("ANALYZE fs138.job_runs,fs138.feature_values,fs138.outcome_labels");
      const active = await run("real-active-corrections", loaded.spec), selected = active.find(r => r.featureId === old.featureId); assert(selected);
      assert.equal(active.length, loaded.manifest.modes[0].rows); assert.equal(selected.labelId, old.labelId);
      for (const flag of ["stale-feature", "superseded-feature", "stale-label", "superseded-label"]) assert(selected.flags.includes(flag), "active branch: " + flag);
      assert.equal(datasetContentSha256(loaded.spec, active), loaded.manifest.modes[0].contentSha256);
      verdict = "pass";
    });
  } finally {
    if (process.env.FEATURE_STORE_241_WORK_EVIDENCE_PATH) {
      const paths = ["services/pipeline/src/featureStore/datasets.ts", "packages/db/proposals/241_job_visibility.sql",
        "services/pipeline/tests/feature-store/job-visibility-work.check.mts", "services/pipeline/tests/feature-store/job-visibility-work.ts",
        "services/pipeline/tests/feature-store/job-visibility-work-fixture.ts", "services/pipeline/tests/feature-store/fixtures/job-visibility-ci-slice-v1.json",
        "services/pipeline/tests/feature-store/fixtures/job-visibility-work-v1.manifest.json"];
      const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
      await writeFile(process.env.FEATURE_STORE_241_WORK_EVIDENCE_PATH, JSON.stringify({ issue: 241, step: 2, kind: "live-dataset-work-budgets",
        runtime: process.version, recordedAt: new Date().toISOString(), verdict, fixture, sourceHashes, plans }, null, 2) + "\n", { flag: "wx" });
    }
  }
});
