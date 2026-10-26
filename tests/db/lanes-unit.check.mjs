import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { databaseTestWorkers } from "../../scripts/db/db-test-workers.mjs";
import { validateDatabaseReport, SERIAL_FILES } from "../../scripts/db/db-test-lanes.mjs";

const report = (files) => ({ success: true, numTotalTests: files.length, numPassedTests: files.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: files.map((file) => ({ name: resolve(file), status: "passed",
    assertionResults: [{ fullName: file + " case", status: "passed" }] })) });

test("DB Node worker allocation remains bounded by CPU count", () => {
  for (const cpus of [1, 2, 3, 4, 8, 12, 64]) {
    const workers = databaseTestWorkers(cpus);
    assert.equal(workers.availableCPUs, cpus);
    assert.equal(workers.nodeWorkers, Math.max(1, Math.floor(cpus / 4)));
    assert.ok(workers.nodeWorkers <= cpus);
  }
  assert.deepEqual(databaseTestWorkers(4), { availableCPUs: 4, nodeWorkers: 1 });
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => databaseTestWorkers(value));
});

test("DB report validation refuses partial, failed, skipped, duplicate and wrongly selected output", () => {
  const serial = report(SERIAL_FILES);
  assert.equal(validateDatabaseReport(serial).numPassedTests, SERIAL_FILES.length);
  const mutations = [
    (r) => { r.success = false; },
    (r) => { r.numPassedTests--; },
    (r) => { r.numTotalTests++; },
    (r) => { r.numPendingTests = 1; },
    (r) => { r.numTodoTests = 1; },
    (r) => { r.numFailedTests = 1; },
    (r) => { r.testResults.pop(); },
    (r) => { r.testResults[0].status = "failed"; },
    (r) => { r.testResults[0].assertionResults[0].status = "pending"; },
    (r) => { r.testResults[0].name = r.testResults[1].name; },
    (r) => { r.testResults[0].name = resolve("packages/db/tooling/tests/unexpected.test.ts"); },
    (r) => { r.testResults[1].assertionResults[0].fullName = r.testResults[0].assertionResults[0].fullName; },
    (r) => { r.testResults[0].assertionResults = []; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(serial); mutate(changed);
    assert.throws(() => validateDatabaseReport(changed));
  }
  assert.throws(() => validateDatabaseReport(null));
});


test("every retained DB test file belongs to the serial suite", async () => {
  const directories = ["packages/db/tooling/tests", "tests/db", "services/pipeline/tests/creator"];
  const files = (await Promise.all(directories.map(async (directory) =>
    (await readdir(directory, { recursive: true })).filter((file) => file.endsWith(".test.ts") && !file.startsWith("unit/"))
      .map((file) => directory + "/" + file)))).flat().sort();
  const assigned = [...SERIAL_FILES].sort();
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(assigned, files);
});


test("generic DB tooling unit tests cannot enter the PostgreSQL serial lane", async () => {
  const config = await (await import("node:fs/promises")).readFile("vitest.db.config.mts", "utf8");
  assert.match(config, /exclude: \["packages\/db\/tooling\/tests\/unit\/\*\*"\]/);
  assert.ok(!SERIAL_FILES.some((file) => file.startsWith("packages/db/tooling/tests/unit/")));
});
