import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const workflow = readFileSync(new URL("ci.yml", workflowDirectory), "utf8");
// Extract the actual inline gate rather than duplicate its decision logic.
// This intentionally checks the current block layout; actionlint validates YAML.
const gate = workflow.match(/^  ci:\n((?:\n| {4}[^\n]*\n)+)/m)?.[1];
assert.ok(gate, "Expected the aggregate ci job block.");
const block = gate.match(/^        run: \|\n((?: {10}[^\n]*\n)+)/m)?.[1];
assert.ok(block, "Expected one inline gate script.");
const script = block.replace(/^ {10}/gm, "");

const validExecution = {
  FORCE_FULL: "0", APP_TEST_RESULT: "success", APP_TEST_MODE: "affected",
  APP_TEST_WORK: "executed", APP_MATRIX_RESULT: "success", DB_PLAN_RESULT: "success",
  DB_SELECTION_GUARD_RESULT: "success", DB_GUARD_RESULT: "success", DB_MODE: "affected",
  DB_LOCAL_SELECTED: "true", FEATURE_STORE_SELECTED: "true", DB_LIFECYCLE_RESULT: "success",
  DB_LOCAL_RESULT: "success", FEATURE_STORE_RESULT: "success", DB_CLEANUP_RESULT: "success",
};

function runGate(app, db, execution = {}) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    env: { PATH: process.env.PATH, APP_RESULT: app, DB_RESULT: db, ...validExecution, ...execution },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("CI is the sole aggregate check, always runs, and has no token permissions or checkout", () => {
  const names = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => [...readFileSync(new URL(name, workflowDirectory), "utf8")
      .matchAll(/^    name: CI\s*$/gm)]);
  assert.equal(names.length, 1);
  assert.match(gate, /^    name: CI$/m);
  assert.match(gate, /^    needs: \[app, db\]$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^    permissions: \{\}$/m);
  assert.doesNotMatch(gate, /^\s+uses:/m);
  assert.equal([...gate.matchAll(/^      - name:/gm)].length, 1);
  assert.match(gate, /^        shell: bash$/m);
  assert.match(gate, /^          APP_RESULT: \$\{\{ needs\.app\.result \}\}$/m);
  assert.match(gate, /^          DB_RESULT: \$\{\{ needs\.db\.result \}\}$/m);
});

test("the actual gate script passes only success/success across all 16 GitHub job-result combinations", () => {
  const states = ["success", "failure", "cancelled", "skipped"];
  for (const app of states) {
    for (const db of states) {
      const result = runGate(app, db);
      assert.equal(result.status, app === "success" && db === "success" ? 0 : 1,
        `App checks=${app}, DB integration=${db}: ${result.stdout}${result.stderr}`);
    }
  }
});

test("missing or unexpected upstream results also fail the gate", () => {
  for (const state of ["", "unknown"]) {
    assert.equal(runGate(state, "success").status, 1);
    assert.equal(runGate("success", state).status, 1);
  }
});

test("feature-store PostgreSQL coverage runs sequentially on the standard fixture and cannot bypass the DB gate", () => {
  const db = workflow.match(/^  db:\n((?:\n| {4}[^\n]*\n)+)/m)?.[1];
  assert.ok(db, "Expected the DB integration job block.");
  const feature = db.match(/^      - name: Verify feature-store PostgreSQL behavior on standard fixture\n((?: {8}[^\n]*\n)+)/m)?.[1];
  assert.ok(feature, "Expected an explicit feature-store PostgreSQL step.");
  assert.match(feature, /^        shell: bash$/m);
  assert.match(feature, /^          TEST_DATABASE_URL: postgresql:\/\/dfs_ev_test:dfs_ev_test@127\.0\.0\.1:54329\/dfs_ev_test$/m);
  assert.match(feature, /^        run: \|\n          docker compose --env-file \/dev\/null --project-name dfs-ev-demo-test -f compose\.test\.yml up -d --wait --wait-timeout 60\n          npm run test:feature-store:db\n$/m);
  assert.match(feature, /^        if: \$\{\{ steps\.selection\.outputs\.feature_store == 'true' \}\}$/m);
  assert.doesNotMatch(feature, /(?:continue-on-error:|compose\.feature-store-spike)/);
  assert.doesNotMatch(db, /^    (?:continue-on-error:|if:)/m);
  assert.match(db, /^    timeout-minutes: 10$/m);
  assert.ok(db.indexOf("run: npm run test:db:local") < db.indexOf(feature));
  assert.ok(db.indexOf(feature) < db.indexOf("- name: Remove disposable PostgreSQL"));
  assert.match(db, /- name: Remove disposable PostgreSQL\n        id: cleanup\n        if: \$\{\{ always\(\) \}\}\n        timeout-minutes: 2\n        run: npm run test:db:down/);
});

