import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { APP_DOC_INPUTS, DOC_LIKE, decide, isDbSafe, run } from "../scripts/ci/affected.mjs";
import { auditInputs, dbEntryPoints, declaredPackages, fsTree, hasDynamicLoad, listSourceFiles, makeTree,
  referencedDocs } from "../scripts/ci/inputAudit.mjs";

// Fixture paths are fictional so this file never looks like a reader of real docs.
const pr = (files) => decide({ event: "pull_request", files });
const tree = (files) => makeTree(Object.keys(files), (path) => files[path] ?? null);
const declared = new Set(["pg", "vitest"]);

// Exact literal occurrences in DB-suite code that name a DB-safe directory but
// are not filesystem reads. Tied to file, literal and occurrence count, so any
// new reference (even the same text in the same file) fails the audit.
const SCHEMA = "PostgreSQL schema name, not a read of the public/ folder";
const AUDIT_EXCEPTIONS = [
  { dir: "public/", file: "scripts/db-catalog.mjs", literal: "public", count: 1, reason: SCHEMA },
  { dir: "public/", file: "scripts/compare-db-catalog.mjs", literal: "public", count: 1, reason: SCHEMA },
  { dir: "public/", file: "tests/db/catalog-unit.check.mjs", literal: "public", count: 1, reason: SCHEMA },
  { dir: "public/", file: "tests/db/catalog.integration.check.mjs", literal: "public", count: 1, reason: SCHEMA },
];

// DB-suite inputs that reach the DB-safe set, after exact-occurrence exceptions.
const safeViolations = (result, files, exceptions = []) => {
  const violations = [...result.files].filter(isDbSafe).map((file) => `file ${file}`);
  for (const [dir, refs] of result.dirRefs) {
    if (!isDbSafe(dir) && ![...files].some((file) => file.startsWith(dir) && isDbSafe(file))) continue;
    for (const [key, count] of refs) {
      const [file, literal] = key.split("\0");
      const excepted = exceptions.some((entry) => entry.dir === dir && entry.file === file && entry.literal === literal && entry.count === count);
      if (!excepted) violations.push(`dir ${dir} via ${file} ${JSON.stringify(literal)} x${count}`);
    }
  }
  return violations;
};

// --- Selection rules -------------------------------------------------------

test("pushes, empty diffs and selection errors run every suite", () => {
  assert.deepEqual(decide({ event: "push", files: ["docs/example-notes.md"] }), { app: true, db: true, reason: "full run" });
  assert.deepEqual([pr([]).app, pr([]).db], [true, true]);
  const failed = run({ event: "pull_request", base: "0".repeat(40), head: "f".repeat(40) });
  assert.deepEqual([failed.app, failed.db], [true, true]);
  assert.match(failed.reason, /^selection error, running everything/);
});

test("documentation no test reads skips both suites", () => {
  const result = pr(["EXAMPLE-NOTES.md", "docs/example-notes.md", ".github/ISSUE_TEMPLATE/example.md"]);
  assert.deepEqual([result.app, result.db, result.reason], [false, false, "docs only"]);
});

test("docs read by tests, and Markdown outside docs/, are inputs", () => {
  for (const doc of APP_DOC_INPUTS) assert.deepEqual([pr([doc]).app, pr([doc]).db], [true, false], doc);
  for (const file of ["tests/db/fixtures/README.md", "scripts/example/NOTES.md"]) {
    assert.deepEqual([pr([file]).app, pr([file]).db], [true, true], file);
  }
});

test("UI-only changes run App checks and skip DB integration", () => {
  for (const file of ["src/components/A.tsx", "src/app/page.tsx", "src/app/admin/page.tsx", "src/store/hooks.ts", "public/icon.svg"]) {
    assert.deepEqual([pr([file]).app, pr([file]).db], [true, false], file);
  }
});

test("everything outside the safe set runs DB integration", () => {
  for (const file of ["src/lib/db.ts", "src/types/index.ts", "src/app/api/stream/route.ts", "scripts/check.sh",
    "scripts/ci/affected.mjs", "tests/db/x.test.ts", "db/migrations/0012_x.sql", "compose.test.yml",
    "package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", ".nvmrc", "tsconfig.json",
    "vitest.db.config.mts", ".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".gitattributes",
    "brand-new/file.txt"]) {
    assert.deepEqual([pr([file]).app, pr([file]).db], [true, true], file);
  }
});

