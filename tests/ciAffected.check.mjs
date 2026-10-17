import assert from "node:assert/strict";
import { test } from "node:test";
import { SIDE_INPUTS, analyse, changedPackages, covered, decide, dependencyClosure, fsTree, hasDynamicLoad, importGraph,
  listSourceFiles, makeTree, referencedPaths, run } from "../scripts/ci/affected.mjs";

// Fixture paths are deliberately fictional so this file never looks like a real
// reader of repository docs.
const pr = (files, extra = {}) => decide({ event: "pull_request", files, ...extra });
const tree = (files) => makeTree(Object.keys(files), (path) => files[path] ?? null);
const repo = fsTree();
const graph = importGraph(repo);

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
  const result = pr(["EXAMPLE-NOTES.md", "docs/example-notes.md", ".github/ISSUE_TEMPLATE/example.md", "examples/EXAMPLE.md"]);
  assert.deepEqual([result.app, result.db, result.reason], [false, false, "docs only"]);
});

test("docs read by tests schedule App checks", () => {
  for (const doc of ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"]) {
    assert.equal(pr([doc]).app, true, doc);
  }
  // A doc referenced from code is an input even if the manifest misses it.
  assert.equal(pr(["docs/example-notes.md"], { referencedDocs: new Set(["docs/example-notes.md"]) }).app, true);
});

test("database relevance comes from the import closure, not directories", () => {
  for (const file of ["src/app/admin/export/route.ts", "src/app/admin/page.tsx", "src/components/DatabaseReport.tsx"]) {
    assert.equal(pr([file]).db, false, `${file} is outside the closure`);
    assert.equal(pr([file], { dbFiles: new Set([file]) }).db, true, `${file} once imported by the suite`);
    assert.equal(pr([file]).app, true, file);
  }
});

test("deleting a database-suite module selects the suite from the base-side graph", () => {
  const base = tree({ "tests/db/catalog-unit.check.mjs": 'import { x } from "../../scripts/db-catalog.mjs";',
    "scripts/db-catalog.mjs": "export const x = 1;" });
  const head = tree({ "tests/db/catalog-unit.check.mjs": 'import { x } from "../../scripts/db-catalog.mjs";' });
  assert.equal(analyse({ files: ["scripts/db-catalog.mjs"], trees: [base, head] }).db, true);
});

test("renaming a database-suite entry point or transitive module selects the suite", () => {
  const base = tree({ "tests/db/a.test.ts": 'import "../../src/lib/old.ts";', "src/lib/old.ts": 'import "./leaf.ts";',
    "src/lib/leaf.ts": "" });
  const head = tree({ "tests/db/a.test.ts": 'import "../../src/lib/renamed.ts";', "src/lib/renamed.ts": "" });
  assert.equal(analyse({ files: ["src/lib/old.ts", "src/lib/leaf.ts"], trees: [base, head] }).db, true);
  assert.equal(analyse({ files: ["src/lib/renamed.ts"], trees: [base, head] }).db, true);
  const renamedEntry = tree({ "scripts/test-db.mjs": "" });
  const removedEntry = tree({});
  assert.equal(analyse({ files: ["scripts/test-db.mjs"], trees: [renamedEntry, removedEntry] }).db, true);
});

test("non-literal module loading in the database suite fails closed", () => {
  for (const code of ['const target = "dep.mjs";\nawait import(target);', "await import(\n  target\n);",
    "const r = createRequire(import.meta.url);", "require(name);", "await import(`./${name}.mjs`);"]) {
    const suite = tree({ "tests/db/x.test.ts": code, "tests/db/dep.mjs": "" });
    assert.ok(importGraph(suite).unresolved.length > 0, code);
    assert.equal(analyse({ files: ["src/components/A.tsx"], trees: [suite, suite] }).db, true, code);
  }
  const literal = tree({ "tests/db/x.test.ts": 'await import("./dep.mjs"); await import("pg");', "tests/db/dep.mjs": "" });
  assert.deepEqual(importGraph(literal).unresolved, []);
});

