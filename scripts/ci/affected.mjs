// Decides which expensive CI suites a change needs (#140). Fail closed:
// - The database suite's code inputs are its transitive local-import closure,
//   recomputed from the suite's entry points on every run. An unresolvable
//   local import runs the suite.
// - Non-code files a suite reads at runtime (SQL, fixtures, docs) are declared
//   in SIDE_INPUTS. tests/ciAffected.check.mjs scans the code for literal file
//   references and fails when a read file is not declared, so the manifest
//   cannot silently go stale.
// - Global inputs (workflows, toolchain, configs, this detector) run everything.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

// Code entry points for the database suite. Its full code input set is the
// transitive local-import closure of these files.
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

const toRepoPath = (root, absolute) => relative(root, absolute).split(sep).join("/");
export const covered = (path, entries) => entries.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);

export const listSourceFiles = (root, path) => {
  const full = join(root, path);
  if (!existsSync(full) || full.includes(`${sep}node_modules`)) return [];
  if (statSync(full).isFile()) return SOURCE.test(path) ? [full] : [];
  return readdirSync(full).flatMap((name) => listSourceFiles(root, join(path, name)));
};

const resolveLocal = (root, from, specifier) => {
  const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(from), specifier);
  const candidates = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"].map((suffix) => base + suffix);
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
};

const packageName = (specifier) => {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return PACKAGE.test(name) ? name : null;
};

// The suite's transitive local files, the npm packages they import, and any
// local import that could not be resolved (which forces the suite to run).
export const importGraph = (root = ROOT, entryPoints = DB_ENTRY_POINTS) => {
  const queue = entryPoints.flatMap((path) => listSourceFiles(root, path));
  const files = new Set();
  const packages = new Set();
  const unresolved = [];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const local = resolveLocal(root, file, specifier);
        if (local) queue.push(local);
        else unresolved.push(`${toRepoPath(root, file)} -> ${specifier}`);
      } else {
        const name = packageName(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return { files: new Set([...files].map((file) => toRepoPath(root, file))), packages, unresolved };
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

// Package names whose resolved lock entry differs between two lockfiles.
export const changedPackages = (before, after) => {
  const fingerprint = (entry) => JSON.stringify([entry?.version, entry?.resolved, entry?.integrity]);
  const keys = new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})]);
  return new Set([...keys].filter((key) => key && fingerprint(before.packages?.[key]) !== fingerprint(after.packages?.[key]))
    .map(entryName));
};

// package.json changes outside dependency versions (scripts, engines, config)
// can change how any suite runs.
const withoutDependencies = (manifest) => {
  const { dependencies, devDependencies, optionalDependencies, peerDependencies, ...rest } = manifest;
  void dependencies; void devDependencies; void optionalDependencies; void peerDependencies;
  return JSON.stringify(rest);
};

// Repo paths named by string literals in source files, either root-relative
// ("db/x.sql") or relative to the referencing file ("../../db/schema.sql").
// Used to enforce SIDE_INPUTS and to keep referenced docs out of "docs only".
export const referencedPaths = (root, sourceFiles) => {
  const found = new Set();
  for (const file of sourceFiles) {
    const absolute = join(root, file);
    for (const [, literal] of readFileSync(absolute, "utf8").matchAll(/["'`]([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]*)["'`]/g)) {
      if (/^[./]+$/.test(literal)) continue;
      for (const candidate of [resolve(dirname(absolute), literal), resolve(root, literal)]) {
        if (!candidate.startsWith(root + sep) || !existsSync(candidate)) continue;
        const path = toRepoPath(root, candidate);
        if (!path.startsWith("node_modules/")) found.add(statSync(candidate).isDirectory() ? `${path}/` : path);
      }
    }
  }
  return found;
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
    : unresolved.length ? `unresolved import: ${unresolved[0]}`
    : manifestChanged ? "package.json changed outside dependency versions"
    : dbPackagesChanged ? "a database-suite dependency changed"
    : appFile ? `app input: ${appFile}` : "docs only";
  return { app: Boolean(appFile) || db, db, reason };
};

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const readAt = (sha, path) => {
  try { return JSON.parse(git("show", `${sha}:${path}`)); } catch { return {}; }
};

// Any detection error runs every suite rather than blocking or skipping.
export const run = (options) => {
  try { return detect(options); }
  catch (error) { return { app: true, db: true, reason: `detection error, running everything: ${error.message.split("\n")[0]}` }; }
};

const detect = ({ event, base, head }) => {
  if (event !== "pull_request") return decide({ event, files: [] });
  const files = git("diff", "--name-only", `${base}...${head}`).split("\n").filter(Boolean);
  const graph = importGraph();
  let manifestChanged = false;
  let dbPackagesChanged = false;
  if (files.some((file) => DEPENDENCY_FILES.has(file))) {
    manifestChanged = withoutDependencies(readAt(base, "package.json")) !== withoutDependencies(readAt(head, "package.json"));
    const [beforeLock, afterLock] = [readAt(base, "package-lock.json"), readAt(head, "package-lock.json")];
    const reachable = new Set([...dependencyClosure(beforeLock, graph.packages), ...dependencyClosure(afterLock, graph.packages)]);
    dbPackagesChanged = [...changedPackages(beforeLock, afterLock)].some((name) => reachable.has(name));
  }
  const docs = files.filter((file) => DOC_LIKE.some((rule) => rule.test(file)));
  const referencedDocs = docs.length
    ? referencedPaths(ROOT, ["src", "scripts", "tests"].flatMap((dir) => listSourceFiles(ROOT, dir)).map((file) => toRepoPath(ROOT, file)))
    : new Set();
  return decide({ event, files, dbFiles: graph.files, unresolved: graph.unresolved, manifestChanged, dbPackagesChanged, referencedDocs });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run({ event: process.env.EVENT_NAME, base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  console.log(`app=${result.app} db=${result.db} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `app=${result.app}\ndb=${result.db}\n`);
}
