// Decides which expensive CI suites a change needs (#140). Fail closed:
// - Both sides of a PR are analysed. The database suite's code inputs are the
//   union of its transitive local-import closures at the merge base and at the
//   head, so deleted or renamed dependencies still select the suite.
// - Any unresolvable local import, or any non-literal module load (dynamic
//   import(), require() or createRequire with a computed argument) in the
//   suite's code runs the suite, because a static graph cannot follow it.
// - Non-code files a suite reads at runtime (SQL, fixtures, contracts, docs)
//   are declared in SIDE_INPUTS. tests/ciAffected.check.mjs scans the code for
//   literal file references, including bare file names, and fails when a read
//   file is undeclared, so the manifest cannot silently go stale.
// - Global inputs (workflows, toolchain, configs, this detector) and any
//   detection error run everything.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Changing any of these can change how every suite runs.
export const GLOBAL_INPUTS = [
  /^\.github\/workflows\//, /^\.nvmrc$/, /^tsconfig[^/]*\.json$/, /^scripts\/ci\//,
  /^vitest[^/]*\.m?[jt]s$/, /^eslint\.config\.[cm]?[jt]s$/, /^next\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/, /^\.npmrc$/,
];

// Documentation that affects nothing unless a suite declares or references it.
const DOC_LIKE = [/\.md$/, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Code entry points for the database suite. Its code input set is the
// transitive local-import closure of these paths.
export const DB_ENTRY_POINTS = [
  "tests/db", "scripts/test-db.mjs", "scripts/db-migrations",
  "scripts/db-catalog.mjs", "scripts/db-catalog-contracts.mjs", "scripts/compare-db-catalog.mjs",
  "scripts/db-migrate.mjs", "scripts/db-migrate-dev.mjs", "scripts/db-migration-artifacts.mjs",
  "scripts/db-readiness-manifest.mjs", "scripts/db-test-contract.mjs", "scripts/db-test-reporter.mjs",
  "vitest.db.config.mts",
];

// Non-code files or directories each suite reads at runtime. Paths ending in
// "/" cover everything below them.
export const SIDE_INPUTS = {
  db: ["db/", "tests/db/", "compose.test.yml",
    "scripts/creator-corpus/registration.json", "scripts/creator-corpus/readiness-gate.json"],
  app: ["docs/creator-corpus-operations.md", "docs/creator-corpus-test-matrix.md"],
};

const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;
// A module load whose argument is not a plain string literal.
const DYNAMIC_LOAD = /\bimport\s*\(\s*(?!["'])|\brequire(?:\.resolve)?\s*\(\s*(?!["'])|\bcreateRequire\b/;
const LITERAL = /["'`]([A-Za-z0-9_.][A-Za-z0-9_./-]*)["'`]/g;

export const covered = (path, entries) => entries.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);

// A read-only view of the repository at one revision: `files` are
// repo-relative POSIX paths; `read` returns a source file's text or null.
export const makeTree = (paths, read) => {
  const files = new Set(paths);
  const dirs = new Set();
  for (const path of files) for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);
  return { files, dirs, read };
};

// The working tree (used by tests and local runs).
export const fsTree = (root = ROOT) => {
  const walk = (dir) => readdirSync(join(root, dir)).flatMap((name) => {
    if (name === "node_modules" || name === ".git" || name === ".next") return [];
    const path = dir ? `${dir}/${name}` : name;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });
  return makeTree(walk(""), (path) => readFileSync(join(root, path), "utf8"));
};

const git = (args, input) => execFileSync("git", args, { cwd: ROOT, input, maxBuffer: 512 * 1024 * 1024 });

// The repository at a commit, read through git. Source files are loaded with
// a single `git cat-file --batch` call.
export const gitTree = (sha) => {
  const paths = git(["ls-tree", "-r", "-z", "--name-only", sha]).toString("utf8").split("\0").filter(Boolean);
  const sources = paths.filter((path) => SOURCE.test(path) && !path.includes("node_modules/"));
  const output = git(["cat-file", "--batch"], sources.map((path) => `${sha}:${path}`).join("\n") + "\n");
  const contents = new Map();
  let offset = 0;
  for (const path of sources) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    contents.set(path, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return makeTree(paths, (path) => contents.get(path) ?? null);
};

export const listSourceFiles = (tree, path) =>
  [...tree.files].filter((file) => (file === path || file.startsWith(`${path}/`)) && SOURCE.test(file));

const resolveLocal = (tree, from, specifier) => {
  const base = specifier.startsWith("@/") ? posix.join("src", specifier.slice(2)) : posix.join(posix.dirname(from), specifier);
  const candidates = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"].map((suffix) => posix.normalize(base + suffix));
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((candidate) => tree.files.has(candidate)) ?? null;
};

const packageName = (specifier) => {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return PACKAGE.test(name) ? name : null;
};

// The suite's transitive local files, the npm packages they import, and
// reasons the static graph is incomplete (each forces the suite to run).
export const importGraph = (tree, entryPoints = DB_ENTRY_POINTS) => {
  const queue = entryPoints.flatMap((path) => listSourceFiles(tree, path));
  const files = new Set();
  const packages = new Set();
  const unresolved = [];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const text = tree.read(file) ?? "";
    if (DYNAMIC_LOAD.test(text)) unresolved.push(`${file}: non-literal module load`);
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const local = resolveLocal(tree, file, specifier);
        if (local) queue.push(local);
        else unresolved.push(`${file} -> ${specifier}`);
      } else {
        const name = packageName(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return { files, packages, unresolved };
};

// Union of two graphs, so removed dependencies still count.
export const unionGraphs = (a, b) => ({
  files: new Set([...a.files, ...b.files]),
  packages: new Set([...a.packages, ...b.packages]),
  unresolved: [...a.unresolved, ...b.unresolved],
});

// Repo paths named by string literals in source files, including bare file
// names ("fixture.sql"), resolved relative to the referencing file or the
// repository root. Directory names count only when written with a "/".
export const referencedPaths = (tree, sourceFiles) => {
  const found = new Set();
  for (const file of sourceFiles) {
    for (const [, literal] of (tree.read(file) ?? "").matchAll(LITERAL)) {
      if (/^[./]+$/.test(literal)) continue;
      for (const candidate of [posix.normalize(posix.join(posix.dirname(file), literal)), posix.normalize(literal)]) {
        if (candidate.startsWith("..") || candidate.startsWith("node_modules/")) continue;
        const dir = candidate.replace(/\/$/, "");
        if (tree.files.has(candidate)) found.add(candidate);
        else if (literal.includes("/") && tree.dirs.has(dir)) found.add(`${dir}/`);
      }
    }
  }
  return found;
};

const entryName = (key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

// Runtime dependency closure from a package-lock v3 "packages" map. Optional
// peers are excluded; required peers and optional dependencies are included.
export const dependencyClosure = (lock, roots) => {
  const byName = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key) continue;
    const name = entryName(key);
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  const closure = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const entry of byName.get(name) ?? []) {
      const optionalPeers = entry.peerDependenciesMeta ?? {};
      queue.push(...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}),
        ...Object.keys(entry.peerDependencies ?? {}).filter((peer) => !optionalPeers[peer]?.optional));
    }
  }
  return closure;
};

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

// Package names whose complete lock entry differs between two lockfiles:
// version, integrity, dependencies, peer metadata, install scripts, and so on.
export const changedPackages = (before, after) => {
  const keys = new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})]);
  return new Set([...keys].filter((key) => key && canonical(before.packages?.[key]) !== canonical(after.packages?.[key]))
    .map(entryName));
};

