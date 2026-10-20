import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";
import postcss from "../apps/web/postcss.config.mjs";
import { test } from "node:test";
import { webCommand } from "../scripts/web.mjs";

const root = new URL("../", import.meta.url);
const launcher = new URL("../scripts/web.mjs", import.meta.url).href;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("relocation preserves every frozen database artifact and the runtime readiness manifest", async () => {
  const baseline = JSON.parse(await readFile(new URL("docs/evidence/monorepo-148/baseline.json", root)));
  for (const [old, hash] of Object.entries(baseline.immutableFiles)) {
    const current = old.startsWith("db/") ? "packages/" + old : "apps/web/" + old;
    assert.equal(digest(await readFile(new URL(current, root))), hash, current);
  }
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  for (const name of baseline.rootCommands.names) assert.equal(typeof pkg.scripts[name], "string", name);
});

test("root web commands preserve argument boundaries and reject unsupported commands", () => {
  for (const mode of ["dev", "build", "start", "typegen"]) {
    const command = webCommand(mode, ["--port", "3123", "literal space"]);
    assert.ok(command[0].endsWith("next/dist/bin/next"));
    assert.deepEqual(command.slice(1), [mode, "--port", "3123", "literal space"]);
  }
  assert.throws(() => webCommand("deploy"));
});

test("local root dotenv compatibility preserves precedence while hosted and typegen skip loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs148-env-"));
  const key = "DFS148_SENTINEL_" + randomUUID().replaceAll("-", "");
  try {
    await writeFile(join(directory, ".env"), `${key}=generic
`);
    await writeFile(join(directory, ".env.local"), `${key}=local
`);
    await writeFile(join(directory, ".env.development.local"), `${key}=development
`);
    await writeFile(join(directory, ".env.production.local"), `${key}=production
`);
    const run = (mode, extra = {}) => {
      const script = `import { loadLocalWebEnvironment } from ${JSON.stringify(launcher)}; loadLocalWebEnvironment(process.argv[1], process.argv[2]); process.stdout.write(process.env[process.argv[3]] ?? "missing");`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, directory, mode, key], {
        env: { PATH: process.env.PATH, NODE_ENV: mode === "dev" ? "development" : "production", ...extra }, encoding: "utf8", timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(run("dev"), "development");
    assert.equal(run("build"), "production");
    assert.equal(run("start"), "production");
    assert.equal(run("dev", { [key]: "process" }), "process");
    assert.equal(run("dev", { VERCEL: "1" }), "missing");
    assert.equal(run("dev", { VERCEL_ENV: "preview" }), "missing");
    assert.equal(run("typegen"), "missing");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("root and workspace web entry points both resolve Next.js without reading local credentials", () => {
  for (const command of [["scripts/web.mjs", "dev", "--help"], ["node_modules/next/dist/bin/next", "build", "--help"]]) {
    const result = spawnSync(process.execPath, command.map((arg, index) => index === 0 ? fileURLToPath(new URL(arg, root)) : arg), {
      cwd: fileURLToPath(new URL(command[0].startsWith("scripts/") ? "." : "apps/web", root)),
      env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: next/);
  }
});

// Include the complete Next type-check project, including colocated tests and
// local imports outside apps/web. A root install can otherwise hide missing
// workspace declarations that fail in Vercel's workspace-only installation.
const packageName = specifier => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/") || isBuiltin(specifier)) return null;
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
};

const importedPackages = source => {
  const info = ts.preProcessFile(source, true, true);
  return new Set([
    ...info.importedFiles.map(reference => packageName(reference.fileName)),
  ].filter(Boolean));
};

const requiredWebPackages = async () => {
  const directory = fileURLToPath(root);
  const config = ts.readConfigFile(join(directory, "apps/web/tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(directory, "apps/web"));
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram([
    ...parsed.fileNames,
    join(directory, "apps/web/next.config.ts"),
    join(directory, "apps/web/postcss.config.mjs"),
  ], parsed.options);
  // Next's compiler and implicit Node/JSX types are not explicit source imports.
  const required = new Set(["next", "react", "react-dom", "typescript", "@types/node", "@types/react", "@types/react-dom"]);
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes("/node_modules/") || source.fileName.includes("/.next/")) continue;
    for (const name of importedPackages(source.text)) required.add(name);
    for (const reference of source.typeReferenceDirectives) {
      const resolved = ts.resolveTypeReferenceDirective(reference.fileName, source.fileName, parsed.options, ts.sys).resolvedTypeReferenceDirective;
      assert.ok(resolved, `Cannot resolve type reference ${reference.fileName}`);
      const dependency = resolved.resolvedFileName.split("/node_modules/").at(-1);
      if (dependency !== resolved.resolvedFileName) required.add(packageName(dependency));
    }
  }
  for (const plugin of parsed.options.plugins ?? []) required.add(packageName(plugin.name));
  // PostCSS plugins are package names in configuration, not import statements.
  for (const plugin of Object.keys(postcss.plugins)) required.add(packageName(plugin));
  for (const css of ts.sys.readDirectory(join(directory, "apps/web/src"), [".css"])) {
    const text = await readFile(css, "utf8");
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
      if (/^(?:https?:|data:)/.test(match[1])) continue;
      const name = packageName(match[1]);
      if (name) required.add(name);
    }
  }
  return required;
};

const assertWebDependencies = (web, repository, required) => {
  const declared = { ...web.dependencies, ...web.devDependencies };
  const rootDeclared = { ...repository.dependencies, ...repository.devDependencies };
  for (const name of required) assert.ok(declared[name], `apps/web/package.json is missing build dependency ${name}`);
  for (const [name, version] of Object.entries(declared)) {
    if (rootDeclared[name]) assert.equal(version, rootDeclared[name], `${name} differs between root and web`);
  }
  assert.equal(rootDeclared["@next/env"], declared.next, "root @next/env must match web Next.js to prevent internal version drift");
};

test("web declares every build import, PostCSS/CSS plugin and compiler dependency at matching root versions", async () => {
  const web = JSON.parse(await readFile(new URL("apps/web/package.json", root)));
  const repository = JSON.parse(await readFile(new URL("package.json", root)));
  const required = await requiredWebPackages();
  assertWebDependencies(web, repository, required);
  // Prove each missing declaration fails even when the root still declares it.
  for (const name of required) {
    const missing = structuredClone(web);
    delete missing.dependencies?.[name];
    delete missing.devDependencies?.[name];
    assert.throws(() => assertWebDependencies(missing, repository, required), { message: `apps/web/package.json is missing build dependency ${name}` });
  }
  const mismatched = structuredClone(web);
  mismatched.devDependencies["@tailwindcss/postcss"] = "0.0.0";
  assert.throws(() => assertWebDependencies(mismatched, repository, required), /differs between root and web/);
});

test("web dependency discovery covers scoped subpaths, re-exports, runtime and type imports while ignoring local aliases and builtins", () => {
  assert.deepEqual([...importedPackages(`
    import type { X } from "@scope/tool/subpath";
    export { x } from "exported/subpath";
    const a = require("commonjs");
    const b = import("dynamic/subpath");
    type T = import("typed").T;
    import "@/local";
    import "./relative";
    import "node:fs";
    import "fs";
  `)].sort(), ["@scope/tool", "commonjs", "dynamic", "exported", "typed"]);
});

const assertWorkspaceVersions = manifests => {
  const local = new Map(manifests.map(manifest => [manifest.name, manifest.version]));
  const domainVersion = local.get("@dfs-ev/domain");
  for (const name of ["@dfs-ev/web", "@dfs-ev/pipeline"]) {
    const consumer = manifests.find(manifest => manifest.name === name);
    assert.equal(consumer?.dependencies?.["@dfs-ev/domain"], domainVersion, `${name} must declare its domain dependency`);
  }
  const declared = new Map();
  for (const manifest of manifests) {
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (local.has(name)) assert.equal(version, local.get(name), `${manifest.name}: ${name} must match its workspace version`);
      if (declared.has(name)) assert.equal(version, declared.get(name), `${name} differs across workspace declarations`);
      declared.set(name, version);
    }
  }
};

