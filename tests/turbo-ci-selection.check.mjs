import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { databaseSelection } from "../scripts/turbo/ci-db-selection.mjs";

const base = "a".repeat(40), head = "b".repeat(40);
const ids = ["@dfs-ev/db-tooling#test:db:local", "@dfs-ev/pipeline#test:db:local", "@dfs-ev/pipeline#test:feature-store:db", "@dfs-ev/web#test:db:local"];
const local = [ids[0], ids[1], ids[3]];
const context = { base, head, forceFull: "0" };
const plan = (tasks, mode = "affected") => ({ schemaVersion: 1, base, head, requestedTasks: ["test:db:local", "test:feature-store:db"],
  mode, packages: ["@dfs-ev/db-tooling", "@dfs-ev/pipeline", "@dfs-ev/web"], tasks,
  intentionalEmpty: tasks.length === 0 && mode === "affected", cache: Object.fromEntries(tasks.map(id => [id, false])) });

test("CI translates only executable Turbo database task IDs and explicit empty selections", () => {
  // Every subset of the four executable DB task IDs.
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const tasks = ids.filter((_, index) => mask & (1 << index));
    const output = databaseSelection(plan(tasks), context);
    assert.equal(output.db_local, String(tasks.some(id => local.includes(id))));
    assert.equal(output.feature_store, String(tasks.includes(ids[2])));
  }
  // Until #209 Step 3 switches ownership, web's conservative alias remains active.
  assert.equal(databaseSelection(plan([ids[3]]), context).db_local, "true");
  assert.deepEqual(databaseSelection(plan(ids, "full"), { ...context, forceFull: "1" }),
    { db_local: "true", feature_store: "true", mode: "full" });
});

test("missing, malformed, cached, stale or incomplete full plans refuse instead of skipping DB work", () => {
  for (const patch of [
    { schemaVersion: undefined }, { base: "c".repeat(40) }, { head: "c".repeat(40) },
    { mode: "unknown" }, { packages: null }, { tasks: null }, { tasks: [ids[0], ids[0]] },
    { requestedTasks: [] }, { tasks: ["@dfs-ev/web#test"] }, { intentionalEmpty: true },
    { cache: { [ids[0]]: true, [ids[1]]: false } }, { cache: {} },
  ]) assert.throws(() => databaseSelection({ ...plan(ids), ...patch }, context));
  for (const invalid of [undefined, null, {}, "", []]) assert.throws(() => databaseSelection(invalid, context));
  assert.throws(() => databaseSelection(plan([], "full"), context));
  assert.throws(() => databaseSelection(plan([ids[1]], "full"), context));
  assert.throws(() => databaseSelection(plan(ids), { ...context, forceFull: "1" }));
  assert.throws(() => databaseSelection(plan(ids), { ...context, forceFull: "unknown" }));
});

test("CI keeps full merge history, main/manual full checks, hosted matrix and unconditional upstream jobs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /TURBO_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /TURBO_HEAD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /TURBO_FORCE_FULL: \$\{\{ github\.event_name != 'pull_request' && '1' \|\| '0' \}\}/);
  assert.equal([...workflow.matchAll(/fetch-depth: 0/g)].length, 2);
  assert.match(workflow, /npm run test:turbo-layout\n          cat "\$TURBO_MATRIX_RECEIPT"/);
  assert.match(workflow, /if \[\[ "\$TURBO_FORCE_FULL" == "1" \]\]; then\n            npm test/);
  assert.match(workflow, /TURBO_ALLOW_EMPTY=1 npm run turbo:affected -- test/);
  for (const name of ["app", "db"]) {
    const job = workflow.match(new RegExp(`^  ${name}:\\n((?:\\n| {4}[^\\n]*\\n)+)`, "m"))?.[1];
    assert.ok(job);
    assert.doesNotMatch(job, /^    (?:if:|continue-on-error:)/m);
  }
});

test("CI plans DB work before guarded execution and retains sequential fixture cleanup", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const db = workflow.match(/^  db:\n((?:\n| {4}[^\n]*\n)+)/m)?.[1];
  assert.ok(db);
  assert.match(db, /TURBO_PLAN_ONLY: "1"/);
  assert.match(db, /npm run turbo:affected -- test:db:local test:feature-store:db\n          node scripts\/turbo\/ci-db-selection.mjs "\$TURBO_PLAN_FILE"/);
  assert.match(db, /Missing or invalid database selection; refusing silent skips\./);
  for (const key of ["db_local", "feature_store"]) assert.match(db, new RegExp(`steps\\.selection\\.outputs\\.${key} == 'true'`));
  assert.ok(db.indexOf("Require explicit database selection") < db.indexOf("run: npm run test:db:lifecycle"));
  assert.ok(db.indexOf("run: npm run test:db:local") < db.indexOf("npm run test:feature-store:db"));
  assert.match(db, /if: \$\{\{ always\(\) \}\}\n        timeout-minutes: 2\n        run: npm run test:db:down/);
  assert.doesNotMatch(db, /continue-on-error:|compose\.feature-store-spike/);
});

test("the actual workflow selection guard refuses missing and unknown boolean outputs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Require explicit database selection\n")[1].split("      - name:")[0];
  const script = step.match(/^        run: \|\n((?: {10}[^\n]*\n)+)/m)[1].replace(/^ {10}/gm, "");
  for (const dbLocal of ["true", "false", "", "unknown"]) {
    for (const featureStore of ["true", "false", "", "unknown"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8", timeout: 5_000,
        env: { PATH: process.env.PATH, DB_LOCAL: dbLocal, FEATURE_STORE: featureStore },
      });
      assert.ifError(result.error);
      const valid = [dbLocal, featureStore].every(value => ["true", "false"].includes(value));
      assert.equal(result.status, valid ? 0 : 1, result.stdout + result.stderr);
    }
  }
});