test("the actual gate accepts intentional empty work only with explicit selection and skipped suites", () => {
  for (const dbLocal of ["true", "false"]) {
    for (const featureStore of ["true", "false"]) {
      const execution = {
        DB_LOCAL_SELECTED: dbLocal, FEATURE_STORE_SELECTED: featureStore,
        DB_LOCAL_RESULT: dbLocal === "true" ? "success" : "skipped",
        FEATURE_STORE_RESULT: featureStore === "true" ? "success" : "skipped",
        DB_LIFECYCLE_RESULT: [dbLocal, featureStore].includes("true") ? "success" : "skipped",
      };
      for (const work of ["executed", "intentional-empty"]) {
        const result = runGate("success", "success", { ...execution, APP_TEST_WORK: work });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
    }
  }
});

test("the actual gate rejects selected skips, failures, cancellations and unexpected unselected execution", () => {
  const outcomes = ["success", "failure", "cancelled", "skipped"];
  for (const dbLocal of ["true", "false"]) {
    for (const featureStore of ["true", "false"]) {
      for (const localOutcome of outcomes) {
        for (const featureOutcome of outcomes) {
          for (const lifecycleOutcome of outcomes) {
            const result = runGate("success", "success", {
              DB_LOCAL_SELECTED: dbLocal, FEATURE_STORE_SELECTED: featureStore,
              DB_LOCAL_RESULT: localOutcome, FEATURE_STORE_RESULT: featureOutcome,
              DB_LIFECYCLE_RESULT: lifecycleOutcome,
            });
            const valid = localOutcome === (dbLocal === "true" ? "success" : "skipped") &&
              featureOutcome === (featureStore === "true" ? "success" : "skipped") &&
              lifecycleOutcome === ([dbLocal, featureStore].includes("true") ? "success" : "skipped");
            assert.equal(result.status, valid ? 0 : 1, JSON.stringify({ dbLocal, featureStore, localOutcome, featureOutcome, lifecycleOutcome }));
          }
        }
      }
    }
  }
});

test("missing or malformed metadata, hidden failures and omitted cleanup fail even when jobs report success", () => {
  for (const name of Object.keys(validExecution)) {
    for (const value of ["", "unknown"]) {
      assert.equal(runGate("success", "success", { [name]: value }).status, 1, `${name}=${value}`);
    }
    if (name.endsWith("_RESULT")) {
      for (const value of ["failure", "cancelled", "skipped"])
        assert.equal(runGate("success", "success", { [name]: value }).status, 1, `${name}=${value}`);
    }
  }
});

test("main and integration checkpoints cannot substitute affected or empty work for full checks", () => {
  assert.equal(runGate("success", "success", { FORCE_FULL: "1", APP_TEST_MODE: "full", DB_MODE: "full" }).status, 0);
  assert.equal(runGate("success", "success", { FORCE_FULL: "1" }).status, 1);
  for (const mode of ["affected", "full"]) {
    assert.equal(runGate("success", "success", { FORCE_FULL: "1", APP_TEST_MODE: mode, DB_MODE: "affected" }).status, 1);
    assert.equal(runGate("success", "success", { FORCE_FULL: "1", APP_TEST_MODE: "affected", DB_MODE: mode }).status, 1);
  }
  assert.equal(runGate("success", "success", { APP_TEST_MODE: "full", APP_TEST_WORK: "intentional-empty" }).status, 1);
  for (const omitted of ["DB_LOCAL_SELECTED", "FEATURE_STORE_SELECTED"]) {
    const resultName = omitted === "DB_LOCAL_SELECTED" ? "DB_LOCAL_RESULT" : "FEATURE_STORE_RESULT";
    assert.equal(runGate("success", "success", { DB_MODE: "full", [omitted]: "false", [resultName]: "skipped" }).status, 1);
  }
});

test("aggregate metadata is wired to raw outcomes and the selection outputs of the actual executing steps", () => {
  const jobs = Object.fromEntries(["app", "db"].map(name => [name,
    workflow.match(new RegExp(`^  ${name}:\\n((?:\\n| {4}[^\\n]*\\n)+)`, "m"))[1]]));
  const wiring = {
    APP_TEST_RESULT: ["app", "test_result", "steps.tests.outcome"],
    APP_TEST_MODE: ["app", "test_mode", "steps.tests.outputs.mode"],
    APP_TEST_WORK: ["app", "test_work", "steps.tests.outputs.work"],
    APP_MATRIX_RESULT: ["app", "matrix_result", "steps.matrix.outcome"],
    DB_PLAN_RESULT: ["db", "plan_result", "steps.selection.outcome"],
    DB_SELECTION_GUARD_RESULT: ["db", "selection_guard_result", "steps.selection_guard.outcome"],
    DB_GUARD_RESULT: ["db", "guard_result", "steps.guard.outcome"],
    DB_MODE: ["db", "mode", "steps.selection.outputs.mode"],
    DB_LOCAL_SELECTED: ["db", "db_local", "steps.selection.outputs.db_local"],
    FEATURE_STORE_SELECTED: ["db", "feature_store", "steps.selection.outputs.feature_store"],
    DB_LIFECYCLE_RESULT: ["db", "lifecycle_result", "steps.lifecycle.outcome"],
    DB_LOCAL_RESULT: ["db", "db_local_result", "steps.db_local.outcome"],
    FEATURE_STORE_RESULT: ["db", "feature_store_result", "steps.feature_store.outcome"],
    DB_CLEANUP_RESULT: ["db", "cleanup_result", "steps.cleanup.outcome"],
  };
  for (const [name, [job, output, source]] of Object.entries(wiring)) {
    assert.ok(gate.includes(`          ${name}: \${{ needs.${job}.outputs.${output} }}\n`), name);
    assert.ok(jobs[job].includes(`      ${output}: \${{ ${source} }}\n`), `${job}.${output}`);
  }
  assert.ok(gate.includes("          FORCE_FULL: ${{ env.TURBO_FORCE_FULL }}\n"));
  for (const [job, name, id] of [
    ["app", "Prove affected task selection on Node 24", "matrix"], ["app", "Test", "tests"],
    ["db", "Plan affected database suites", "selection"], ["db", "Require explicit database selection", "selection_guard"],
    ["db", "Check database target, bootstrap and report guards", "guard"],
    ["db", "Verify startup recovery and failure cleanup", "lifecycle"],
    ["db", "Verify migration artifacts, catalog contracts and PostgreSQL behavior", "db_local"],
    ["db", "Verify feature-store PostgreSQL behavior on standard fixture", "feature_store"],
    ["db", "Remove disposable PostgreSQL", "cleanup"],
  ]) assert.ok(jobs[job].includes(`      - name: ${name}\n        id: ${id}\n`), `${job}.${id}`);
  assert.doesNotMatch(workflow, /continue-on-error:/);
});

test("the actual full app command publishes completion only after root npm test succeeds", () => {
  const step = workflow.split("      - name: Test\n")[1].split("      - name:")[0];
  const command = step.match(/^        run: \|\n((?: {10}[^\n]*\n)+)/m)[1].replace(/^ {10}/gm, "");
  const directory = mkdtempSync(join(tmpdir(), "dfs192-completion-"));
  try {
    // This probe tests shell sequencing, not the application tests themselves.
    writeFileSync(join(directory, "npm"), '#!/bin/sh\n[ "$*" = "test" ] || exit 99\nexit "$NPM_TEST_STATUS"\n', { mode: 0o700 });
    for (const status of [0, 23]) {
      const output = join(directory, `output-${status}`);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
        encoding: "utf8", timeout: 5_000,
        env: { PATH: `${directory}:${process.env.PATH}`, TURBO_FORCE_FULL: "1", GITHUB_OUTPUT: output, NPM_TEST_STATUS: String(status) },
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stdout + result.stderr);
      if (status === 0) assert.equal(readFileSync(output, "utf8"), "mode=full\nwork=executed\n");
      else assert.equal(existsSync(output), false, "failed root tests cannot publish completed work");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
