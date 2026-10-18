import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { Client, type ClientConfig } from "pg";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { prepareMigrationContext } from "../../scripts/db-migrations/plans.mjs";
import { createScratchHarness } from "../db/scratch.mjs";
import { finishJob, startJob } from "../../src/lib/featureStore/jobs.ts";

// This opt-in suite never bootstraps a hosted target or mutates the shared test
// schema. Each run applies main + the proposal in its own registered scratch DB.
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const proposal = await readFile(new URL("../../db/proposals/138_feature_store.sql", import.meta.url), "utf8");
const tables = ["source_profiles", "rights_decisions", "job_runs", "source_snapshots", "job_inputs",
  "norm_schedule", "norm_player_game_stats", "norm_identity", "norm_participation",
  "feature_values", "feature_inputs", "outcome_labels", "label_inputs",
  "dataset_manifests", "dataset_members", "dataset_inputs", "deletion_events", "object_removals", "orphan_observations"];
const identity = { kind: "normalize" as const, codeSha: "a".repeat(40), policySha256: digest("policy"), inputSetSha256: digest("inputs") };
const codePaths = ["db/proposals/138_feature_store.sql", "src/lib/featureStore/objectStore.ts",
  "src/lib/featureStore/localObjectStore.ts", "src/lib/featureStore/jobs.ts", "tests/feature-store/schema.check.mts"];
const codeHashes = Object.fromEntries(await Promise.all(codePaths.map(async (path) =>
  [path, digest(await readFile(new URL("../../" + path, import.meta.url), "utf8"))])));
const evidence: { probe: string; verdict: string; details: unknown }[] = [];