test("shared versions and workspace dependency declarations stay identical, including Next internals and React", async () => {
  const manifests = await Promise.all(["package.json", "apps/web/package.json", "packages/domain/package.json", "services/pipeline/package.json"]
    .map(async path => JSON.parse(await readFile(new URL(path, root), "utf8"))));
  assertWorkspaceVersions(manifests);
  const [repository, web] = manifests;
  for (const name of ["next", "react", "react-dom", "@next/env"]) {
    const changed = structuredClone(repository);
    changed.dependencies[name] = "0.0.0";
    assert.throws(() => assertWebDependencies(web, changed, new Set()), name === "@next/env" ? /must match web Next.js/ : /differs between root and web/);
  }
  for (const index of [1, 3]) {
    const changed = structuredClone(manifests);
    delete changed[index].dependencies["@dfs-ev/domain"];
    assert.throws(() => assertWorkspaceVersions(changed), /must declare its domain dependency/);
  }
  for (const [index, name, group] of [[2, "typescript", "devDependencies"], [1, "@dfs-ev/domain", "dependencies"], [3, "@dfs-ev/domain", "dependencies"]]) {
    const changed = structuredClone(manifests);
    changed[index][group][name] = "0.0.0";
    assert.throws(() => assertWorkspaceVersions(changed), /differs across workspace declarations|must match its workspace version|must declare its domain dependency/);
  }
});

test("workspace scripts and test process exclude preserve-symlinks so native TypeScript resolves real package paths", async () => {
  for (const path of ["package.json", "apps/web/package.json", "packages/domain/package.json", "services/pipeline/package.json"]) {
    const manifest = JSON.parse(await readFile(new URL(path, root), "utf8"));
    assert.doesNotMatch(JSON.stringify(manifest.scripts ?? {}), /--preserve-symlinks/);
  }
  assert.doesNotMatch(process.execArgv.join(" ") + " " + (process.env.NODE_OPTIONS ?? ""), /--preserve-symlinks/);
});
