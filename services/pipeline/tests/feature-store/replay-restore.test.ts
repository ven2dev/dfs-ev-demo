import { expect, it, vi } from "vitest";
import { assertReplayScratchTarget, getTestDatabaseLane, parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { restoreReplayMetadata } from "../../scripts/feature-store/replay-restore.ts";

const env: NodeJS.ProcessEnv = { NODE_ENV: "test", DB_TEST_LANE: "lane-2", DB_TEST_TIER: "large", TEST_DATABASE_URL: getTestDatabaseLane("lane-2").url };
const base = parseReplayDatabaseTarget(env);
const scratch = { ...base, database: "dfs_ev_test_" + "a".repeat(20) };
const unusedRecords = {} as Parameters<typeof restoreReplayMetadata>[1];

it("refuses an app, foreign lane or non-scratch endpoint before any ALTER TABLE", async () => {
  const registered = vi.fn();
  for (const [environment, config] of [
    [env, base],
    [env, { ...scratch, host: "example.invalid" }],
    [env, { ...scratch, port: getTestDatabaseLane("lane-3").port }],
    [{ ...env, DATABASE_URL: "private-value" }, scratch],
    [{ ...env, DB_TEST_TIER: "standard" }, scratch],
  ] as const) {
    expect(() => assertReplayScratchTarget(environment, config, registered)).toThrow();
  }
  expect(registered).not.toHaveBeenCalled();
});

it("requires the active harness registration even for a correctly shaped scratch name", async () => {
  const query = vi.fn();
  const registered = vi.fn(() => { throw new Error("Unregistered scratch target refused."); });
  expect(() => assertReplayScratchTarget(env, scratch, registered)).toThrow("Unregistered scratch target refused.");
  await expect(restoreReplayMetadata({ query }, unusedRecords)).rejects.toThrow("Unregistered replay scratch client refused.");
  expect(registered).toHaveBeenCalledWith(scratch);
  expect(query).not.toHaveBeenCalled();
});
