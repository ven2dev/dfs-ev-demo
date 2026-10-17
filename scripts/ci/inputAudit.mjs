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
//   (e.g. "#imports" or path aliases), non-literal module loads, parse errors,
//   and opaque executables (shell or other non-JS programs) whose own inputs
//   have not been declared.
// Entry points are derived from the commands the CI DB job actually runs.
// Threat model: accidental misclassification by contributors, not adversarial
// code; see docs/database-testing.md.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Programs whose own inputs the audit cannot see. Reaching one is an issue
// unless its inputs are declared.
const OPAQUE_EXECUTABLE = /(?:\.(?:sh|bash|zsh|py|rb|pl|ps1)|\/[^./]+)$/;
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
// URL-style literals are canonicalized: a query string or fragment is removed
// and percent-escapes are decoded, as Node does for file URLs.
export const canonicalLiteral = (literal) => {
  const path = literal.replace(/[?#].*$/s, "");
  try { return decodeURIComponent(path); } catch { return path; }
};

const globRegex = (pattern) => new RegExp(`^${pattern.split(/(\*\*\/?|\*)/).map((part) =>
  part === "**/" || part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("")}$`);

const literalTargets = (tree, file, raw) => {
  if (!raw || raw.length > 4096 || raw.includes("\n")) return [];
  const literal = canonicalLiteral(raw);
  if (/^[./]*$/.test(literal)) return [];
  const targets = [];
  for (const candidate of new Set([posix.normalize(posix.join(posix.dirname(file), literal)), posix.normalize(literal)])) {
    const path = candidate.replace(/\/$/, "");
    if (path.startsWith("..") || path.startsWith("/") || path.startsWith("node_modules")) continue;
    if (path.includes("*")) {
      // Only path globs anchored at an existing directory (e.g. "tests/db/**/*.test.ts");
      // comment markers such as "/*" and unrelated patterns are not file references.
      const prefix = path.slice(0, path.indexOf("*"));
      if (!prefix.includes("/") || !tree.dirs.has(prefix.slice(0, prefix.lastIndexOf("/")))) continue;
      const pattern = globRegex(path);
      for (const match of tree.files) if (pattern.test(match)) targets.push({ kind: "file", path: match });
    } else if (tree.files.has(path)) targets.push({ kind: "file", path });
    else if (tree.dirs.has(path)) targets.push({ kind: "dir", path: `${path}/` });
  }
  return targets;
};

// The suite's transitive inputs. `declared` holds the package names the root
// package.json declares; anything else that is neither local nor built-in is
// reported as an issue.
export const auditInputs = (tree, entryPoints, declared, executables = {}) => {
  const queue = entryPoints.flatMap((path) => tree.files.has(path) ? [path]
    : [...tree.files].filter((file) => file.startsWith(`${path}/`)));
  const files = new Set();
  const dirs = new Set();
  const dirRefs = new Map(); // dir -> Map("file\0literal" -> occurrence count)
  const packages = new Set();
  const issues = [];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!SOURCE.test(file)) {
      if (OPAQUE_EXECUTABLE.test(`/${file}`)) {
        if (executables[file]) queue.push(...executables[file]);
        else issues.push(`${file}: opaque executable; declare its inputs`);
      }
      continue; // data files are leaves
    }
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
        if (target.kind === "file") { queue.push(target.path); continue; }
        dirs.add(target.path);
        const refs = dirRefs.get(target.path) ?? new Map();
        const key = `${file}\0${literal}`;
        refs.set(key, (refs.get(key) ?? 0) + 1);
        dirRefs.set(target.path, refs);
      }
    }
  }
  return { files, dirs, dirRefs, packages, issues };
};

// Repository paths a shell command names (files, directories or globs).
const commandTargets = (tree, command) => command.split(/\s+|&&|\|\||;|\|/).filter(Boolean)
  .flatMap((token) => literalTargets(tree, "package.json", token.replace(/^["']|["']$/g, "")));

// The DB suite's entry points, derived from the `run:` commands of the CI
// workflow's DB job and the npm scripts they call (including pre/post hooks
// and nested `npm run`). Commands the audit cannot interpret are issues.
export const dbEntryPoints = (root = ROOT) => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const issues = [];
  const job = workflow.match(/^  db:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1] ?? "";
  // Both "run:" under a named step and the "- run:" shorthand. A block scalar
  // ("run: |") is reported as an uninterpreted command rather than skipped.
  const commands = [...job.matchAll(/^\s+(?:-\s+)?run:\s*(.+)$/gm)].map((match) => match[1].trim());
  if (!commands.length) issues.push("workflow DB job: no run commands found");
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const tree = fsTree(root);
  const entries = new Set();
  const seen = new Set();
  const expand = (command, origin) => {
    for (const part of command.split(/&&|\|\||;/).map((value) => value.trim()).filter(Boolean)) {
      const npmRun = part.match(/^npm run ([\w:.-]+)/);
      if (npmRun) {
        for (const name of [`pre${npmRun[1]}`, npmRun[1], `post${npmRun[1]}`]) {
          if (!scripts[name] || seen.has(name)) continue;
          seen.add(name);
          expand(scripts[name], `npm script ${name}`);
        }
        if (!scripts[npmRun[1]]) issues.push(`${origin}: unknown npm script ${npmRun[1]}`);
      } else if (/^npm ci\b/.test(part)) {
        continue; // installation: every package file already runs DB integration
      } else if (/^node\b/.test(part)) {
        const targets = commandTargets(tree, part);
        if (!targets.length) issues.push(`${origin}: command names no repository file: ${part}`);
        for (const target of targets) entries.add(target.kind === "dir" ? target.path.replace(/\/$/, "") : target.path);
      } else {
        issues.push(`${origin}: uninterpreted command: ${part}`);
      }
    }
  };
  for (const command of commands) expand(command, "workflow DB job");
  return { entries: [...entries].sort(), issues };
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
