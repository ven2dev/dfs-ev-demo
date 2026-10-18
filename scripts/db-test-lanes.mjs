import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SCRATCH_FILES = Object.freeze(["tests/db/sourceClaims.test.ts", "tests/db/sourceDecisions.test.ts",
  "tests/db/sourceConsumers.test.ts", "tests/db/predictive.test.ts"]);
export const SERIAL_FILES = Object.freeze(["tests/db/bootstrap.test.ts", "tests/db/lease.test.ts",
  "tests/db/orchestrator.test.ts", "tests/db/readiness.test.ts", "tests/db/corpus.test.ts", "tests/db/corpusImport.test.ts"]);
const root = fileURLToPath(new URL("../", import.meta.url));

// Each report is fresh and belongs to exactly one complete lane. A successful
// sibling cannot hide a missing/failed/duplicated file or incomplete summary.
export function mergeDatabaseReports(serial, scratch) {
  const names = new Set();
  for (const [report, files] of [[serial, SERIAL_FILES], [scratch, SCRATCH_FILES]]) {
    const assertions = report?.testResults?.flatMap((file) => file.assertionResults);
    const expected = new Set(files.map((file) => resolve(root, file)));
    if (report?.success !== true || !Array.isArray(assertions) ||
        report.numTotalTests !== assertions.length || report.numPassedTests !== assertions.length ||
        ["numFailedTests", "numPendingTests", "numTodoTests"].some((key) => (report[key] ?? 0) !== 0) ||
        report.testResults.length !== expected.size) throw new Error("Incomplete DB lane report.");
    for (const file of report.testResults) {
      if (!expected.delete(file.name) || file.status !== "passed" || !file.assertionResults.length) throw new Error("Unexpected or incomplete DB lane file.");
      for (const assertion of file.assertionResults) {
        if (assertion.status !== "passed" || !assertion.fullName || names.has(assertion.fullName)) throw new Error("Failed or duplicate DB lane case.");
        names.add(assertion.fullName);
      }
    }
    if (expected.size) throw new Error("Missing DB lane file.");
  }
  return { success: true, numTotalTests: names.size, numPassedTests: names.size,
    testResults: [...serial.testResults, ...scratch.testResults] };
}