test("renames count both paths, and unusual file names survive (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-affected-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  try {
    g("init", "-q", "-b", "main"); g("config", "user.email", "probe@example.invalid"); g("config", "user.name", "probe");
    write("scripts/creator-corpus/readiness-gate.json", "{\"gate\": 1}\n");
    g("add", "-A"); g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    // Move a DB input into a DB-safe folder, unchanged.
    mkdirSync(join(dir, "public"), { recursive: true });
    renameSync(join(dir, "scripts/creator-corpus/readiness-gate.json"), join(dir, "public/readiness-gate.json"));
    write("public/tab\tname.svg", "<svg/>\n");
    g("add", "-A"); g("commit", "-qm", "move");
    const result = run({ event: "pull_request", base, head: g("rev-parse", "HEAD"), cwd: dir });
    assert.deepEqual([result.db, result.reason], [true, "DB input: scripts/creator-corpus/readiness-gate.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Verification that the rules hold for the real repository --------------

const repo = fsTree();
const entries = dbEntryPoints();
const audit = auditInputs(repo, entries.entries, declaredPackages());

test("the DB suite's entry points come from the CI DB job's real commands", () => {
  assert.deepEqual(entries.issues, []);
  assert.ok(entries.entries.includes("scripts/test-db.mjs"));
  assert.ok([...audit.files].some((file) => /^tests\/db\/.+\.test\.ts$/.test(file)), "Vitest DB tests are reached via the config glob");
});

test("the DB suite's inputs are fully classified", () => {
  assert.deepEqual(audit.issues, [], "fix the code or declare the input; never ignore an unclassified input");
  for (const name of ["pg", "@neondatabase/serverless", "vitest"]) assert.ok(audit.packages.has(name), name);
});

test("no DB-suite input lies in the DB-safe set", () => {
  assert.deepEqual(safeViolations(audit, repo.files, AUDIT_EXCEPTIONS), [], "these would let a DB-relevant change skip DB integration");
  for (const entry of AUDIT_EXCEPTIONS) {
    const count = audit.dirRefs.get(entry.dir)?.get(`${entry.file}\0${entry.literal}`);
    assert.equal(count, entry.count, `stale audit exception: ${entry.file} ${entry.literal}`);
  }
});

test("every doc named by code is declared as an App input", () => {
  // Only paths the selector treats as skippable docs matter here; Markdown
  // elsewhere is already a code input. A referenced docs directory would make
  // every doc an input, so it must not appear at all.
  const docs = [...referencedDocs(repo, listSourceFiles(repo, ["src", "scripts", "tests"]))]
    .filter((path) => path.endsWith("/") ? DOC_LIKE.some((rule) => rule.test(`${path}x.md`)) : DOC_LIKE.some((rule) => rule.test(path)));
  assert.deepEqual(docs.filter((doc) => !APP_DOC_INPUTS.includes(doc)), [], "declare these in APP_DOC_INPUTS");
});

// --- Audit behavior on reported counterexamples ------------------------------

test("unclassifiable specifiers are reported, not dropped", () => {
  const suite = tree({ "tests/db/x.test.ts": 'import a from "#db-helper"; import b from "~/lib/x"; import c from "undeclared-pkg";'
    + ' import pg from "pg"; import { test } from "node:test"; import fs from "fs";' });
  const { issues, packages } = auditInputs(suite, ["tests/db"], declared);
  assert.deepEqual(issues.map((issue) => issue.split(" ").pop()).sort(), ["#db-helper", "undeclared-pkg", "~/lib/x"]);
  assert.deepEqual([...packages], ["pg"]);
});

test("bare directory names, unusual file names and non-JS executables are inputs", () => {
  const suite = tree({ "scripts/test-db.mjs": 'readdirSync("fixtures"); readFileSync("case one.sql"); spawn("scripts/check.sh");',
    "scripts/fixtures/a.sql": "", "scripts/case one.sql": "", "scripts/check.sh": "#!/bin/sh\n" });
  const result = auditInputs(suite, ["scripts/test-db.mjs"], declared);
  assert.ok(result.dirs.has("scripts/fixtures/"));
  assert.ok(result.files.has("scripts/case one.sql"));
  assert.ok(result.files.has("scripts/check.sh"));
});

test("non-literal module loads are reported; literal ones are followed", () => {
  for (const code of ['await import /* c */ ("./adapter-" + suffix);', 'require /* c */ ("./adapter-" + suffix);',
    "await import(name);", "const r = createRequire(import.meta.url);", "const load = require; load(name);",
    "import.meta.resolve(name);", "export const broken = (;"]) {
    assert.equal(hasDynamicLoad(code), true, code);
  }
  for (const code of ['await import("./adapter.mjs");', 'const pg = require("pg");', 'import.meta.resolve("./a.mjs");',
    'const re = /require(x)/; // import(name)\nconst s = "import(name)";']) {
    assert.equal(hasDynamicLoad(code), false, code);
  }
});

// --- Second-round counterexamples ------------------------------------------

test("an exception covers only its exact occurrences, not every use of the path", () => {
  const files = { "scripts/db-catalog.mjs": 'const schema = "public"; readdirSync("public");', "public/icon.svg": "" };
  const result = auditInputs(tree(files), ["scripts/db-catalog.mjs"], declared);
  const exception = [{ dir: "public/", file: "scripts/db-catalog.mjs", literal: "public", count: 1, reason: "schema" }];
  assert.deepEqual(safeViolations(result, Object.keys(files), exception), ['dir public/ via scripts/db-catalog.mjs "public" x2']);
});

test("opaque executables are issues unless their inputs are declared, and declared inputs are audited", () => {
  const files = { "tests/db/x.test.ts": 'spawn("scripts/check.sh");', "scripts/check.sh": "node src/components/db-helper.mjs\n",
    "src/components/db-helper.mjs": "" };
  assert.deepEqual(auditInputs(tree(files), ["tests/db/x.test.ts"], declared).issues, ["scripts/check.sh: opaque executable; declare its inputs"]);
  const declaredRun = auditInputs(tree(files), ["tests/db/x.test.ts"], declared, { "scripts/check.sh": ["src/components/db-helper.mjs"] });
  assert.deepEqual(declaredRun.issues, []);
  assert.deepEqual(safeViolations(declaredRun, Object.keys(files)), ["file src/components/db-helper.mjs"]);
});

test("entry points follow the package script the CI DB job runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-entries-"));
  const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  try {
    write(".github/workflows/ci.yml", "jobs:\n  db:\n    steps:\n      - run: npm ci\n      - run: npm run test:db:local\n  ci:\n    steps: []\n");
    write("package.json", JSON.stringify({ scripts: { "test:db:local": "node src/components/db-runner.mjs" } }));
    write("src/components/db-runner.mjs", "");
    const derived = dbEntryPoints(dir);
    assert.deepEqual(derived, { entries: ["src/components/db-runner.mjs"], issues: [] });
    const result = auditInputs(fsTree(dir), derived.entries, declared);
    assert.deepEqual(safeViolations(result, ["src/components/db-runner.mjs"]), ["file src/components/db-runner.mjs"]);
    write("package.json", JSON.stringify({ scripts: { "test:db:local": "bash ./run.sh" } }));
    assert.match(dbEntryPoints(dir).issues[0], /uninterpreted command: bash \.\/run\.sh/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file-URL literals are canonicalized before matching", () => {
  const files = { "tests/db/x.test.ts": 'readFileSync(new URL("../../src/components/db%2Dhelper.mjs?audit=1#x", import.meta.url));',
    "src/components/db-helper.mjs": "" };
  const result = auditInputs(tree(files), ["tests/db/x.test.ts"], declared);
  assert.ok(result.files.has("src/components/db-helper.mjs"));
  assert.deepEqual(safeViolations(result, Object.keys(files)), ["file src/components/db-helper.mjs"]);
});
