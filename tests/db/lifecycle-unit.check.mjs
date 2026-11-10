import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const execute = promisify(execFile);
test("a failed Compose up still attempts Compose down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-db-lifecycle-"));
  const log = join(directory, "commands.jsonl");
  try {
    await writeFile(join(directory, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.DB_TEST_LIFECYCLE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(process.argv.includes("up") ? 7 : 0);
`, { mode: 0o700 });
    await assert.rejects(execute(process.execPath, ["scripts/db/test-db.mjs", "local"], {
      env: { HOME: process.env.HOME, PATH: directory + ":" + process.env.PATH, DB_TEST_LIFECYCLE_LOG: log }, timeout: 10000,
    }), (error) => error.code === 1);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("up"));
    assert.ok(calls[1].includes("down"));
    assert.ok(calls[1].includes("--volumes"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("disk admission uses measured tier thresholds and refuses an unverified WAL mount", async () => {
  const { requireDatabaseDiskBudget } = await import("../../scripts/db/db-test-disk.mjs");
  const output = (capacity, free, walMount = "/var/lib/postgresql") => [
    `tmpfs ${capacity * 1024} ${(capacity - free) * 1024} ${free * 1024} 50% /var/lib/postgresql`,
    `tmpfs ${capacity * 1024} ${(capacity - free) * 1024} ${free * 1024} 50% ${walMount}`,
    "98304 /var/lib/postgresql/18/docker/pg_wal",
  ].join("\n");
  for (const [tier, capacity, required] of [["standard", 512, 272], ["large", 2048, 608]]) {
    const options = { tier, project: "dfs-ev-demo-test-lane-2" };
    assert.equal(requireDatabaseDiskBudget(output(capacity, required), options).requiredFreeBytes, required * 1024 ** 2);
    assert.throws(() => requireDatabaseDiskBudget(output(capacity, required - 1), options),
      new RegExp(`requires ${required} MiB free, available ${required - 1}\\.0 MiB, retained WAL 96\\.0 MiB.*Exclusive lane ownership`));
    assert.throws(() => requireDatabaseDiskBudget(output(capacity, required, "/unbudgeted"), options), /data and WAL tmpfs/);
    assert.throws(() => requireDatabaseDiskBudget(output(capacity + 1, required), options), /verify the .* tmpfs/);
  }
});
