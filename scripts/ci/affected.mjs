// Interim CI suite selection (#140): skip both suites only for documentation
// that no test or CI step reads. Every other change runs every suite.
// Faster DB integration itself is tracked separately, and per-package
// selection arrives with the workspace monorepo (#148).
//
// The docs-only rule is verified by tests/ciAffected.check.mjs: every doc that
// code names must be listed in APP_DOC_INPUTS, so it is never treated as
// skippable. Pushes to main and any selection error run everything. A failure
// before or after selection (runner setup, writing outputs) fails the detect
// job, which blocks the required CI gate without running suites.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Top-level Markdown, docs/ and issue templates. Markdown elsewhere (e.g.
// fixtures under tests/) is treated as code input.
export const DOC_LIKE = [/^[^/]+\.md$/, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Documentation that tests read at runtime, and is therefore never skippable.
export const APP_DOC_INPUTS = ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"];

export const isSkippableDoc = (file) => DOC_LIKE.some((rule) => rule.test(file)) && !APP_DOC_INPUTS.includes(file);

export const decide = ({ event, files }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const input = files.find((file) => !isSkippableDoc(file));
  return input ? { app: true, db: true, reason: `input: ${input}` } : { app: false, db: false, reason: "docs only" };
};

// Both paths of a rename are listed (--no-renames); -z keeps unusual names intact.
export const changedFiles = ({ base, head, cwd = ROOT }) => {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, head).trim();
  return git("diff", "--no-renames", "-z", "--name-only", `${mergeBase}...${head}`).split("\0").filter(Boolean);
};

// Any selection error runs every suite rather than skipping.
export const run = ({ event, base, head, cwd = ROOT }) => {
  if (event !== "pull_request") return decide({ event, files: [] });
  try { return decide({ event, files: changedFiles({ base, head, cwd }) }); }
  catch (error) { return { app: true, db: true, reason: `selection error, running everything: ${String(error.message).split("\n")[0]}` }; }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run({ event: process.env.EVENT_NAME, base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  console.log(`app=${result.app} db=${result.db} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `app=${result.app}\ndb=${result.db}\n`);
}
