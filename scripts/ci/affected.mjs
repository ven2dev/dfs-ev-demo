// Interim CI suite selection (#140) until the workspace monorepo (#148) moves
// selection to per-package Turborepo task graphs.
//
// DB integration is skipped when every changed file is in the skip set: the
// UI layer and documentation. App checks always run on PRs. The premise that
// nothing outside the skip set depends on it is enforced in App checks by
// dependency-cruiser (.dependency-cruiser.cjs) and by the ESLint rule that
// refuses non-literal module loads (eslint.config.mjs). Pushes to main and
// any selection error run everything; a failure before or after selection
// (runner setup, writing outputs) fails the detect job, which blocks the
// required CI gate. Non-import file access to skip-set paths is accepted
// residual risk; see docs/database-testing.md.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Must equal SKIP_SET in .dependency-cruiser.cjs (enforced by tests/ciAffected.check.mjs).
export const SKIP_SET = "^(src/components/|src/store/|src/app/(?!api/)|public/|docs/|[^/]+[.]md$|[.]github/ISSUE_TEMPLATE/)";

const inSkipSet = (file) => new RegExp(SKIP_SET).test(file);

export const decide = ({ event, files }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const dbInput = files.find((file) => !inSkipSet(file));
  return { app: true, db: Boolean(dbInput), reason: dbInput ? `DB input: ${dbInput}` : "UI layer and docs only" };
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
