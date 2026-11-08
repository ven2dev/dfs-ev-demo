import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { checkConnectedTarget } from "@dfs-ev/db-tooling/migrations/core";
import { parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { readReplayBaseline } from "../../scripts/feature-store/replay-restore.ts";
import { parseObjectKey, sha256 } from "../../src/featureStore/objectStore.ts";

const execute = promisify(execFile);
const command = "services/pipeline/scripts/feature-store/recompute-replay.ts";
const sourceName = "fs244_source";

test("qualifies the committed replay CLI twice and verifies missing and corrupt input refusal", { timeout: 480_000 }, async () => {
  const target = parseReplayDatabaseTarget(process.env);
  const root = process.env.FS244_OBJECT_ROOT;
  const out = process.env.FS244_QUALIFICATION_DIR;
  assert.ok(root && isAbsolute(root), "set FS244_OBJECT_ROOT to the pinned local fixture");
  assert.ok(out && isAbsolute(out), "set FS244_QUALIFICATION_DIR to a fresh private directory");
  assert.equal(await realpath(out), out);
  assert.equal((await lstat(out)).mode & 0o077, 0);
  const { records } = await readReplayBaseline();
  const base = new Client(target);
  await base.connect();
  const role = "fs244_probe_" + randomBytes(8).toString("hex");
  const password = randomBytes(16).toString("hex");
  let databaseCreated = false;
  let roleCreated = false;
  try {
    await checkConnectedTarget(base, target);
    await base.query("CREATE DATABASE fs244_source");
    databaseCreated = true;
    const catalog = new Client({ ...target, database: sourceName });
    try {
      await catalog.connect();
      for (const sql of ["138_feature_store.sql", "138_dataset_governance.sql", "163_effective_rights.sql"]) {
        await catalog.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${sql}`)), "utf8"));
      }
      await catalog.query("BEGIN");
      try {
        await catalog.query("INSERT INTO fs138.source_profiles SELECT * FROM jsonb_populate_recordset(NULL::fs138.source_profiles,$1)",
          [JSON.stringify(records.source_profiles)]);
        const inputOwners = new Set(records.source_snapshots.map(({ job_id }) => job_id));
        const jobs = records.job_runs.filter(({ job_id }) => inputOwners.has(job_id))
          .map((job) => ({ ...job, status: "running", finished_at: null }));
        await catalog.query("INSERT INTO fs138.job_runs SELECT * FROM jsonb_populate_recordset(NULL::fs138.job_runs,$1)", [JSON.stringify(jobs)]);
        await catalog.query("INSERT INTO fs138.source_snapshots SELECT * FROM jsonb_populate_recordset(NULL::fs138.source_snapshots,$1)",
          [JSON.stringify(records.source_snapshots)]);
        await catalog.query("UPDATE fs138.job_runs SET status='succeeded'");
        await catalog.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
          SELECT profile_id, ARRAY['research'], now()-interval '1 minute', 'synthetic replay qualification'
          FROM fs138.source_profiles`);
        await catalog.query("COMMIT");
      } catch (error) { await catalog.query("ROLLBACK"); throw error; }
      await catalog.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      roleCreated = true;
      await catalog.query(`GRANT fs138_reader TO ${role}`);
    } finally { await catalog.end(); }

    const sourceUrl = new URL(`postgresql://${target.host}:${target.port}/${sourceName}`);
    sourceUrl.username = role;
    sourceUrl.password = password;
    const noScratch = async () => {
      const { rows: [result] } = await base.query("SELECT count(*)::int AS n FROM pg_database WHERE starts_with(datname,'dfs_ev_test_')");
      assert.equal(result.n, 0, "replay scratch database remained after CLI exit");
    };
    const run = async (objectRoot: string, receipt: string) => {
      try {
        const result = await execute(process.execPath, [command, "--root", objectRoot, "--receipt", receipt], {
          env: { ...process.env, FS244_SOURCE_DATABASE_URL: sourceUrl.href }, timeout: 210_000,
        });
        return { exitCode: 0, stdout: result.stdout, reason: null };
      } catch (error) {
        const failure = error as { code?: number; stderr?: string };
        const diagnostic = failure.stderr?.trim().split("\n").findLast((line) => line.startsWith('{"status":"failed"'));
        if (!diagnostic || typeof failure.code !== "number") throw new Error("replay CLI did not return a typed diagnostic");
        return { exitCode: failure.code, stdout: "", reason: JSON.parse(diagnostic).reason as string };
      } finally { await noScratch(); }
    };
    const firstPath = join(out, "checkpoint-3-replay-1.json");
    const secondPath = join(out, "checkpoint-3-replay-2.json");
    for (const path of [firstPath, secondPath]) {
      const result = await run(root, path);
      assert.equal(result.exitCode, 0, result.reason ?? "");
      console.log(result.stdout.trim().split("\n").at(-1));
    }
    const raw = await Promise.all([firstPath, secondPath].map((path) => readFile(path)));
    const [first, second] = raw.map((bytes) => JSON.parse(bytes.toString()));
    assert.equal(first.status, "replay-verified");
    assert.equal(second.status, "replay-verified");
    assert.deepEqual(first.code, second.code);
    assert.equal(first.code.dirty, false);
    assert.deepEqual(first.normalized.normalizedParity, second.normalized.normalizedParity);
    assert.deepEqual(first.derived, second.derived);
    for (const receipt of [first, second]) {
      assert.equal(receipt.normalized.verifiedObjects, 16);
      assert.equal(receipt.normalized.normalizedRows, 103468);
      assert.equal(receipt.derived.materializations, 20);
      const memory = receipt.normalized.memory;
      assert.equal(memory.samples.length, 16);
      assert.ok(memory.peakArrayBuffers <= memory.largestObjectBytes + memory.slackBytes, JSON.stringify(memory));
      for (const { beforeRead, afterRelease } of memory.samples) {
        assert.ok(Math.max(beforeRead, afterRelease) <= memory.baselineArrayBuffers + memory.slackBytes);
      }
    }

    const absentRoot = join(out, "missing-input");
    const corruptRoot = join(out, "corrupt-input");
    await mkdir(absentRoot, { mode: 0o700 });
    await mkdir(corruptRoot, { mode: 0o700 });
    const firstKey = String(records.source_snapshots[0].object_key);
    const { namespace } = parseObjectKey(firstKey);
    await mkdir(join(corruptRoot, namespace), { mode: 0o700 });
    await writeFile(join(corruptRoot, firstKey), Buffer.alloc(Number(records.source_snapshots[0].byte_size)),
      { mode: 0o600, flag: "wx" });
    const refusals = [];
    for (const [name, fixture, reason] of [
      ["missing local object", absentRoot, "replay-object-missing"],
      ["same-size corrupt local object", corruptRoot, "replay-object-corrupt"],
    ]) {
      const path = join(out, "refused.json");
      const result = await run(fixture, path);
      assert.equal(result.exitCode, 1);
      assert.equal(result.reason, reason);
      await assert.rejects(readFile(path), { code: "ENOENT" });
      refusals.push({ test: name, exitCode: result.exitCode, reason: result.reason });
    }
    await base.query("DROP DATABASE fs244_source WITH (FORCE)");
    databaseCreated = false;
    await base.query(`DROP ROLE ${role}`);
    roleCreated = false;
    await noScratch();
    const wrapper = {
      issue: 244, checkpoint: 3, scope: "Committed CLI, exact local wire pins and disposable source catalog with synthetic research grants.",
      receipts: raw.map((bytes, index) => ({ file: `checkpoint-3-replay-${index + 1}.json`, sha256: sha256(bytes) })),
      rerun: { normalizedAndDerivedHashesMatched: true, normalizedRows: 103468, contexts: 20 },
      scratchCleanup: "No scratch databases remained after each command. The source database and its reader role were removed.",
      refusals,
      memory: [first, second].map((receipt) => ({
        heapUsedAfterBaseline: receipt.memoryAfterBaseline.heapUsed,
        arrayBuffersAfterBaseline: receipt.memoryAfterBaseline.arrayBuffers,
        peakPayloadSampleArrayBuffers: receipt.normalized.memory.peakArrayBuffers,
        peakRssBytes: receipt.peakRssBytes,
      })),
      memoryContext: "Heap after baseline load includes the parsed graph and V8 parsing overhead. The process also holds staged normalized rows, producer results, and Node and PostgreSQL client allocations. RSS is a process peak, not a payload measurement.",
    };
    await writeFile(join(out, "checkpoint-3-qualification.json"), JSON.stringify(wrapper, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ refusals, memory: wrapper.memory }));
  } finally {
    try {
      if (databaseCreated) await base.query("DROP DATABASE fs244_source WITH (FORCE)");
      if (roleCreated) await base.query(`DROP ROLE ${role}`);
    } finally { await base.end(); }
  }
});
