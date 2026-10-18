import { startDatabaseTestRun } from "../tests/db/startup.mts";
import { createTemplateRun } from "../tests/db/templates.mts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_REQUIRED_CASES, validateCorpusDbReport, validateLeaseDbReport, validateNodeDbReport, validateReadinessDbReport, validatePredictiveDbReport } from "./db-test-contract.mjs";
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
const stop = new AbortController();
let activeChild;
let interrupted;
const lostLock = () => { stop.abort(); activeChild?.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    stop.abort();
    activeChild?.kill("SIGTERM");
  });
}

function run(command, args, environment = process.env, signal) {
  if (signal?.aborted) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit", signal });
    activeChild = child;
    let failure;
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      if (failure) reject(failure);
      else resolve(code ?? 1);
    });
  });
}

async function runSuite(environment, filters, leaseSignal) {
  assertNoApplicationCredentials(environment);
  parseTestDatabaseUrl(environment.TEST_DATABASE_URL);
  leaseSignal.throwIfAborted();
  const reportDir = await mkdtemp(join(tmpdir(), "dfs-ev-db-test-"));
  let templates;
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
    code = await run(process.execPath, ["--test", "--test-timeout=60000", "tests/db/templates.integration.check.mjs"], environment);
    if (code !== 0 || interrupted) return code || 1;
    const templateDirectory = join(reportDir, "templates");
    await mkdir(templateDirectory, { mode: 0o700 });
    templates = await createTemplateRun(environment, templateDirectory, stop.signal);
    if (interrupted) return 1;
    console.log(JSON.stringify({ templateSetup: templates.stats }));
    const templateEnvironment = { ...environment, TEST_DATABASE_TEMPLATE_MANIFEST: templates.manifestPath };
    const reportPath = join(reportDir, "results.json");
    code = await run(process.execPath, [
      fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", "vitest.db.config.mts", "--reporter=default",
      "--reporter=json", "--outputFile.json=" + reportPath, ...filters,
    ], templateEnvironment, AbortSignal.any([templates.failureSignal, leaseSignal]));
    if (code !== 0 || interrupted) return code || 1;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const leaseRequiredCases = validateLeaseDbReport(report);
    const readinessRequiredCases = validateReadinessDbReport(report);
    const predictiveRequiredCases = validatePredictiveDbReport(report);
    const corpusRequiredCases = validateCorpusDbReport(report);
    console.log(JSON.stringify({ nodeRequiredCases, leaseRequiredCases, readinessRequiredCases, predictiveRequiredCases, corpusRequiredCases, result: "verified" }));
    leaseSignal.throwIfAborted();
    return 0;
  } finally {
    await templates?.close();
    await rm(reportDir, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, ...filters] = process.argv.slice(2);
  if (mode === "down") return run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
  assertNoApplicationCredentials(process.env);
  if (mode === "run") {
    const lease = await startDatabaseTestRun(process.env);
    lease.failureSignal.addEventListener("abort", lostLock, { once: true });
    try { return await runSuite(process.env, filters, lease.failureSignal); }
    finally { await lease.close(); }
  }
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
  let lease;
  try {
    const started = await run("docker", [...composeArgs, "up", "-d", "--wait", "--wait-timeout", "60"]);
    if (started === 0 && !interrupted) {
      lease = await startDatabaseTestRun({ ...process.env, TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL });
      lease.failureSignal.addEventListener("abort", lostLock, { once: true });
      for (let index = 0; index < repetitions && !interrupted; index++) {
        if (mode === "repeat") console.log(`DB suite repetition ${index + 1}/${repetitions}`);
        result = await runSuite({ ...process.env, TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }, filters, lease.failureSignal);
        if (result !== 0) break;
      }
    }
  } finally {
    // A refused contender must not tear down the service used by the lock holder.
    if (lease) {
      lease.failureSignal.removeEventListener("abort", lostLock);
      try {
        // Losing the session also loses authority to remove the shared service.
        if (!lease.failureSignal.aborted) {
          const cleaned = await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
          if (cleaned !== 0) result = 1;
        } else result = 1;
      } finally { await lease.close(); }
    }
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
