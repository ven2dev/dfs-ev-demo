import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT, SIDE_INPUTS, changedPackages, covered, decide, dependencyClosure, importGraph, listSourceFiles,
  referencedPaths, run } from "../scripts/ci/affected.mjs";

// Fixture paths are deliberately fictional so this file never looks like a real
// reader of repository docs.
const pr = (files, extra = {}) => decide({ event: "pull_request", files, ...extra });
const graph = importGraph();

test("pushes and empty diffs run every suite", () => {
  assert.deepEqual(decide({ event: "push", files: ["docs/example-notes.md"] }), { app: true, db: true, reason: "full run" });
  assert.equal(pr([]).db, true);
  assert.equal(pr([]).app, true);
});

test("global inputs run every suite", () => {
  for (const file of [".github/workflows/ci.yml", ".nvmrc", "tsconfig.json", "scripts/ci/affected.mjs",
    "vitest.config.ts", "eslint.config.mjs", "next.config.ts"]) {
    assert.deepEqual([pr([file]).app, pr([file]).db], [true, true], file);
  }
});

test("unreferenced, undeclared docs skip both suites", () => {
  const result = pr(["README.md", "docs/example-notes.md", ".github/ISSUE_TEMPLATE/example.md", "AGENTS.md"]);
  assert.deepEqual([result.app, result.db, result.reason], [false, false, "docs only"]);
});

test("P1 regression: docs read by tests schedule App checks", () => {
  for (const doc of ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"]) {
    assert.equal(pr([doc]).app, true, doc);
  }
  // A doc referenced from code is an input even if the manifest misses it.
  assert.equal(pr(["docs/example-notes.md"], { referencedDocs: new Set(["docs/example-notes.md"]) }).app, true);
});

test("P2 regression: database relevance comes from the live import closure, not directories", () => {
  for (const file of ["src/app/admin/export/route.ts", "src/app/admin/page.tsx", "src/components/DatabaseReport.tsx"]) {
    assert.equal(pr([file]).db, false, `${file} is outside the closure`);
    assert.equal(pr([file], { dbFiles: new Set([file]) }).db, true, `${file} once imported by the suite`);
    assert.equal(pr([file]).app, true, file);
  }
});

test("unresolved local imports run the database suite", () => {
  assert.equal(pr(["src/components/A.tsx"], { unresolved: ["tests/db/x.test.ts -> ./missing"] }).db, true);
});

test("declared database side inputs run the database suite", () => {
  for (const file of ["db/migrations/0012_x.sql", "db/catalog-contracts/0001.json", "tests/db/fixtures/pre-41.schema.sql",
    "compose.test.yml", "scripts/creator-corpus/readiness-gate.json"]) {
    assert.equal(pr([file]).db, true, file);
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

test("changed packages include nested lock entries, additions and removals", () => {
  const before = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/x/node_modules/b": { version: "1" }, "node_modules/gone": { version: "1" } } };
  const after = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/x/node_modules/b": { version: "2" }, "node_modules/new": { version: "1" } } };
  assert.deepEqual([...changedPackages(before, after)].sort(), ["b", "gone", "new"]);
});

test("the real database import graph resolves fully and reaches its driver and test runner", () => {
  assert.deepEqual(graph.unresolved, []);
  for (const name of ["pg", "@neondatabase/serverless", "vitest"]) assert.ok(graph.packages.has(name), name);
  assert.ok(graph.files.has("src/lib/db.ts"));
});

test("every file the database suite's code names is in its closure or declared as a side input", () => {
  const undeclared = [...referencedPaths(ROOT, [...graph.files])]
    .filter((path) => !graph.files.has(path) && !covered(path, SIDE_INPUTS.db));
  assert.deepEqual(undeclared, [], "declare these in SIDE_INPUTS.db");
});

test("every doc named by any code is declared as an App side input", () => {
  const code = ["src", "scripts", "tests"].flatMap((dir) => listSourceFiles(ROOT, dir)).map((file) => file.slice(ROOT.length + 1));
  const docs = [...referencedPaths(ROOT, code)].filter((path) => /\.md$|^docs\//.test(path));
  assert.deepEqual(docs.filter((path) => !covered(path, SIDE_INPUTS.app)), [], "declare these in SIDE_INPUTS.app");
});

test("a detection error runs every suite instead of failing or skipping", () => {
  const result = run({ event: "pull_request", base: "0".repeat(40), head: "f".repeat(40) });
  assert.deepEqual([result.app, result.db], [true, true]);
  assert.match(result.reason, /^detection error, running everything/);
});
