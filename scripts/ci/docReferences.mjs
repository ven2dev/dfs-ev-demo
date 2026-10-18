// Finds docs named by string literals in source code, for the docs-only CI
// rule in scripts/ci/affected.mjs. Used only by tests/ciAffected.check.mjs.
// Sources are parsed with the TypeScript compiler; literals are canonicalized
// like file URLs (query/fragment removed, escapes decoded) and resolved
// against the referencing file and the repository root.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export const makeTree = (paths, read) => {
  const files = new Set(paths);
  const dirs = new Set();
  for (const path of files) for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);
  return { files, dirs, read };
};

export const fsTree = (root = ROOT) => {
  const walk = (dir) => readdirSync(join(root, dir)).flatMap((name) => {
    if (name === "node_modules" || name === ".git" || name === ".next") return [];
    const path = dir ? `${dir}/${name}` : name;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });
  return makeTree(walk(""), (path) => readFileSync(join(root, path), "utf8"));
};

const scriptKind = (path) => path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX
  : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;

export const stringLiterals = (path, text) => {
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path)));
  return literals;
};

const canonical = (literal) => {
  const path = literal.replace(/[?#].*$/s, "");
  try { return decodeURIComponent(path); } catch { return path; }
};

// Doc files and doc directories (as "dir/") a literal names.
const docTargets = (tree, file, raw) => {
  const literal = canonical(raw);
  if (!literal || literal.includes("\n") || /^[./]*$/.test(literal)) return [];
  const found = [];
  for (const candidate of new Set([posix.normalize(posix.join(posix.dirname(file), literal)), posix.normalize(literal)])) {
    const path = candidate.replace(/\/$/, "");
    if (path.startsWith("..") || path.startsWith("/")) continue;
    if (tree.files.has(path)) found.push(path);
    else if (tree.dirs.has(path)) found.push(`${path}/`);
  }
  return found;
};

export const listSourceFiles = (tree, dirs) =>
  [...tree.files].filter((file) => SOURCE.test(file) && dirs.some((dir) => file.startsWith(`${dir}/`)));

// Paths named by literals in the given source files. The CI selector's own
// files are skipped: their literals are rules, not reads, and changing them
// always runs every suite.
export const referencedPaths = (tree, sourceFiles) => {
  const found = new Set();
  for (const file of sourceFiles.filter((path) => !path.startsWith("scripts/ci/"))) {
    for (const literal of stringLiterals(file, tree.read(file) ?? "")) for (const path of docTargets(tree, file, literal)) found.add(path);
  }
  return found;
};
