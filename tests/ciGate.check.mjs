import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

function runGate(app, db) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    env: { PATH: process.env.PATH, APP_RESULT: app, DB_RESULT: db },
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
  assert.doesNotMatch(feature, /(?:continue-on-error:|if:|compose\.feature-store-spike)/);
  assert.doesNotMatch(db, /^    (?:continue-on-error:|if:)/m);
  assert.match(db, /^    timeout-minutes: 10$/m);
  assert.ok(db.indexOf("run: npm run test:db:local") < db.indexOf(feature));
  assert.ok(db.indexOf(feature) < db.indexOf("- name: Remove disposable PostgreSQL"));
  assert.match(db, /- name: Remove disposable PostgreSQL\n        if: \$\{\{ always\(\) \}\}\n        timeout-minutes: 2\n        run: npm run test:db:down/);
});