// package.json changes outside dependency versions (scripts, engines, config)
// can change how any suite runs.
const withoutDependencies = (manifest) => {
  const { dependencies, devDependencies, optionalDependencies, peerDependencies, ...rest } = manifest;
  void dependencies; void devDependencies; void optionalDependencies; void peerDependencies;
  return canonical(rest);
};

export const decide = ({ event, files, dbFiles = new Set(), unresolved = [], manifestChanged = false,
  dbPackagesChanged = false, referencedDocs = new Set() }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const global = files.find((file) => GLOBAL_INPUTS.some((rule) => rule.test(file)));
  if (global) return { app: true, db: true, reason: `global input: ${global}` };
  const appInput = (file) => !DOC_LIKE.some((rule) => rule.test(file)) || covered(file, SIDE_INPUTS.app) || referencedDocs.has(file);
  const appFile = files.find(appInput);
  const dbFile = files.find((file) => dbFiles.has(file) || covered(file, SIDE_INPUTS.db));
  const db = Boolean(dbFile) || unresolved.length > 0 || manifestChanged || dbPackagesChanged;
  const reason = dbFile ? `database-suite input: ${dbFile}`
    : unresolved.length ? `incomplete static graph: ${unresolved[0]}`
    : manifestChanged ? "package.json changed outside dependency versions"
    : dbPackagesChanged ? "a database-suite dependency changed"
    : appFile ? `app input: ${appFile}` : "docs only";
  return { app: Boolean(appFile) || db, db, reason };
};

const readJsonAt = (sha, path) => {
  try { return JSON.parse(git(["show", `${sha}:${path}`]).toString("utf8")); } catch { return {}; }
};

// The decision for one PR, analysing both the merge base and the head.
export const analyse = ({ files, trees, locks = [{}, {}], manifests = [{}, {}] }) => {
  const graph = unionGraphs(importGraph(trees[0]), importGraph(trees[1]));
  let manifestChanged = false;
  let dbPackagesChanged = false;
  if (files.some((file) => DEPENDENCY_FILES.has(file))) {
    manifestChanged = withoutDependencies(manifests[0]) !== withoutDependencies(manifests[1]);
    const reachable = new Set([...dependencyClosure(locks[0], graph.packages), ...dependencyClosure(locks[1], graph.packages)]);
    dbPackagesChanged = [...changedPackages(locks[0], locks[1])].some((name) => reachable.has(name));
  }
  const referencedDocs = new Set(files.some((file) => DOC_LIKE.some((rule) => rule.test(file)))
    ? trees.flatMap((tree) => [...referencedPaths(tree, ["src", "scripts", "tests"].flatMap((dir) => listSourceFiles(tree, dir)))])
    : []);
  return decide({ event: "pull_request", files, dbFiles: graph.files, unresolved: graph.unresolved,
    manifestChanged, dbPackagesChanged, referencedDocs });
};

const detect = ({ event, base, head }) => {
  if (event !== "pull_request") return decide({ event, files: [] });
  const mergeBase = git(["merge-base", base, head]).toString("utf8").trim();
  const files = git(["diff", "--name-only", `${mergeBase}...${head}`]).toString("utf8").split("\n").filter(Boolean);
  const shas = [mergeBase, head];
  return analyse({ files, trees: shas.map(gitTree),
    locks: shas.map((sha) => readJsonAt(sha, "package-lock.json")),
    manifests: shas.map((sha) => readJsonAt(sha, "package.json")) });
};

// Any detection error runs every suite rather than blocking or skipping.
export const run = (options) => {
  try { return detect(options); }
  catch (error) { return { app: true, db: true, reason: `detection error, running everything: ${String(error.message).split("\n")[0]}` }; }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run({ event: process.env.EVENT_NAME, base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  console.log(`app=${result.app} db=${result.db} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `app=${result.app}\ndb=${result.db}\n`);
}
