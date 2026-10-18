import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { databaseTestWorkers } from "../../scripts/db-test-workers.mjs";
import { mergeDatabaseReports, SERIAL_FILES, SCRATCH_FILES } from "../../scripts/db-test-lanes.mjs";

const report = (files) => ({ success: true, numTotalTests: files.length, numPassedTests: files.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: files.map((file) => ({ name: resolve(file), status: "passed",
    assertionResults: [{ fullName: file + " case", status: "passed" }] })) });

test("DB worker allocation bounds overlapping lanes by CPU count and serializes a single CPU", () => {
  for (const cpus of [1, 2, 3, 4, 8, 12, 64]) {
    const workers = databaseTestWorkers(cpus);
    assert.equal(workers.overlap, cpus > 1);
    assert.ok(workers.nodeWorkers >= 1 && workers.scratchWorkers >= 1);
    if (workers.overlap) assert.ok(workers.nodeWorkers + workers.scratchWorkers <= cpus);
  }
  assert.deepEqual(databaseTestWorkers(4), { availableCPUs: 4, nodeWorkers: 1, scratchWorkers: 3, overlap: true });
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => databaseTestWorkers(value));
});

test("DB lane aggregation refuses partial, failed, skipped, duplicate and wrongly selected output", () => {
  const serial = report(SERIAL_FILES), scratch = report(SCRATCH_FILES);
  assert.equal(mergeDatabaseReports(serial, scratch).numPassedTests, SERIAL_FILES.length + SCRATCH_FILES.length);
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
    (r) => { r.testResults[0].assertionResults[0].fullName = serial.testResults[0].assertionResults[0].fullName; },
    (r) => { r.testResults[0].assertionResults = []; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(scratch); mutate(changed);
    assert.throws(() => mergeDatabaseReports(serial, changed));
  }
  assert.throws(() => mergeDatabaseReports(serial, null));
});


test("every DB test file belongs to exactly one lane", async () => {
  const files = (await readdir("tests/db", { recursive: true })).filter((file) => file.endsWith(".test.ts"))
    .map((file) => "tests/db/" + file).sort();
  const assigned = [...SERIAL_FILES, ...SCRATCH_FILES].sort();
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(assigned, files);
});
