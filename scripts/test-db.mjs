import { DatabaseTestRunActiveError, startDatabaseTestRun } from "../tests/db/startup.mts";
import { createTemplateRun } from "../tests/db/templates.mts";
import { databaseTestWorkers } from "./db-test-workers.mjs";
import { mergeDatabaseReports } from "./db-test-lanes.mjs";
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
const activeChildren = new Set();
let interrupted;
const lostLock = () => { stop.abort(); for (const child of activeChildren) child.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    stop.abort();
    for (const child of activeChildren) child.kill("SIGTERM");
  });
}

function run(command, args, environment = process.env, signal) {
  if (signal?.aborted) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit", signal });
    activeChildren.add(child);
    let failure;
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      activeChildren.delete(child);
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
  let failure;
  try {
    let code = await run(process.execPath, ["scripts/db-migration-artifacts.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    code = await run(process.execPath, ["scripts/db-readiness-manifest.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    code = await run(process.execPath, ["--test", "--test-timeout=60000", "tests/db/templates.integration.check.mjs"], environment, leaseSignal);
    if (code !== 0 || interrupted) return code || 1;
    const templateDirectory = join(reportDir, "templates");
    await mkdir(templateDirectory, { mode: 0o700 });
    templates = await createTemplateRun(environment, templateDirectory, stop.signal);
    if (interrupted) return 1;
    console.log(JSON.stringify({ templateSetup: templates.stats }));
    const workers = databaseTestWorkers();
    console.log(JSON.stringify({ dbWorkers: workers }));
    const templateEnvironment = { ...environment, TEST_DATABASE_TEMPLATE_MANIFEST: templates.manifestPath };
    const laneStop = new AbortController();
    const signal = AbortSignal.any([templates.failureSignal, leaseSignal, stop.signal, laneStop.signal]);
    const checked = async (args) => {
      const result = await run(process.execPath, args, templateEnvironment, signal);
      if (result !== 0) throw new Error("DB test lane failed with exit code " + result);
    };
    const nodeReportPath = join(reportDir, "node-results.json");
    const serialPath = join(reportDir, "serial-results.json");
    const scratchPath = join(reportDir, "scratch-results.json");
    let nodeRequiredCases;
    const vitest = (config, path) => checked([
      fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", config, "--reporter=default", "--reporter=json", "--outputFile.json=" + path, ...filters,
    ]);
    const serialLane = async () => {
      await checked(["--test", "--test-concurrency=" + workers.nodeWorkers, "--test-timeout=60000",
        "--test-reporter=spec", "--test-reporter=./scripts/db-test-reporter.mjs",
        "--test-reporter-destination=stdout", "--test-reporter-destination=" + nodeReportPath,
        ...Object.keys(NODE_REQUIRED_CASES)]);
      nodeRequiredCases = validateNodeDbReport(JSON.parse(await readFile(nodeReportPath, "utf8")));
      await checked(["scripts/db-catalog-contracts.mjs", "check"]);
      await vitest("vitest.db.config.mts", serialPath);
    };
    const scratchLane = () => vitest("vitest.db.scratch.config.mts", scratchPath);
    if (workers.overlap) {
      const lanes = [serialLane, scratchLane].map(async (lane) => {
        try { await lane(); } catch (error) { laneStop.abort(); throw error; }
      });
      const results = await Promise.allSettled(lanes);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "DB test lanes failed.");
    } else {
      await serialLane(); await scratchLane();
    }
    const report = mergeDatabaseReports(JSON.parse(await readFile(serialPath, "utf8")),
      JSON.parse(await readFile(scratchPath, "utf8")));
    const leaseRequiredCases = validateLeaseDbReport(report);
    const readinessRequiredCases = validateReadinessDbReport(report);
    const predictiveRequiredCases = validatePredictiveDbReport(report);
    const corpusRequiredCases = validateCorpusDbReport(report);
    console.log(JSON.stringify({ nodeRequiredCases, leaseRequiredCases, readinessRequiredCases, predictiveRequiredCases, corpusRequiredCases, result: "verified" }));
    leaseSignal.throwIfAborted();
    return 0;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await templates?.close(); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure, cleanup], "DB suite and cleanup failed.");
      throw cleanup;
    } finally { await rm(reportDir, { recursive: true, force: true }); }
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
  let contention = false;
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
  } catch (error) {
    contention = error instanceof DatabaseTestRunActiveError;
    throw error;
  } finally {
    lease?.failureSignal.removeEventListener("abort", lostLock);
    try {
      if (!contention) {
        const cleaned = await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
        if (cleaned !== 0) result = 1;
      }
    } finally { await lease?.close(); }
  }

  return result;
}

try {
  process.exitCode = await main();
} catch (error) {
  const messages = (value) => value instanceof AggregateError ?
    [value.message, ...value.errors.flatMap(messages)] : [value instanceof Error ? value.message : "DB test harness failed."];
  console.error(messages(error).join("\n"));
  process.exitCode = 1;
}
if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
