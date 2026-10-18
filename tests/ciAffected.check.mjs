import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SKIP_SET, decide, run } from "../scripts/ci/affected.mjs";

const pr = (files) => decide({ event: "pull_request", files });
const suites = (files) => [pr(files).app, pr(files).db];

test("pushes, empty diffs and selection errors run every suite", () => {
  assert.deepEqual(decide({ event: "push", files: ["docs/example-notes.md"] }), { app: true, db: true, reason: "full run" });
  assert.deepEqual(suites([]), [true, true]);
  const failed = run({ event: "pull_request", base: "0".repeat(40), head: "f".repeat(40) });
  assert.deepEqual([failed.app, failed.db], [true, true]);
  assert.match(failed.reason, /^selection error, running everything/);
});

test("UI-layer and documentation changes run App checks and skip DB integration", () => {
  for (const files of [["src/components/A.tsx"], ["src/store/hooks.ts"], ["src/app/page.tsx"], ["src/app/admin/page.tsx"],
    ["public/icon.svg"], ["EXAMPLE-NOTES.md"], ["docs/example-notes.md"], ["docs/data/example.json"],
    [".github/ISSUE_TEMPLATE/example.md"], ["src/components/A.tsx", "docs/example-notes.md"]]) {
    assert.deepEqual(suites(files), [true, false], files.join(","));
  }
});

test("everything outside the skip set runs every suite", () => {
  for (const file of ["src/app/api/stream/route.ts", "src/lib/db.ts", "src/types/index.ts", "scripts/check.sh",
    "tests/db/x.test.ts", "tests/db/fixtures/README.md", "db/migrations/0012_x.sql", "package.json", "package-lock.json",
    "npm-shrinkwrap.json", ".npmrc", ".dependency-cruiser.cjs", "eslint.config.mjs", ".github/workflows/ci.yml",
    "compose.test.yml", "scripts/ci/affected.mjs", "brand-new/file.txt"]) {
    assert.deepEqual(suites([file]), [true, true], file);
    assert.deepEqual(suites(["src/components/A.tsx", file]), [true, true], `UI plus ${file}`);
  }
});

test("the selector's skip set is exactly the boundary dependency-cruiser enforces", async () => {
  const { default: config } = await import("../.dependency-cruiser.cjs");
  for (const rule of config.forbidden) assert.equal(rule.from.pathNot, SKIP_SET, rule.name);
  assert.equal(config.forbidden.find((rule) => rule.name === "no-skip-set-from-outside").to.path, SKIP_SET);
});

test("moving a file out of the DB-relevant area counts its old path (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-affected-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  try {
    g("init", "-q", "-b", "main"); g("config", "user.email", "probe@example.invalid"); g("config", "user.name", "probe");
    write("src/lib/helper.ts", "export const x = 1;\n");
    g("add", "-A"); g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    mkdirSync(join(dir, "src/components"), { recursive: true });
    renameSync(join(dir, "src/lib/helper.ts"), join(dir, "src/components/helper.ts"));
    write("public/tab\tname.svg", "<svg/>\n");
    g("add", "-A"); g("commit", "-qm", "move");
    const result = run({ event: "pull_request", base, head: g("rev-parse", "HEAD"), cwd: dir });
    assert.deepEqual([result.app, result.db, result.reason], [true, true, "DB input: src/lib/helper.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
