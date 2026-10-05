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
