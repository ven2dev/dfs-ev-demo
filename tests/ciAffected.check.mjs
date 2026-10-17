import assert from "node:assert/strict";
import { test } from "node:test";
import { changedPackages, decide, dependencyClosure, importedPackages } from "../scripts/ci/affected.mjs";

const pr = (files, extra = {}) => decide({ event: "pull_request", files, manifestChanged: false, dbPackagesChanged: false, ...extra });

test("pushes and empty diffs run every suite", () => {
  assert.deepEqual(decide({ event: "push", files: ["docs/a.md"] }), { app: true, db: true, reason: "full run" });
  assert.equal(pr([]).db, true);
  assert.equal(pr([]).app, true);
});

test("docs-only changes skip both suites", () => {
  const result = pr(["README.md", "docs/predictive-data-platform.md", ".github/ISSUE_TEMPLATE/feature.md", "AGENTS.md"]);
  assert.equal(result.app, false);
  assert.equal(result.db, false);
});

test("UI-only changes run app checks but skip the database suite", () => {
  const result = pr(["src/components/HitRateSummary.tsx", "src/app/page.tsx", "src/store/hooks.ts", "src/app/page.test.tsx"]);
  assert.equal(result.app, true);
  assert.equal(result.db, false);
});

test("anything not known to be database-safe runs the database suite (deny-by-default)", () => {
  for (const file of ["src/lib/db.ts", "src/app/api/stream/route.ts", "db/migrations/0012_x.sql", "tests/db/setup.ts",
    "scripts/test-db.mjs", "compose.test.yml", ".github/workflows/ci.yml", ".nvmrc", "src/types/index.ts",
    "vitest.db.config.mts", "some/new/file.ts"]) {
    assert.equal(pr(["src/components/A.tsx", file]).db, true, file);
  }
});

test("dependency files skip the database suite only when no database-reachable package changed", () => {
  assert.equal(pr(["package.json", "package-lock.json"]).db, false);
  assert.equal(pr(["package-lock.json"], { dbPackagesChanged: true }).db, true);
  assert.equal(pr(["package.json"], { manifestChanged: true }).db, true);
  assert.equal(pr(["package.json", "package-lock.json"]).app, true);
});

test("dependency closure follows dependencies and required peers but not optional peers", () => {
  const lock = { packages: {
    "": { name: "app" },
    "node_modules/pg": { version: "1", dependencies: { "pg-pool": "1" } },
    "node_modules/pg-pool": { version: "1", peerDependencies: { pg: "*", required: "*", optional: "*" },
      peerDependenciesMeta: { optional: { optional: true } } },
    "node_modules/required": { version: "1", optionalDependencies: { native: "1" } },
    "node_modules/native": { version: "1" },
    "node_modules/optional": { version: "1" },
    "node_modules/next": { version: "1" },
    "node_modules/a/node_modules/pg-pool": { version: "2" },
  } };
  assert.deepEqual([...dependencyClosure(lock, ["pg"])].sort(), ["native", "pg", "pg-pool", "required"]);
});

test("changed packages include nested lock entries and additions/removals", () => {
  const before = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/x/node_modules/b": { version: "1" }, "node_modules/gone": { version: "1" } } };
  const after = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/x/node_modules/b": { version: "2" }, "node_modules/new": { version: "1" } } };
  assert.deepEqual([...changedPackages(before, after)].sort(), ["b", "gone", "new"]);
});

test("the real database suite import graph reaches its driver and test runner", () => {
  const packages = importedPackages();
  for (const name of ["pg", "@neondatabase/serverless", "vitest"]) assert.ok(packages.has(name), name);
  for (const name of packages) assert.match(name, /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/);
});
