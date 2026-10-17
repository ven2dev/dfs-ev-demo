// Interim CI suite selection (#140) until the workspace monorepo (#148) moves
// selection to per-package Turborepo task graphs.
//
// Pattern: conservative path rules, verified by tests. Selection never relies
// on dependency analysis; tests/ciAffected.check.mjs runs the analysis in
// scripts/ci/inputAudit.mjs and fails CI if a rule stops being true.
// - DB integration is skipped only when every changed file is in DB_SAFE.
//   Everything else runs it: library code, scripts, tests, database files,
//   package and install files, configs, workflows and this selector.
// - App checks are skipped only when every changed file is documentation that
//   no test reads (APP_DOC_INPUTS).
// - Pushes to main and any selector error run everything. A failure before or
//   after selection (dependency setup, writing outputs) fails the detect job,
//   which blocks the required CI gate without running suites.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Top-level Markdown, docs/ and issue templates. Markdown elsewhere (e.g.
// fixtures under tests/) is treated as code input.
export const DOC_LIKE = [/^[^/]+\.md$/, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Paths that cannot affect DB integration. Verified by tests/ciAffected.check.mjs:
// the DB suite's code, the files it references and its module specifiers must
// never reach these paths.
export const DB_SAFE = [
  ...DOC_LIKE,
  /^src\/components\//,
  /^src\/app\/(?!api\/)/,
  /^src\/store\//,
  /^public\//,
];

// Documentation that tests read at runtime. Verified by the same tests: every
// doc or docs directory named in code must be listed here.
export const APP_DOC_INPUTS = ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"];

export const isDbSafe = (file) => DB_SAFE.some((rule) => rule.test(file));
const isSkippableDoc = (file) => DOC_LIKE.some((rule) => rule.test(file)) && !APP_DOC_INPUTS.includes(file);

export const decide = ({ event, files }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const appFile = files.find((file) => !isSkippableDoc(file));
  const dbFile = files.find((file) => !isDbSafe(file));
  const reason = dbFile ? `DB input: ${dbFile}` : appFile ? `app input: ${appFile}` : "docs only";
  return { app: Boolean(appFile || dbFile), db: Boolean(dbFile), reason };
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
