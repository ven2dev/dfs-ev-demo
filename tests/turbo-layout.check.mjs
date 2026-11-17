import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = path => JSON.parse(read(path));
const turbo = json("turbo.json");
const root = json("package.json");
const lock = json("package-lock.json");

test("Turbo is pinned and uses declared workspace tasks with shared inputs", () => {
  // Pin exactly (no range) and match the lockfile, without naming a release,
  // so routine patch updates do not need a test edit.
  const pinned = root.devDependencies.turbo;
  assert.match(pinned, /^\d+\.\d+\.\d+$/, "turbo must be an exact version");
  const installed = Object.entries(lock.packages)
    .filter(([path]) => /^node_modules\/(turbo|@turbo\/[^/]+)$/.test(path));
  assert.ok(installed.some(([path]) => path === "node_modules/turbo"), "turbo missing from lockfile");
  for (const [path, entry] of installed) assert.equal(entry.version, pinned, `${path} does not match the turbo pin`);
  assert.equal(root.packageManager, "npm@11.16.0");
  for (const input of ["package-lock.json", ".nvmrc", "docs/**", ".github/workflows/**", "scripts/**"])
    assert.ok(turbo.globalDependencies.includes(input), `missing global input ${input}`);
  assert.equal(turbo.tasks.test.dependsOn, undefined);
  assert.deepEqual(turbo.tasks.typecheck.dependsOn, ["^typecheck"]);
  assert.deepEqual(turbo.tasks.build.dependsOn, ["^build"]);
});

test("initial adoption executes every selected task without cached success", () => {
  for (const [name, task] of Object.entries(turbo.tasks))
    assert.equal(task.cache, false, `${name} cannot use cached success`);
  for (const [name, task] of Object.entries(turbo.tasks))
    if (name.startsWith("db:") || name.startsWith("test:db") || name === "test:feature-store:db")
      assert.deepEqual(task.outputs, [], `${name} cannot publish mutable fixture output`);
});

test("workspace test commands retain both environments and protected DB runners", () => {
  const domain = json("packages/domain/package.json").scripts.test;
  const pipeline = json("services/pipeline/package.json").scripts;
  const tooling = json("packages/db/tooling/package.json").scripts;
  assert.match(domain, /vitest\.config\.ts packages\/domain\/src/);
  assert.match(domain, /vitest\.node\.config\.ts packages\/domain\/tests\/projection/);
  assert.match(pipeline.test, /vitest\.config\.ts services\/pipeline\/src services\/pipeline\/scripts/);
  assert.match(pipeline.test, /vitest\.node\.config\.ts services\/pipeline\/tests\/feature-store/);
  assert.equal(pipeline["test:db:local"], "cd ../.. && npm run test:db:local");
  assert.equal(pipeline["test:feature-store:db"], "cd ../.. && npm run test:feature-store:db");
  assert.equal(tooling["test:db:local"], "cd ../../.. && npm run test:db:local");
  assert.equal(json("packages/db/package.json").scripts["test:db:local"], "cd ../.. && npm run test:db:local");
  assert.equal(json("apps/web/package.json").scripts["test:db:local"], undefined);
  assert.equal(json("packages/db/package.json").scripts["test:db"], undefined);
});

test("affected runner validates history without reimplementing dependency discovery", () => {
  const source = read("scripts/turbo/run-affected.mjs");
  assert.match(source, /--is-shallow-repository/);
  assert.match(source, /plan\.packages\.includes\("\/\/"\)/);
  assert.doesNotMatch(source, /git diff|git log|readFile.*\.git|from ["']typescript/);
});

test("affected adoption retains the aggregate CI gate and full-history upstream jobs", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.equal([...workflow.matchAll(/fetch-depth: 0/g)].length, 3);
  assert.match(workflow, /^  ci:/m);
  assert.match(workflow, /name: CI/);
  assert.match(workflow, /needs: \[app, db_core, db_feature_store\]/);
});
