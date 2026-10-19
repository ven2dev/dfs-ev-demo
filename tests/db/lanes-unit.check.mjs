import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { databaseTestWorkers } from "../../scripts/db-test-workers.mjs";
import { validateDatabaseReport, SERIAL_FILES } from "../../scripts/db-test-lanes.mjs";

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
    (r) => { r.testResults[0].name = resolve("tests/db/unexpected.test.ts"); },
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
  const files = (await readdir("tests/db", { recursive: true })).filter((file) => file.endsWith(".test.ts"))
    .map((file) => "tests/db/" + file).sort();
  const assigned = [...SERIAL_FILES].sort();
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(assigned, files);
});