test("#138 proposal: main isolation, trusted writer, database clocks and idempotent jobs", { timeout: 120_000 }, async (t) => {
  const harness = await createScratchHarness(process.env);
  const logins: Client[] = [];
  const names: string[] = [];
  const check = async (name: string, run: () => Promise<unknown>) => {
    await t.test(name, async () => {
      try { const details = await run(); evidence.push({ probe: name, verdict: "pass", details: details ?? null }); }
      catch (error) { evidence.push({ probe: name, verdict: "fail", details: String(error) }); throw error; }
    });
  };
  try {
    await harness.withDatabase(async (admin: Client, config: ClientConfig) => {
      try {
        const files = await checkMigrationArtifacts();
        const context = await prepareMigrationContext(files, await loadCatalogContracts(files));
        const verify = createCatalogVerifier(context.contracts);
        await runScratchMigrations(admin, { expected: config, files: context.files, assertTarget: harness.assertTarget, verify });
        const server = (await admin.query("SELECT version() AS version")).rows[0].version;

        await check("proposal application rolls back cleanly and leaves main unchanged", async () => {
          await admin.query("BEGIN");
          try { await admin.query(proposal); await admin.query(await readFile(new URL("../../db/proposals/138_dataset_governance.sql", import.meta.url), "utf8")); } finally { await admin.query("ROLLBACK"); }
          assert.equal((await admin.query("SELECT to_regnamespace('fs138') AS schema")).rows[0].schema, null);
          await verify(admin, files.length);
          await admin.query("BEGIN");
          try { await admin.query(proposal); await admin.query(await readFile(new URL("../../db/proposals/138_dataset_governance.sql", import.meta.url), "utf8")); await admin.query("COMMIT"); }
          catch (error) { await admin.query("ROLLBACK"); throw error; }
          await verify(admin, files.length);
          return { orderedMigrations: files.length, proposalSha256: digest(proposal), server };
        });

        const login = async (role: "fs138_reader" | "fs138_pipeline_writer") => {
          const name = "fs138_test_" + randomBytes(8).toString("hex");
          // Public throwaway password, loopback disposable server only.
          await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'fs138_throwaway' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          names.push(name);
          await admin.query(`GRANT ${role} TO ${name}`);
          const client = new Client({ ...config, user: name, password: "fs138_throwaway" });
          logins.push(client);
          await client.connect();
          return client;
        };
        const writer = await login("fs138_pipeline_writer");
        const reader = await login("fs138_reader");
        const writer2 = await login("fs138_pipeline_writer");
        let jobId: string;
        let snapshotId: string;

        await check("real non-pipeline login cannot forge, overwrite, delete or escalate", async () => {
          const flags = (await reader.query(`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
            FROM pg_roles WHERE rolname = current_user`)).rows[0];
          assert.equal(flags.rolsuper || flags.rolcreatedb || flags.rolcreaterole || flags.rolbypassrls, false);
          for (const table of tables) {
            for (const sql of [`INSERT INTO fs138.${table} DEFAULT VALUES`, `DELETE FROM fs138.${table}`, `TRUNCATE fs138.${table}`]) {
              await assert.rejects(reader.query(sql), { code: "42501" });
            }
            const firstColumn = (await admin.query(`SELECT attname FROM pg_attribute
              WHERE attrelid = $1::regclass AND attnum = 1`, ["fs138." + table])).rows[0].attname;
            await assert.rejects(reader.query(`UPDATE fs138.${table} SET ${firstColumn} = ${firstColumn}`), { code: "42501" });
          }
          await assert.rejects(reader.query("SET ROLE fs138_pipeline_writer"), { code: "42501" });
          await assert.rejects(reader.query("CREATE TABLE fs138.forged (value integer)"), { code: "42501" });
          await assert.rejects(reader.query("ALTER TABLE fs138.job_runs DISABLE TRIGGER ALL"), { code: "42501" });
          return { authenticatedNonSuperuser: true, derivedTables: tables.filter((name) => name.startsWith("norm_")), mutationRefusals: tables.length * 4 + 3 };
        });

        await check("pipeline inserts use DB knowledge clocks and cannot later be backdated", async () => {
          const before = (await admin.query("SELECT clock_timestamp() AS clock")).rows[0].clock;
          await writer.query(`INSERT INTO fs138.source_profiles
            (profile_id, provider, feed, parser_version, license, recorded_at)
            VALUES ('fixture-stats', 'synthetic', 'stats', 'test-v1', '{"status":"test-only"}', '1900-01-01')`);
          const job = await startJob(writer, identity);
          assert.equal(job.created, true);
          jobId = job.jobId;
          const result = await writer.query(`INSERT INTO fs138.source_snapshots
            (profile_id, job_id, sha256, byte_size, object_key, media_type, decoded_sha256, header_sha256,
             row_count, captured_at, available_at, ingested_at, evidence_basis)
            VALUES ('fixture-stats', $1, $2::text, 10, 'raw/' || $2::text, 'text/csv', $2::text, $2::text,
             1, '2026-01-01', '2021-01-01', '1900-01-01', 'retrospective') RETURNING snapshot_id`, [jobId, digest("snapshot")]);
          snapshotId = result.rows[0].snapshot_id;
          const checked = (await admin.query(`SELECT
            (SELECT recorded_at >= $1 FROM fs138.source_profiles WHERE profile_id = 'fixture-stats') AS profile,
            (SELECT recorded_at >= $1 FROM fs138.job_runs WHERE job_id = $2) AS job,
            (SELECT ingested_at >= $1 FROM fs138.source_snapshots WHERE snapshot_id = $3) AS snapshot`, [before, jobId, snapshotId])).rows[0];
          assert.deepEqual(checked, { profile: true, job: true, snapshot: true });
          await assert.rejects(writer.query("UPDATE fs138.source_snapshots SET ingested_at = '1900-01-01'"), { code: "42501" });
          await assert.rejects(writer.query("UPDATE fs138.job_runs SET recorded_at = '1900-01-01'"), { code: "42501" });
          await assert.rejects(writer.query("ALTER TABLE fs138.source_snapshots DISABLE TRIGGER ALL"), { code: "42501" });
          return checked;
        });

        await check("backdated valid-time rights do not enter an earlier knowledge-time answer", async () => {
          const cutoff = (await admin.query("SELECT clock_timestamp() AS clock")).rows[0].clock;
          const decision = (await writer.query(`INSERT INTO fs138.rights_decisions
            (profile_id, allowed_uses, valid_from, rationale, recorded_at)
            VALUES ('fixture-stats', ARRAY['research'], '2021-01-01', 'synthetic test', '1900-01-01') RETURNING decision_id`)).rows[0];
          const historical = await reader.query(`SELECT decision_id FROM fs138.rights_decisions
            WHERE profile_id = 'fixture-stats' AND valid_from <= '2022-01-01' AND recorded_at <= $1`, [cutoff]);
          assert.equal(historical.rowCount, 0);
          assert.equal((await reader.query("SELECT decision_id FROM fs138.rights_decisions")).rows[0].decision_id, decision.decision_id);
          await assert.rejects(writer.query("UPDATE fs138.rights_decisions SET recorded_at = '1900-01-01'"), { code: "42501" });
          return { earlierAnswerCount: historical.rowCount, currentDecisionCount: 1 };
        });

        await check("only pipeline logins publish normalized values and normalized rows are immutable", async () => {
          const values = [snapshotId, jobId];
          await writer.query(`INSERT INTO fs138.norm_schedule VALUES
            ($1, 'v1', $2, 'game', 2021, 1, 'REG', '2021-09-12T17:00:00Z', 'HOME', 'AWAY', 10, 20, 'usable', '{}')`, values);
          await writer.query(`INSERT INTO fs138.norm_player_game_stats VALUES
            ($1, 'v1', $2, 'player', 'game', 'HOME', 30, 250, 'usable', '{}')`, values);
          await writer.query(`INSERT INTO fs138.norm_identity VALUES
            ($1, 'v1', $2, 'player', 2021, 1, 'HOME', 'Synthetic QB', 'QB', 'usable', '{}')`, values);
          await writer.query(`INSERT INTO fs138.norm_participation VALUES
            ($1, 'v1', $2, 'player', 'game', 50, 'usable', '{}')`, values);
          for (const table of tables.filter((name) => name.startsWith("norm_"))) {
            assert.equal((await reader.query(`SELECT count(*)::int AS n FROM fs138.${table}`)).rows[0].n, 1);
            await assert.rejects(writer.query(`UPDATE fs138.${table} SET normalizer_version = 'forged'`), { code: "42501" });
            await assert.rejects(writer.query(`DELETE FROM fs138.${table}`), { code: "42501" });
          }
          return { publishedFamilies: 4, readerCanSelect: true, pipelineUpdateDeleteRefusals: 8 };
        });

        await check("concurrent idempotent jobs have one executor and distinct policies remain distinct", async () => {
          const next = { ...identity, inputSetSha256: digest("concurrent-inputs") };
          const results = await Promise.all([startJob(writer, next), startJob(writer2, next)]);
          assert.equal(results.filter((result) => result.created).length, 1);
          assert.equal(results[0].jobId, results[1].jobId);
          await finishJob(writer, results[0].jobId, { counts: { rows: 1 } });
          assert.deepEqual(await startJob(writer, next), { created: false, jobId: results[0].jobId, status: "succeeded" });
          const changed = await startJob(writer, { ...next, policySha256: digest("different-policy") });
          assert.equal(changed.created, true);
          assert.notEqual(changed.jobId, results[0].jobId);
          return { concurrentExecutors: 1, successfulRetryRecomputed: false, changedPolicyCreated: true };
        });

        await check("job completion is DB-stamped and terminal jobs cannot be rewritten", async () => {
          const before = (await admin.query("SELECT clock_timestamp() AS clock")).rows[0].clock;
          await writer.query(`UPDATE fs138.job_runs SET status = 'succeeded', finished_at = '1900-01-01' WHERE job_id = $1`, [jobId]);
          assert.equal((await reader.query("SELECT finished_at >= $2 AS valid FROM fs138.job_runs WHERE job_id = $1", [jobId, before])).rows[0].valid, true);
          await assert.rejects(writer.query("UPDATE fs138.job_runs SET counts = '{}' WHERE job_id = $1", [jobId]), { code: "23514" });
          await assert.rejects(finishJob(writer, jobId, { counts: {} }), /job-finish-refused/);
          await assert.rejects(writer.query(`INSERT INTO fs138.job_runs
            (kind, code_sha, policy_sha256, input_set_sha256, status, finished_at)
            VALUES ('audit', $1, $2, $2, 'succeeded', '1900-01-01')`, [identity.codeSha, digest("terminal")]), { code: "23514" });
          return { callerCompletionTimeIgnored: true, terminalMutationRefused: true };
        });

        await check("proposal leaves main catalog and frozen migration hashes unchanged", async () => {
          await verify(admin, files.length);
          await checkMigrationArtifacts();
          return { mainCatalogVerified: true, orderedMigrations: files.length };
        });
      } finally { await Promise.all(logins.splice(0).map((client) => client.end())); }
    });
  } finally {
    try { await Promise.all(logins.map((client) => client.end())); }
    finally {
      // The scratch database has already been dropped by withDatabase, so these
      // throwaway login roles have no owned objects/dependencies left.
      const { parseTestDatabaseUrl } = await import("../db/target.mts");
      const cleanup = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
      try {
        await cleanup.connect();
        for (const name of names) await cleanup.query(`DROP ROLE ${name}`);
      } finally { await cleanup.end(); await harness.close(); }
    }
    if (process.env.FEATURE_STORE_EVIDENCE_PATH) {
      await writeFile(process.env.FEATURE_STORE_EVIDENCE_PATH, JSON.stringify({
        schemaVersion: 1, issue: 138, step: 2, recordedAt: new Date().toISOString(),
        runtime: process.version, proposalSha256: digest(proposal), codeHashes,
        workload: "synthetic role/clock/identity probes on main + proposal; no real-source evaluation or capacity claim",
        verdict: evidence.length === 8 && evidence.every((probe) => probe.verdict === "pass") ? "pass" : "fail", probes: evidence,
      }, null, 2) + "\n");
    }
  }
});
