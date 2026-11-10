import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { startDatabaseTestRun } from "@dfs-ev/db-tooling/test-support/lifecycle";
import { assertNoApplicationCredentials, getTestDatabaseLane, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";

const execute = promisify(execFile);
const script = "scripts/db/test-db.mjs";
const container = async (lane) => (await execute("docker", [
  "ps", "--all", "--no-trunc", "--quiet", "--filter", `label=com.docker.compose.project=${lane.project}`,
])).stdout.trim();

const withLaneDatabase = async (lane, action) => {
  const client = new Client(parseTestDatabaseUrl(lane.url, lane.name));
  try { await client.connect(); return await action(client); }
  finally { await client.end(); }
};

test("a non-default lane startup sweep and teardown leave another lane intact", {
  skip: process.env.DB_TEST_LANE_PROOF !== "1",
  timeout: 120_000,
}, async () => {
  assertNoApplicationCredentials(process.env);
  const lanes = ["lane-2", "lane-3"].map((name) => ({ ...getTestDatabaseLane(name), name }));
  const [swept, protectedLane] = lanes;
  const env = (lane, tier = "standard") => ({
    ...process.env, DB_TEST_LANE: lane.name, DB_TEST_TIER: tier, TEST_DATABASE_URL: lane.url,
  });
  const cli = (lane, mode, tier) => execute(process.execPath, [script, mode], { env: env(lane, tier), timeout: 75_000 });
  for (const lane of lanes) assert.equal(await container(lane), "", `${lane.name} must be unused`);

  const owned = new Set();
  const sentinel = "dfs_ev_test_247_lane_sentinel";
  const exists = (lane) => withLaneDatabase(lane, async (client) => {
    const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS present", [sentinel]);
    return rows[0].present;
  });
  let evidence;
  try {
    for (const lane of lanes) {
      owned.add(lane);
      await cli(lane, "up");
      await withLaneDatabase(lane, (client) => client.query(`CREATE DATABASE ${sentinel}`));
    }
    const ids = await Promise.all(lanes.map(container));
    assert.ok(ids.every(Boolean));
    assert.notEqual(ids[0], ids[1]);
    const versions = await Promise.all(lanes.map((lane) => withLaneDatabase(lane, async (client) => {
      const { rows } = await client.query("SHOW server_version");
      return rows[0].server_version;
    })));

    await assert.rejects(cli(swept, "up", "large"), /Existing DB test fixture uses another disk tier/);
    assert.equal(await container(swept), ids[0]);
    const lease = await startDatabaseTestRun(env(swept));
    try {
      assert.equal(await exists(swept), false);
      assert.equal(await exists(protectedLane), true);
      assert.equal(await container(protectedLane), ids[1]);
    } finally { await lease.close(); }

    await cli(swept, "down");
    owned.delete(swept);
    assert.equal(await container(swept), "");
    assert.equal(await container(protectedLane), ids[1]);
    assert.equal(await exists(protectedLane), true);
    // On the same now-idle lane, prove the override uses the same registered port.
    owned.add(swept);
    await cli(swept, "up", "large");
    const largeId = await container(swept);
    assert.ok(largeId);
    const { stdout } = await execute("docker", ["exec", largeId, "df", "-k", "/var/lib/postgresql"]);
    const largeTmpfsBytes = Number(stdout.trim().split("\n").at(-1).trim().split(/\s+/)[1]) * 1024;
    assert.equal(largeTmpfsBytes, 2 * 1024 ** 3);
    assert.equal(await exists(protectedLane), true);

    evidence = {
      issue: 247, checkpoint: 1,
      codeBaseSha: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
      candidate: "working-tree checkpoint changes on codeBaseSha",
      lanes: lanes.map(({ name, port, project }, index) => ({ name, port, project, serverVersion: versions[index] })),
      sweepRemovedOnlySelectedSentinel: true,
      teardownPreservedOtherContainerAndSentinel: true,
      runningTierChangeRefused: true,
      largeTierReusedSelectedPort: await withLaneDatabase(swept, async (client) =>
        (await client.query("SELECT current_database() AS name")).rows[0].name === "dfs_ev_test"),
      largeTmpfsBytes,
    };
    assert.equal(evidence.largeTierReusedSelectedPort, true);
  } finally {
    const cleanup = await Promise.allSettled([...owned].map((lane) => cli(lane, "down")));
    assert.ok(cleanup.every(({ status }) => status === "fulfilled"), "lane cleanup failed");
  }
  for (const lane of lanes) assert.equal(await container(lane), "");
  if (process.env.DB_TEST_LANE_PROOF_RECEIPT) {
    await writeFile(process.env.DB_TEST_LANE_PROOF_RECEIPT, JSON.stringify({ ...evidence, cleanupVerified: true }, null, 2) + "\n", { flag: "wx" });
  }
});
