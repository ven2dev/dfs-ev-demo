import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { APP_DOC_INPUTS, DOC_LIKE, decide, run } from "../scripts/ci/affected.mjs";
import { fsTree, listSourceFiles, makeTree, referencedPaths } from "../scripts/ci/docReferences.mjs";

// Fixture paths are fictional so this file never looks like a reader of real docs.
const pr = (files) => decide({ event: "pull_request", files });
const both = (files) => [pr(files).app, pr(files).db];
const tree = (files) => makeTree(Object.keys(files), (path) => files[path] ?? null);
const isDocPath = (path) => path.endsWith("/") ? DOC_LIKE.some((rule) => rule.test(`${path}x.md`)) : DOC_LIKE.some((rule) => rule.test(path));

test("pushes, empty diffs and selection errors run every suite", () => {
  assert.deepEqual(decide({ event: "push", files: ["docs/example-notes.md"] }), { app: true, db: true, reason: "full run" });
  assert.deepEqual(both([]), [true, true]);
  const failed = run({ event: "pull_request", base: "0".repeat(40), head: "f".repeat(40) });
  assert.deepEqual([failed.app, failed.db], [true, true]);
  assert.match(failed.reason, /^selection error, running everything/);
});

test("documentation no test reads skips both suites", () => {
  const result = pr(["EXAMPLE-NOTES.md", "docs/example-notes.md", "docs/sub/example.md", ".github/ISSUE_TEMPLATE/example.md"]);
  assert.deepEqual([result.app, result.db, result.reason], [false, false, "docs only"]);
});

test("any other change runs every suite", () => {
  for (const file of [...APP_DOC_INPUTS, "tests/db/fixtures/README.md", "scripts/example/NOTES.md", "src/components/A.tsx",
    "src/lib/db.ts", "public/icon.svg", "package-lock.json", "npm-shrinkwrap.json", ".github/workflows/ci.yml",
    "compose.test.yml", "brand-new/file.txt"]) {
    assert.deepEqual(both([file]), [true, true], file);
    assert.deepEqual(both(["docs/example-notes.md", file]), [true, true], `docs plus ${file}`);
  }
});

test("moving a declared doc input counts its old path (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-affected-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  try {
    g("init", "-q", "-b", "main"); g("config", "user.email", "probe@example.invalid"); g("config", "user.name", "probe");
    write(APP_DOC_INPUTS[0], "# runbook\n");
    g("add", "-A"); g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    renameSync(join(dir, APP_DOC_INPUTS[0]), join(dir, "docs/moved-notes.md"));
    write("docs/tab\tname.md", "x\n");
    g("add", "-A"); g("commit", "-qm", "move");
    const result = run({ event: "pull_request", base, head: g("rev-parse", "HEAD"), cwd: dir });
    assert.deepEqual([result.app, result.db, result.reason], [true, true, `input: ${APP_DOC_INPUTS[0]}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doc references are found through relative paths, bare names and file URLs", () => {
  // A synthetic "manuals" directory keeps real doc paths out of this file.
  const files = { "tests/x.test.ts": 'readFileSync(new URL("../manuals/runbook%2Dnotes.md?raw#top", import.meta.url));'
    + ' readFileSync("manuals/matrix.md"); readdirSync("manuals");',
  "manuals/runbook-notes.md": "", "manuals/matrix.md": "" };
  assert.deepEqual([...referencedPaths(tree(files), ["tests/x.test.ts"])].sort(),
    ["manuals/", "manuals/matrix.md", "manuals/runbook-notes.md"]);
});

test("every doc named by code is a declared input, and no code names a docs directory", () => {
  const repo = fsTree();
  const docs = [...referencedPaths(repo, listSourceFiles(repo, ["src", "scripts", "tests"]))].filter(isDocPath);
  assert.deepEqual(docs.filter((doc) => !APP_DOC_INPUTS.includes(doc)), [],
    "declare these in APP_DOC_INPUTS (a referenced docs directory makes the docs-only rule unsafe)");
  for (const doc of APP_DOC_INPUTS) assert.ok(docs.includes(doc), `stale APP_DOC_INPUTS entry: ${doc}`);
});
