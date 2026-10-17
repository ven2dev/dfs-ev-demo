// Decides which expensive CI suites a change needs. Deny-by-default: a suite
// is skipped only when every changed path is known not to affect it, or (for
// dependency files) when no changed package is reachable from that suite's
// code. Anything unrecognized runs everything.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Paths that cannot change application behavior or any test outcome.
const DOCS_ONLY = [/\.md$/, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Paths the database suite never imports or reads. Verified against the DB
// import graph; route handlers and UI are outside it. Lockfiles are handled
// separately by package reachability.
const DB_SAFE = [
  ...DOCS_ONLY,
  /^src\/components\//,
  /^src\/store\//,
  /^src\/app\/(?!api\/)/,
  /^public\//,
  /^\.env\.example$/,
  /^src\/.*\.test\.tsx?$/,
  /^firestore\.rules$/,
  /^tests\/firestoreRules[^/]*$/,
];

// Every file the database suite executes starts from these entry points.
export const DB_ENTRY_POINTS = [
  "tests/db", "scripts/test-db.mjs", "scripts/db-migrations",
  "scripts/db-catalog.mjs", "scripts/db-catalog-contracts.mjs", "scripts/compare-db-catalog.mjs",
  "scripts/db-migrate.mjs", "scripts/db-migrate-dev.mjs", "scripts/db-migration-artifacts.mjs",
  "scripts/db-readiness-manifest.mjs", "scripts/db-test-contract.mjs", "scripts/db-test-reporter.mjs",
  "vitest.db.config.mts",
];
const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const listFiles = (root, path) => {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return SOURCE.test(path) ? [full] : [];
  return readdirSync(full).flatMap((name) => listFiles(root, join(path, name)));
};

const resolveLocal = (root, from, specifier) => {
  const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(from), specifier);
  for (const suffix of ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"]) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const packageName = (specifier) => {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return PACKAGE.test(name) ? name : null;
};

// npm packages imported anywhere in the suite's transitive local import graph.
export const importedPackages = (root = ROOT, entryPoints = DB_ENTRY_POINTS) => {
  const queue = entryPoints.flatMap((path) => listFiles(root, path));
  const seen = new Set();
  const packages = new Set();
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(pattern)) {
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const local = resolveLocal(root, file, specifier);
        if (local) queue.push(local);
      } else {
        const name = packageName(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return packages;
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

export const decide = ({ event, files, manifestChanged, dbPackagesChanged }) => {
  if (event !== "pull_request" || files.length === 0) return { app: true, db: true, reason: "full run" };
  const docsOnly = files.every((file) => DOCS_ONLY.some((rule) => rule.test(file)));
  if (docsOnly) return { app: false, db: false, reason: "docs only" };
  const outsideDbSafe = files.filter((file) => !DEPENDENCY_FILES.has(file) && !DB_SAFE.some((rule) => rule.test(file)));
  const db = outsideDbSafe.length > 0 || manifestChanged || dbPackagesChanged;
  const reason = outsideDbSafe.length ? `db-relevant path: ${outsideDbSafe[0]}`
    : manifestChanged ? "package.json changed outside dependency versions"
    : dbPackagesChanged ? "a database-suite dependency changed" : "no database-relevant change";
  return { app: true, db, reason };
};

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const readAt = (sha, path) => {
  try { return JSON.parse(git("show", `${sha}:${path}`)); } catch { return {}; }
};

export const run = ({ event, base, head }) => {
  if (event !== "pull_request") return decide({ event, files: [] });
  const files = git("diff", "--name-only", `${base}...${head}`).split("\n").filter(Boolean);
  let manifestChanged = false;
  let dbPackagesChanged = false;
  if (files.some((file) => DEPENDENCY_FILES.has(file))) {
    manifestChanged = withoutDependencies(readAt(base, "package.json")) !== withoutDependencies(readAt(head, "package.json"));
    const [beforeLock, afterLock] = [readAt(base, "package-lock.json"), readAt(head, "package-lock.json")];
    const roots = importedPackages();
    const reachable = new Set([...dependencyClosure(beforeLock, roots), ...dependencyClosure(afterLock, roots)]);
    dbPackagesChanged = [...changedPackages(beforeLock, afterLock)].some((name) => reachable.has(name));
  }
  return decide({ event, files, manifestChanged, dbPackagesChanged });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run({ event: process.env.EVENT_NAME, base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  console.log(`app=${result.app} db=${result.db} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `app=${result.app}\ndb=${result.db}\n`);
}
