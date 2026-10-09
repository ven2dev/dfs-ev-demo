import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEASE_REQUIRED_CASES, READINESS_REQUIRED_CASES, PREDICTIVE_REQUIRED_CASES, validateLeaseDbReport, validateNodeDbReport,
  validateReadinessDbReport, validatePredictiveDbReport } from "../../scripts/db-test-contract.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const reporter = fileURLToPath(new URL("../../scripts/db-test-reporter.mjs", import.meta.url));
const fixtureNames = ["required first", "required second"];

async function runFixture(source, options = []) {
  const directory = await mkdtemp(join(tmpdir(), "dfs-ev-db-report-"));
  const file = join(directory, "cases.mjs");
  try {
    await writeFile(file, 'import { test } from "node:test";\n' + source);
    // NODE_TEST_CONTEXT inherited from this test would bypass CLI reporting.
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=" + reporter, ...options, file],
      { encoding: "utf8", timeout: 10_000, cwd: root, env: { PATH: process.env.PATH } });
    assert.ifError(result.error);
    return { report: JSON.parse(result.stdout), status: result.status,
      required: { [relative(root, await realpath(file))]: fixtureNames } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Node DB report requires each named case in its original file and a complete successful summary", async () => {
  const { report, required, status } = await runFixture('test("required first", () => {}); test("required second", () => {});');
  assert.equal(status, 0);
  assert.equal(validateNodeDbReport(report, required), 2);
  for (const mutate of [
    (value) => { delete value.summary; },
    (value) => { value.summary.success = false; },
    (value) => { value.summary.counts.cancelled = 1; },
    (value) => { value.assertions[0].file = "wrong-file.mjs"; },
    (value) => { value.assertions[0].nesting = 1; },
    (value) => { value.assertions.push(value.assertions[0]); },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => validateNodeDbReport(changed, required), /DB test contract failed/);
  }
});

test("Vitest DB report requires the readiness cases independently of the existing 13 lease cases", () => {
  const assertions = [...LEASE_REQUIRED_CASES, ...READINESS_REQUIRED_CASES]
    .map((fullName) => ({ fullName, status: "passed" }));
  const report = { success: true, numPassedTests: assertions.length,
    testResults: [{ assertionResults: assertions }] };
  assert.equal(validateLeaseDbReport(report), 13);
  assert.equal(validateReadinessDbReport(report), 4);
  for (const fullName of READINESS_REQUIRED_CASES) {
    const remaining = assertions.filter((row) => row.fullName !== fullName);
    const changed = { ...report, numPassedTests: remaining.length, testResults: [{ assertionResults: remaining }] };
    assert.equal(validateLeaseDbReport(changed), 13);
    assert.throws(() => validateReadinessDbReport(changed), /DB test contract failed/);
  }
});

test("Vitest DB report requires every predictive persistence case independently of lease and readiness cases", () => {
  const assertions = [...LEASE_REQUIRED_CASES, ...READINESS_REQUIRED_CASES, ...PREDICTIVE_REQUIRED_CASES]
    .map((fullName) => ({ fullName, status: "passed" }));
  const report = { success: true, numPassedTests: assertions.length, testResults: [{ assertionResults: assertions }] };
  assert.equal(validatePredictiveDbReport(report), PREDICTIVE_REQUIRED_CASES.length);
  for (const fullName of PREDICTIVE_REQUIRED_CASES) {
    for (const status of ["missing", "skipped", "todo", "failed"]) {
      const changed = assertions.flatMap((row) => row.fullName !== fullName ? [row] : status === "missing" ? [] : [{ ...row, status }]);
      assert.throws(() => validatePredictiveDbReport({ ...report, numPassedTests: changed.length,
        testResults: [{ assertionResults: changed }] }), /DB test contract failed/);
    }
  }
});

test("actual Node reports refuse zero, filtered, missing, skipped, todo and failed cases", async () => {
  for (const [source, options, status] of [
    ["", [], 0],
    ['test("required first", () => {}); test("required second", () => {});', ["--test-name-pattern=first"], 0],
    ['test("required first", () => {});', [], 0],
    ['test("required first", () => {}); test.skip("required second", () => {});', [], 0],
    ['test("required first", () => {}); test.todo("required second");', [], 0],
    ['test("required first", () => {}); test("required second", () => { throw new Error("synthetic failure"); });', [], 1],
  ]) {
    const result = await runFixture(source, options);
    assert.equal(result.status, status);
    assert.throws(() => validateNodeDbReport(result.report, result.required), /DB test contract failed/);
  }
});

test("Vitest DB report preserves all required lease cases and refuses missing, skipped, todo or failed results", () => {
  assert.equal(LEASE_REQUIRED_CASES.length, 13);
  const report = { success: true, numPassedTests: 13, testResults: [{
    assertionResults: LEASE_REQUIRED_CASES.map((fullName) => ({ fullName, status: "passed" })),
  }] };
  assert.equal(validateLeaseDbReport(report), 13);
  for (const status of ["pending", "skipped", "todo", "failed"]) {
    const changed = structuredClone(report);
    changed.testResults[0].assertionResults[0].status = status;
    assert.throws(() => validateLeaseDbReport(changed), /DB test contract failed/);
  }
  for (const assertions of [[], report.testResults[0].assertionResults.slice(1),
    [...report.testResults[0].assertionResults.slice(1), report.testResults[0].assertionResults[1]]]) {
    assert.throws(() => validateLeaseDbReport({ ...report, numPassedTests: assertions.length,
      testResults: [{ assertionResults: assertions }] }), /DB test contract failed/);
  }
});