test("a load is static only when its whole argument is one string literal", () => {
  // The literal prefix resolves to a real module, so a prefix-only check would
  // confidently follow adapter.mjs and miss adapter-pg.mjs.
  for (const code of ['const suffix = process.env.DRIVER;\nawait import("./adapter" + suffix);',
    'const m = require("./adapter" + suffix);', "require.resolve('./adapter' + suffix);",
    'await import("./adapter"/* driver */ + suffix);',
    'await import /* selector */ ("./adapter-" + suffix);', 'require /* selector */ ("./adapter-" + suffix);',
    'await import // selector\n("./adapter-" + suffix);', "const load = require; load(name);",
    "const re = /import(/; await import(name);", "export const broken = (;"]) {
    assert.equal(hasDynamicLoad(code), true, code);
    const suite = tree({ "scripts/test-db.mjs": code, "scripts/adapter.mjs": "", "scripts/adapter-pg.mjs": "" });
    // adapter-pg.mjs is outside the static closure; the incomplete graph must still select the suite.
    assert.ok(!importGraph(suite).files.has("scripts/adapter-pg.mjs"));
    assert.equal(analyse({ files: ["scripts/adapter-pg.mjs"], trees: [suite, suite] }).db, true, code);
  }
  for (const code of ['await import("./adapter.mjs");', "await import( './adapter.mjs' );",
    'await import("./data.json", { with: { type: "json" } });', 'const pg = require("pg");', "import.meta.url;",
    'import x from "./adapter.mjs";', 'const re = /require(x)/; // import(name)\nconst s = "import(name)";',
    "type T = import(\"./adapter.mjs\").Thing;"]) {
    assert.equal(hasDynamicLoad(code), false, code);
  }
  // A real parser decodes escapes, so this is a static load of ./adapter.mjs.
  const escaped = tree({ "scripts/test-db.mjs": 'await import("./ad\\x61pter.mjs");', "scripts/adapter.mjs": "" });
  assert.deepEqual([...importGraph(escaped).files].sort(), ["scripts/adapter.mjs", "scripts/test-db.mjs"]);
});

test("runtime-input discovery includes bare file names and relative paths", () => {
  const suite = tree({ "scripts/db-x.mjs": 'readFileSync("fixture.sql"); readFileSync("../db/schema.sql");',
    "scripts/fixture.sql": "", "db/schema.sql": "" });
  assert.deepEqual([...referencedPaths(suite, ["scripts/db-x.mjs"])].sort(), ["db/schema.sql", "scripts/fixture.sql"]);
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

test("dependency files skip the database suite only when no database-reachable lock entry changed", () => {
  const suite = tree({ "tests/db/x.test.ts": 'import pg from "pg";' });
  const lock = (pg) => ({ packages: { "": {}, "node_modules/pg": pg, "node_modules/next": { version: "1" } } });
  const files = ["package.json", "package-lock.json"];
  const unrelated = { packages: { ...lock({ version: "1" }).packages, "node_modules/next": { version: "2" } } };
  assert.equal(analyse({ files, trees: [suite, suite], locks: [lock({ version: "1" }), unrelated] }).db, false);
  assert.equal(analyse({ files, trees: [suite, suite], locks: [lock({ version: "1" }), lock({ version: "2" })] }).db, true);
  assert.equal(analyse({ files, trees: [suite, suite], manifests: [{ scripts: { a: "1" } }, { scripts: { a: "2" } }] }).db, true);
});

test("metadata-only changes to a reachable lock entry select the database suite", () => {
  const before = { packages: { "": {}, "node_modules/pg": { version: "1", integrity: "x", dependencies: { a: "1" } } } };
  const after = { packages: { "": {}, "node_modules/pg": { version: "1", integrity: "x", dependencies: { a: "1", b: "1" } } } };
  assert.deepEqual([...changedPackages(before, after)], ["pg"]);
  const scripts = { packages: { "": {}, "node_modules/pg": { version: "1", integrity: "x", dependencies: { a: "1" }, hasInstallScript: true } } };
  assert.deepEqual([...changedPackages(before, scripts)], ["pg"]);
  const reordered = { packages: { "": {}, "node_modules/pg": { dependencies: { a: "1" }, integrity: "x", version: "1" } } };
  assert.deepEqual([...changedPackages(before, reordered)], []);
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

test("a detection error runs every suite instead of failing or skipping", () => {
  const result = run({ event: "pull_request", base: "0".repeat(40), head: "f".repeat(40) });
  assert.deepEqual([result.app, result.db], [true, true]);
  assert.match(result.reason, /^detection error, running everything/);
});

test("the real database import graph is complete and reaches its driver and test runner", () => {
  assert.deepEqual(graph.unresolved, []);
  for (const name of ["pg", "@neondatabase/serverless", "vitest"]) assert.ok(graph.packages.has(name), name);
  assert.ok(graph.files.has("src/lib/db.ts"));
});

test("every file the database suite's code names is in its closure or declared as a side input", () => {
  const undeclared = [...referencedPaths(repo, [...graph.files])]
    .filter((path) => !graph.files.has(path) && !covered(path, SIDE_INPUTS.db));
  assert.deepEqual(undeclared, [], "declare these in SIDE_INPUTS.db");
});

test("every doc named by any code is declared as an App side input", () => {
  const code = ["src", "scripts", "tests"].flatMap((dir) => listSourceFiles(repo, dir));
  const docs = [...referencedPaths(repo, code)].filter((path) => /\.md$|^docs\//.test(path));
  assert.deepEqual(docs.filter((path) => !covered(path, SIDE_INPUTS.app)), [], "declare these in SIDE_INPUTS.app");
});
