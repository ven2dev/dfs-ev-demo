// Static audit of a suite's inputs, used only by tests/ciAffected.check.mjs to
// verify the path rules in scripts/ci/affected.mjs. It never decides what CI
// runs; a gap here makes a test fail rather than skipping a suite.
//
// Sources are parsed with the TypeScript compiler. The audit reports:
// - files: every repository file the suite's code imports or names in a string
//   literal (transitively through JS/TS; other files such as shell scripts,
//   SQL and fixtures are recorded as leaves);
// - dirs: every repository directory named in a string literal, including bare
//   names such as "fixtures";
// - issues: anything the audit cannot classify: unresolved local imports,
//   specifiers that are neither local, a Node built-in nor a declared package
//   (e.g. "#imports" or path aliases), non-literal module loads and parse errors.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Code entry points of the DB integration suite.
export const DB_ENTRY_POINTS = [
  "tests/db", "scripts/test-db.mjs", "scripts/db-migrations",
  "scripts/db-catalog.mjs", "scripts/db-catalog-contracts.mjs", "scripts/compare-db-catalog.mjs",
  "scripts/db-migrate.mjs", "scripts/db-migrate-dev.mjs", "scripts/db-migration-artifacts.mjs",
  "scripts/db-readiness-manifest.mjs", "scripts/db-test-contract.mjs", "scripts/db-test-reporter.mjs",
  "vitest.db.config.mts", "compose.test.yml",
];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// A read-only view of the repository: `files` are repo-relative POSIX paths.
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
const literalText = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
const isRequireCallee = (node) => (ts.isIdentifier(node) && node.text === "require")
  || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
    && node.name.text === "resolve");
const isMetaResolve = (node) => ts.isPropertyAccessExpression(node) && node.name.text === "resolve"
  && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

// Module specifiers, string literals and whether any load is non-literal or the
// file failed to parse.
export const analyseSource = (path, text) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const specifiers = [];
  const literals = [];
  // parseDiagnostics is the parser's own syntax-error list; any error is an issue.
  let dynamic = (source.parseDiagnostics?.length ?? 0) > 0;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier === null) dynamic = true; else specifiers.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier === null) dynamic = true; else specifiers.push(specifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalText(node.argument.literal);
      if (specifier !== null) specifiers.push(specifier);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || isRequireCallee(node.expression) || isMetaResolve(node.expression))) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === null) dynamic = true; else specifiers.push(specifier);
    } else if (ts.isIdentifier(node) && node.text === "createRequire") {
      dynamic = true;
    } else if (ts.isIdentifier(node) && node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && isRequireCallee(node.parent)
        && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)) {
      dynamic = true; // `require` passed around or aliased
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, literals, dynamic };
};

export const hasDynamicLoad = (text, path = "probe.ts") => analyseSource(path, text).dynamic;

const resolveLocal = (tree, from, specifier) => {
  const base = specifier.startsWith("@/") ? posix.join("src", specifier.slice(2)) : posix.join(posix.dirname(from), specifier);
  const candidates = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"].map((suffix) => posix.normalize(base + suffix));
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((candidate) => tree.files.has(candidate)) ?? null;
};

const packageName = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

// Repository files and directories a string literal can name, resolved against
// the referencing file's directory and the repository root.
const literalTargets = (tree, file, literal) => {
  if (!literal || literal.length > 4096 || /^[./]*$/.test(literal) || literal.includes("\n")) return [];
  const targets = [];
  for (const candidate of new Set([posix.normalize(posix.join(posix.dirname(file), literal)), posix.normalize(literal)])) {
    const path = candidate.replace(/\/$/, "");
    if (path.startsWith("..") || path.startsWith("/") || path.startsWith("node_modules")) continue;
    if (tree.files.has(path)) targets.push({ kind: "file", path });
    else if (tree.dirs.has(path)) targets.push({ kind: "dir", path: `${path}/` });
  }
  return targets;
};

// The suite's transitive inputs. `declared` holds the package names the root
// package.json declares; anything else that is neither local nor built-in is
// reported as an issue.
export const auditInputs = (tree, entryPoints, declared) => {
  const queue = entryPoints.flatMap((path) => tree.files.has(path) ? [path]
    : [...tree.files].filter((file) => file.startsWith(`${path}/`)));
  const files = new Set();
  const dirs = new Set();
  const packages = new Set();
  const issues = [];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!SOURCE.test(file)) continue; // non-JS inputs are leaves
    const { specifiers, literals, dynamic } = analyseSource(file, tree.read(file) ?? "");
    if (dynamic) issues.push(`${file}: non-literal module load or unparsable source`);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const local = resolveLocal(tree, file, specifier);
        if (local) queue.push(local); else issues.push(`${file}: unresolved local import ${specifier}`);
      } else if (specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0])) {
        continue; // Node built-in
      } else if (declared.has(packageName(specifier))) {
        packages.add(packageName(specifier));
      } else {
        issues.push(`${file}: unclassified specifier ${specifier}`);
      }
    }
    for (const literal of literals) {
      for (const target of literalTargets(tree, file, literal)) {
        if (target.kind === "file") queue.push(target.path); else dirs.add(target.path);
      }
    }
  }
  return { files, dirs, packages, issues };
};

export const declaredPackages = (root = ROOT) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return new Set([manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .flatMap((group) => Object.keys(group ?? {})));
};

export const listSourceFiles = (tree, dirs) =>
  [...tree.files].filter((file) => SOURCE.test(file) && dirs.some((dir) => file.startsWith(`${dir}/`)));

// Docs and docs directories named by string literals in the given source files.
// The CI selector and this audit are skipped: their literals are rules, not
// reads, and changing them always runs every suite.
export const referencedDocs = (tree, sourceFiles) => {
  const found = new Set();
  for (const file of sourceFiles.filter((path) => !path.startsWith("scripts/ci/"))) {
    for (const literal of analyseSource(file, tree.read(file) ?? "").literals) {
      for (const target of literalTargets(tree, file, literal)) {
        if (/\.md$/.test(target.path) || target.path.startsWith("docs/")) found.add(target.path);
      }
    }
  }
  return found;
};
