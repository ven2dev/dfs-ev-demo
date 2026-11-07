import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { NORMALIZED_AS_OF_SQL } from "../../src/featureStore/asOf.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { loadJobVisibilityWorkFixture } from "./job-visibility-work-fixture.ts";
import { visibilityPlanNodes } from "./job-visibility-work.ts";
import { assertProducerContext } from "./job-visibility-producer-work.ts";

test("#241 live producer context work ceiling and final relational parity", { timeout: 180_000 }, async () => {
  const record: Record<string, unknown> = { issue: 241, step: 3, verdict: "fail", runtime: process.version };
  try {
    await withFeatureStoreDatabase(async database => {
      const { writer, reader, admin } = database;
      assert.match((await admin.query("SELECT version() AS v")).rows[0].v, /PostgreSQL 18\.6\b/);
      const loaded = await loadJobVisibilityWorkFixture(database); record.fixture = loaded.manifest;
      const at = loaded.spec.featuresAsOf, mode = loaded.spec.mode;
      const text = "SELECT * FROM fs138.qb_job_context(2025,$1,$2,'features',$3)", values = [at, mode, NORMALIZER_VERSION];
      const plan = (await writer.query("EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + text, values)).rows[0]["QUERY PLAN"][0];
      record.contextPlan = plan; record.contextBudget = assertProducerContext(plan);
      const repeated = structuredClone(plan), extra = structuredClone(plan);
      visibilityPlanNodes(repeated.Plan).find(n => n["Subplan Name"] === "CTE requests")!["Actual Loops"] = 2;
      extra.Plan["Shared Read Blocks"] = 1_745_395;
      assert.throws(() => assertProducerContext(repeated), /requests once/); assert.throws(() => assertProducerContext(extra), /hits\+reads/);
      record.negativeControls = { repeatedCteRefused: true, excessWorkRefused: true };

      // The legacy projection is the pre-fix normalized result after all jobs
      // complete. Compare exact ordered rows; no historical-clock claim.
      const legacy = (await reader.query(`WITH ranked AS (SELECT *,dense_rank() OVER(PARTITION BY feed,natural_key ORDER BY available_at DESC,ingested_at DESC) AS rank
        FROM fs138.normalized_evidence WHERE normalizer_version=$1) SELECT feed,natural_key,snapshot_id,data FROM ranked WHERE rank=1 ORDER BY feed,natural_key,snapshot_id`, [NORMALIZER_VERSION])).rows;
      const normalized = (await reader.query(NORMALIZED_AS_OF_SQL, [at, at, mode, NORMALIZER_VERSION])).rows;
      assert.equal(normalized.length, 103468); assert.deepEqual(normalized, legacy);
      record.normalizedParity = { rows: normalized.length, sha256: sha256(Buffer.from(JSON.stringify(normalized))), statements: 1 };

      // Full-season materialization belongs to the explicit 2 GiB opt-in
      // plan suite; CI observes this read-only context on the standard disk.
      record.verdict = "pass";
    });
  } finally {
    if (process.env.FEATURE_STORE_241_PRODUCER_WORK_PATH) {
      const files = ["packages/db/proposals/138_feature_store.sql", "packages/db/proposals/241_job_visibility.sql", "services/pipeline/src/featureStore/asOf.ts",
        "services/pipeline/src/featureStore/derived.ts", "services/pipeline/tests/feature-store/job-visibility-producer-work.check.mts", "services/pipeline/tests/feature-store/job-visibility-producer-work.ts"];
      record.sourceHashes = Object.fromEntries(await Promise.all(files.map(async p => [p, sha256(await readFile(new URL("../../../../" + p, import.meta.url)))])));
      record.recordedAt = new Date().toISOString(); await writeFile(process.env.FEATURE_STORE_241_PRODUCER_WORK_PATH, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    }
  }
});
