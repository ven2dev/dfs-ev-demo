import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_REQUIRED_CASES, validateLeaseDbReport, validateNodeDbReport, validateReadinessDbReport, validatePredictiveDbReport } from "./db-test-contract.mjs";
import {
  assertNoApplicationCredentials,
  LOCAL_TEST_DATABASE_URL,
  parseTestDatabaseUrl,
} from "../tests/db/target.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const composeArgs = [
  "compose", "--env-file", "/dev/null", "--project-name", "dfs-ev-demo-test",
  "-f", fileURLToPath(new URL("../compose.test.yml", import.meta.url)),
];
let activeChild;
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    activeChild?.kill("SIGTERM");
  });
}

function run(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
    activeChild = child;
    child.on("error", reject);
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      resolve(code ?? 1);
    });
  });
}

async function runSuite(environment, filters) {
  assertNoApplicationCredentials(environment);
  parseTestDatabaseUrl(environment.TEST_DATABASE_URL);
  const reportDir = await mkdtemp(join(tmpdir(), "dfs-ev-db-test-"));
  try {
    let code = await run(process.execPath, ["scripts/db-migration-artifacts.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    code = await run(process.execPath, ["scripts/db-readiness-manifest.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    const nodeReportPath = join(reportDir, "node-results.json");
    code = await run(process.execPath, [
      "--test", "--test-concurrency=4", "--test-timeout=60000",
      "--test-reporter=spec", "--test-reporter=./scripts/db-test-reporter.mjs",
      "--test-reporter-destination=stdout", "--test-reporter-destination=" + nodeReportPath,
      ...Object.keys(NODE_REQUIRED_CASES),
    ], environment);
    if (code !== 0 || interrupted) return code || 1;
    const nodeRequiredCases = validateNodeDbReport(JSON.parse(await readFile(nodeReportPath, "utf8")));
    code = await run(process.execPath, ["scripts/db-catalog-contracts.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    const reportPath = join(reportDir, "results.json");
    code = await run(process.execPath, [
      fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", "vitest.db.config.mts", "--reporter=default",
      "--reporter=json", "--outputFile.json=" + reportPath, ...filters,
    ], environment);
    if (code !== 0 || interrupted) return code || 1;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const leaseRequiredCases = validateLeaseDbReport(report);
    const readinessRequiredCases = validateReadinessDbReport(report);
    const predictiveRequiredCases = validatePredictiveDbReport(report);
    console.log(JSON.stringify({ nodeRequiredCases, leaseRequiredCases, readinessRequiredCases, predictiveRequiredCases, result: "verified" }));
    return 0;
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, ...filters] = process.argv.slice(2);
  if (mode === "down") return run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
  assertNoApplicationCredentials(process.env);
  if (mode === "run") return runSuite(process.env, filters);
  if (mode !== "local" && mode !== "repeat") throw new Error("Expected DB test mode: run, local, repeat, or down.");
  const repetitions = mode === "repeat" ? Number(filters.shift() ?? 20) : 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100 || (mode === "repeat" && filters.length)) {
    throw new Error("DB repetitions must be an integer from 1 to 100 with no test filters.");
  }

  // Local/CI lifecycle uses only the Compose service's public test URL.
  // A supplied override must agree with it; don't start one DB and test another.
  if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== LOCAL_TEST_DATABASE_URL) {
    throw new Error("test:db:local uses its fixed disposable database; use test:db for another validated loopback target.");
  }
  let result = 1;
  try {
    const started = await run("docker", [...composeArgs, "up", "-d", "--wait", "--wait-timeout", "60"]);
    if (started === 0 && !interrupted) {
      for (let index = 0; index < repetitions && !interrupted; index++) {
        if (mode === "repeat") console.log(`DB suite repetition ${index + 1}/${repetitions}`);
        result = await runSuite({ ...process.env, TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }, filters);
        if (result !== 0) break;
      }
    }
  } finally {
    const cleaned = await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
    if (cleaned !== 0) result = 1;
  }
  return result;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "DB test harness failed.");
  process.exitCode = 1;
}
if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
