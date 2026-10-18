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

function runGate({ changes = "success", appNeeded = "true", app, dbNeeded = "true", db }) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    env: { PATH: process.env.PATH, CHANGES_RESULT: changes, APP_NEEDED: appNeeded, APP_RESULT: app,
      DB_NEEDED: dbNeeded, DB_RESULT: db },
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
  assert.match(gate, /^    needs: \[changes, app, db\]$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^    permissions: \{\}$/m);
  assert.doesNotMatch(gate, /^\s+uses:/m);
  assert.equal([...gate.matchAll(/^      - name:/gm)].length, 1);
  assert.match(gate, /^        shell: bash$/m);
  assert.match(gate, /^          CHANGES_RESULT: \$\{\{ needs\.changes\.result \}\}$/m);
  assert.match(gate, /^          APP_NEEDED: \$\{\{ needs\.changes\.outputs\.app \}\}$/m);
  assert.match(gate, /^          APP_RESULT: \$\{\{ needs\.app\.result \}\}$/m);
  assert.match(gate, /^          DB_NEEDED: \$\{\{ needs\.changes\.outputs\.db \}\}$/m);
  assert.match(gate, /^          DB_RESULT: \$\{\{ needs\.db\.result \}\}$/m);
});

test("the actual gate script passes only needed suites that succeed and unneeded suites that were skipped", () => {
  const states = ["success", "failure", "cancelled", "skipped"];
  const suiteOk = (needed, result) => (needed === "true" && result === "success") || (needed === "false" && result === "skipped");
  for (const changes of states) {
    for (const appNeeded of ["true", "false"]) {
      for (const app of states) {
        for (const dbNeeded of ["true", "false"]) {
          for (const db of states) {
            const expected = changes === "success" && suiteOk(appNeeded, app) && suiteOk(dbNeeded, db) ? 0 : 1;
            const result = runGate({ changes, appNeeded, app, dbNeeded, db });
            assert.equal(result.status, expected,
              `changes=${changes} app=${app}(needed ${appNeeded}) db=${db}(needed ${dbNeeded}): ${result.stdout}${result.stderr}`);
          }
        }
      }
    }
  }
});

test("missing or unexpected detector outputs and results also fail the gate", () => {
  for (const state of ["", "unknown"]) {
    assert.equal(runGate({ app: state, db: "success" }).status, 1);
    assert.equal(runGate({ app: "success", db: state }).status, 1);
    assert.equal(runGate({ appNeeded: state, app: "skipped", db: "success" }).status, 1);
    assert.equal(runGate({ app: "success", dbNeeded: state, db: "skipped" }).status, 1);
    assert.equal(runGate({ changes: state, app: "success", db: "success" }).status, 1);
  }
});

test("each suite runs only when the detector marks it needed", () => {
  assert.match(workflow, /^  app:\n    name: App checks\n    needs: changes\n    if: \$\{\{ needs\.changes\.outputs\.app == 'true' \}\}$/m);
  assert.match(workflow, /^  db:\n    name: DB integration\n    needs: changes\n    if: \$\{\{ needs\.changes\.outputs\.db == 'true' \}\}$/m);
  assert.match(workflow, /^        run: node scripts\/ci\/affected\.mjs$/m);
});
