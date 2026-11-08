import { DatabaseTestRunActiveError, startDatabaseTestRun } from "@dfs-ev/db-tooling/test-support/lifecycle";
import { createTemplateRun } from "@dfs-ev/db-tooling/test-support/templates";
import { databaseTestWorkers } from "./db-test-workers.mjs";
import { validateDatabaseReport } from "./db-test-lanes.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_REQUIRED_CASES, validateCorpusDbReport, validateLeaseDbReport, validateNodeDbReport, validateReadinessDbReport } from "./db-test-contract.mjs";
import {
  assertNoApplicationCredentials,
  getTestDatabaseLane,
  parseTestDatabaseUrl,
} from "@dfs-ev/db-tooling/test-support/target";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tierLabel = "dev.dfs-ev.test-tier";
const fixtureFor = (environment) => {
  const selected = getTestDatabaseLane(environment.DB_TEST_LANE);
  if (environment.TEST_DATABASE_URL !== undefined) parseTestDatabaseUrl(environment.TEST_DATABASE_URL, environment.DB_TEST_LANE);
  const tier = environment.DB_TEST_TIER ?? "standard";
  if (tier !== "standard" && tier !== "large") throw new Error("Unknown DB_TEST_TIER. Use standard or large.");
  if (tier === "large" && selected === getTestDatabaseLane()) {
    throw new Error("The default DB test lane is fixed at 512 MiB. Select a non-default lane for the 2 GiB tier.");
  }
  const compose = ["compose", "--env-file", "/dev/null", "--project-name", selected.project,
    "-f", fileURLToPath(new URL("../../compose.test.yml", import.meta.url))];
  if (tier === "large") compose.push("-f", fileURLToPath(new URL("../../compose.feature-store-spike.yml", import.meta.url)));
  return { selected, tier, compose, env: { ...environment, DB_TEST_COMPOSE_PORT: String(selected.port) },
    suiteEnv: { ...environment, TEST_DATABASE_URL: selected.url } };
};

const assertFixtureTier = ({ selected, tier, compose, env }) => {
  if (selected === getTestDatabaseLane()) return; // Default is protected by the fixed tier and --no-recreate.
  const docker = (args) => execFileSync("docker", args, { cwd: root, env, encoding: "utf8" }).trim();
  const id = docker([...compose, "ps", "--all", "--quiet", "postgres"]);
  if (id && docker(["inspect", "--format", `{{index .Config.Labels "${tierLabel}"}}`, id]) !== tier) {
    throw new Error("Existing DB test fixture uses another disk tier. Stop it explicitly before selecting a different tier.");
  }
};

const startFixture = (fixture) => run("docker",
  [...fixture.compose, "up", "--no-recreate", "-d", "--wait", "--wait-timeout", "60"], fixture.env);
