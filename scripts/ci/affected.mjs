// Interim CI suite selection (#140) until the workspace monorepo (#148) moves
// selection to per-package Turborepo task graphs.
//
// - DB integration is skipped when every changed file is in the UI layer or is
//   documentation. The premise "nothing outside the UI layer imports it" is
//   enforced by dependency-cruiser (.dependency-cruiser.cjs) in App checks.
// - App checks are skipped only when every changed file is documentation that
//   no test reads (APP_DOC_INPUTS).
// - Everything else runs every suite. Pushes to main and any selection error
//   run everything. A failure before or after selection (runner setup, writing
//   outputs) fails the detect job, which blocks the required CI gate.
// Non-import file access to UI paths is accepted residual risk; see
// docs/database-testing.md.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Must equal UI_LAYER in .dependency-cruiser.cjs (enforced by tests/ciAffected.check.mjs).
export const UI_LAYER = "^(src/components/|src/store/|src/app/(?!api/)|public/)";

// Top-level Markdown, docs/ and issue templates. Markdown elsewhere (e.g.
// fixtures under tests/) is treated as code.
export const DOC_LIKE = [/^[^/]+\.md$/, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Documentation that tests read at runtime, so App checks must run for it.
export const APP_DOC_INPUTS = ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"];

const isDoc = (file) => DOC_LIKE.some((rule) => rule.test(file));
const isUi = (file) => new RegExp(UI_LAYER).test(file);

export const decide = ({ event, files }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const dbInput = files.find((file) => !isUi(file) && !isDoc(file));
  const appInput = files.find((file) => !isDoc(file) || APP_DOC_INPUTS.includes(file));
  const reason = dbInput ? `input: ${dbInput}` : appInput ? `UI/docs only (app input: ${appInput})` : "docs only";
  return { app: Boolean(dbInput || appInput), db: Boolean(dbInput), reason };
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
