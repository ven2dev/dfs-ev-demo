import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SERIAL_FILES = Object.freeze(["packages/db/tooling/tests/bootstrap.test.ts", "packages/db/tooling/tests/lease.test.ts",
  "apps/web/tests/db/orchestrator.test.ts", "packages/db/tooling/tests/readiness.test.ts", "packages/db/tooling/tests/corpus.test.ts", "services/pipeline/tests/creator/corpusImport.test.ts"]);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

// Every retained file must execute. Missing/failed/skipped/duplicated results
// cannot be hidden by a successful summary or another suite.
export const validateDatabaseReport = (report) => {
  const names = new Set();
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults);
  const expected = new Set(SERIAL_FILES.map((file) => resolve(root, file)));
  if (report?.success !== true || !Array.isArray(assertions) ||
      report.numTotalTests !== assertions.length || report.numPassedTests !== assertions.length ||
      ["numFailedTests", "numPendingTests", "numTodoTests"].some((key) => (report[key] ?? 0) !== 0) ||
      report.testResults.length !== expected.size) throw new Error("Incomplete DB report.");
  for (const file of report.testResults) {
    if (!expected.delete(file.name) || file.status !== "passed" || !file.assertionResults.length) throw new Error("Unexpected or incomplete DB file.");
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "passed" || !assertion.fullName || names.has(assertion.fullName)) throw new Error("Failed or duplicate DB case.");
      names.add(assertion.fullName);
    }
  }
  if (expected.size) throw new Error("Missing DB file.");
  return { success: true, numTotalTests: names.size, numPassedTests: names.size, testResults: report.testResults };
};
