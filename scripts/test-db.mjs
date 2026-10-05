import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const requiredTests = [
  "bootstraps the full application schema twice on PostgreSQL 18",
  ...["cold", "stale"].flatMap((state) => [
    `25 independent clients acquire exactly one ${state}-row lease`,
    `observes all 24 contenders blocked behind a held ${state}-row acquisition transaction`,
  ]),
  "a valid renewal extends the lease and prevents competing takeover",
  "25 independent clients produce exactly one takeover of a forced expired lease",
  "characterization: an expired owner may renew before any takeover",
  "characterization: an expired owner may publish before any takeover",
  "a replaced owner cannot renew, write, or release the new owner's lease",
  "an expired owner's write committed first makes all blocked takeovers fail",
  "a takeover committed first makes the blocked former-owner write lose its lease",
  "25 database-backed consumers wait for one fetch and receive the same persisted payload",
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
    const reportPath = join(reportDir, "results.json");
    const code = await run(process.execPath, [
      fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", "vitest.db.config.mts", "--reporter=default",
      "--reporter=json", "--outputFile.json=" + reportPath, ...filters,
    ], environment);
    if (code !== 0) return code;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    if (!report.success || report.numPassedTests < requiredTests.length ||
        assertions.some((test) => test.status !== "passed") ||
        requiredTests.some((name) => !assertions.some((test) => test.fullName === name && test.status === "passed"))) {
      throw new Error("DB test contract failed: required cases must execute and pass; skipped/todo or missing cases are failures.");
    }
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