const stopFixture = (fixture) => run("docker",
  [...fixture.compose, "down", "--volumes", "--remove-orphans"], fixture.env);
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
  parseTestDatabaseUrl(environment.TEST_DATABASE_URL, environment.DB_TEST_LANE ?? "default");
  leaseSignal.throwIfAborted();
  const reportDir = await mkdtemp(join(tmpdir(), "dfs-ev-db-test-"));
  let templates;
  let failure;
  try {
    let code = await run(process.execPath, ["packages/db/tooling/scripts/db-migration-artifacts.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    code = await run(process.execPath, ["packages/db/tooling/scripts/db-readiness-manifest.mjs", "check"], environment);
    if (code !== 0 || interrupted) return code || 1;
    code = await run(process.execPath, ["--test", "--test-timeout=60000", "packages/db/tooling/tests/templates.integration.check.mjs"], environment, leaseSignal);
    if (code !== 0 || interrupted) return code || 1;
    const templateDirectory = join(reportDir, "templates");
    await mkdir(templateDirectory, { mode: 0o700 });
    templates = await createTemplateRun(environment, templateDirectory, stop.signal);
    if (interrupted) return 1;
    console.log(JSON.stringify({ templateSetup: templates.stats }));
    const workers = databaseTestWorkers();
    console.log(JSON.stringify({ dbWorkers: workers }));
    const templateEnvironment = { ...environment, TEST_DATABASE_TEMPLATE_MANIFEST: templates.manifestPath };
    const signal = AbortSignal.any([templates.failureSignal, leaseSignal, stop.signal]);
    const checked = async (args) => {
      const result = await run(process.execPath, args, templateEnvironment, signal);
      if (result !== 0) throw new Error("DB test command failed with exit code " + result);
    };
    const nodeReportPath = join(reportDir, "node-results.json");
    const reportPath = join(reportDir, "vitest-results.json");
    await checked(["--test", "--test-concurrency=" + workers.nodeWorkers, "--test-timeout=60000",
      "--test-reporter=spec", "--test-reporter=./scripts/db/db-test-reporter.mjs",
      "--test-reporter-destination=stdout", "--test-reporter-destination=" + nodeReportPath,
      ...Object.keys(NODE_REQUIRED_CASES)]);
    const nodeRequiredCases = validateNodeDbReport(JSON.parse(await readFile(nodeReportPath, "utf8")));
    await checked(["packages/db/tooling/scripts/db-catalog-contracts.mjs", "check"]);
    await checked([
      fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", "vitest.db.config.mts", "--reporter=default", "--reporter=json", "--outputFile.json=" + reportPath, ...filters,
    ]);
    const report = validateDatabaseReport(JSON.parse(await readFile(reportPath, "utf8")));
    const leaseRequiredCases = validateLeaseDbReport(report);
    const readinessRequiredCases = validateReadinessDbReport(report);
    const corpusRequiredCases = validateCorpusDbReport(report);
    console.log(JSON.stringify({ nodeRequiredCases, leaseRequiredCases, readinessRequiredCases, corpusRequiredCases, result: "verified" }));
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
  assertNoApplicationCredentials(process.env);
  const fixture = fixtureFor(process.env);
  if (mode === "url") { console.log(fixture.selected.url); return 0; }
  if (mode === "down") return stopFixture(fixture);
  if (mode === "up") {
    assertFixtureTier(fixture);
    const result = await startFixture(fixture);
    if (result === 0) assertFixtureTier(fixture);
    return result;
  }
  if (mode === "run") {
    const lease = await startDatabaseTestRun(process.env);
    lease.failureSignal.addEventListener("abort", lostLock, { once: true });
    try { return await runSuite(process.env, filters, lease.failureSignal); }
    finally { await lease.close(); }
  }
  if (mode !== "local" && mode !== "repeat") throw new Error("Expected DB test mode: run, local, repeat, up, down, or url.");
  const repetitions = mode === "repeat" ? Number(filters.shift() ?? 20) : 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100 || (mode === "repeat" && filters.length)) {
    throw new Error("DB repetitions must be an integer from 1 to 100 with no test filters.");
  }

  assertFixtureTier(fixture);
  let result = 1;
  let lease;
  let contention = false;
  let tierMismatch = false;
  try {
    const started = await startFixture(fixture);
    if (started === 0 && !interrupted) {
      try { assertFixtureTier(fixture); } catch (error) { tierMismatch = true; throw error; }
      lease = await startDatabaseTestRun(fixture.suiteEnv);
      lease.failureSignal.addEventListener("abort", lostLock, { once: true });
      for (let index = 0; index < repetitions && !interrupted; index++) {
        if (mode === "repeat") console.log(`DB suite repetition ${index + 1}/${repetitions}`);
        result = await runSuite(fixture.suiteEnv, filters, lease.failureSignal);
        if (result !== 0) break;
      }
    }
  } catch (error) {
    contention = error instanceof DatabaseTestRunActiveError;
    throw error;
  } finally {
    lease?.failureSignal.removeEventListener("abort", lostLock);
    try {
      if (!contention && !tierMismatch) {
        const cleaned = await stopFixture(fixture);
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
