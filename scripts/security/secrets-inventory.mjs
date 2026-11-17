import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const fields = ["classification", "environments", "owner", "consumers", "currentStorageClass",
  "intendedSourceOfTruth", "deliveryMethod", "rotationAuthority", "recoveryDependency",
  "ciPermission", "agentPermission"];
const codeFile = /\.[cm]?[jt]sx?$/;
const inputName = /^[A-Z_][A-Z0-9_]+$/;

// Read source only. In particular, no ignored/local environment file, symlink,
// evidence archive or process environment is an input to this checker.
export const inventorySourcePath = file => !file.split("/").some(part =>
  !part || part === "." || part === ".." || part === "node_modules" || part === ".git" ||
  part === "evidence" || part === "fixtures" || (part.startsWith(".env") && part !== ".env.example")) &&
  !file.includes(":") && !file.includes("\\") &&
  (codeFile.test(file) || /\.(?:md|ya?ml)$/.test(file) || file === ".env.example" || file.endsWith("/.env.example") || file === "turbo.json");

export function readInventorySources(root) {
  const files = new Map();
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  for (const file of tracked.filter(inventorySourcePath)) {
    const parts = file.split("/");
    for (let count = 1; count < parts.length; count++) {
      assert(!lstatSync(resolve(root, ...parts.slice(0, count))).isSymbolicLink(), `inventory source traverses a symlink: ${file}`);
    }
    const full = resolve(root, file);
    assert(lstatSync(full).isFile(), `inventory source is not a regular file: ${file}`);
    files.set(file, readFileSync(full, "utf8"));
  }
  return files;
}

// This is bounded discovery of names, not data flow or secret-value scanning.
// Known environment adapters are included; new adapter forms need review.
export function discoverInventoryInputs(files) {
  const names = new Map();
  const aliases = new Map();
  const add = (name, file) => {
    if (!inputName.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(file);
  };
  for (const [file, source] of files) {
    if (codeFile.test(file)) {
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const environment = node => /^(?:process\.env|env|environment|values|runtimeEnv|runtimeEnvironment)$/.test(node.getText(tree)) ||
        (ts.isPropertyAccessExpression(node) && node.name.text === "env");
      const visit = node => {
        if (ts.isPropertyAccessExpression(node) && environment(node.expression)) add(node.name.text, file);
        if (ts.isElementAccessExpression(node) && environment(node.expression) &&
            node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) add(node.argumentExpression.text, file);
        if (ts.isVariableDeclaration(node) && node.initializer && environment(node.initializer) && ts.isObjectBindingPattern(node.name)) {
          for (const binding of node.name.elements) add((binding.propertyName ?? binding.name).getText(tree).replace(/^['"]|['"]$/g, ""), file);
        }
        if (ts.isCallExpression(node) && node.expression.getText(tree) === "integerSetting" &&
            node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text, file);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    } else if (file.endsWith(".env.example")) {
      for (const match of source.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm)) add(match[1], file);
    } else if (file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file)) {
      for (const match of source.matchAll(/\$\{\{\s*(?:secrets|vars)\.([A-Z_][A-Z0-9_]*)\s*\}\}/g)) add(match[1], file);
      for (const match of source.matchAll(/^\s+([A-Z_][A-Z0-9_]*):\s*\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}/gm)) {
        add(match[1], file);
        aliases.set(`${file}:${match[1]}`, { name: match[1], credential: match[2] });
      }
    }
  }
  return { names, aliases: [...aliases.values()] };
}

export function checkSecretsInventory(catalog, files) {
  assert.equal(catalog.formatVersion, 1, "unknown inventory format");
  assert.match(catalog.sourceCommit, /^[a-f0-9]{40}$/, "source commit required");
  assert.deepEqual(catalog.requiredFields, fields, "required inventory fields changed");
  const entries = new Map();
  let references = 0;
  for (const entry of catalog.entries) {
    assert.equal(typeof entry.name, "string", "input name required");
    assert(!entries.has(entry.name), `duplicate input: ${entry.name}`);
    assert(entry.kind && catalog.profiles[entry.profile], `input kind/profile missing: ${entry.name}`);
    assert(!entry.overrides || Object.keys(entry.overrides).every(field => fields.includes(field) && field !== "consumers"),
      `unknown policy override: ${entry.name}`);
    const policy = { ...catalog.profiles[entry.profile], ...entry.overrides, consumers: entry.consumers };
    for (const field of fields) {
      const value = policy[field];
      assert(field === "environments" || field === "consumers" ?
        Array.isArray(value) && value.length && value.every(item => typeof item === "string" && item.trim()) :
        typeof value === "string" && value.trim(), `missing ${field}: ${entry.name}`);
    }
    assert(["secret", "sensitive identifier", "ordinary configuration"].includes(policy.classification), `invalid classification: ${entry.name}`);
    if (entry.name.startsWith("NEXT_PUBLIC_")) assert.equal(policy.classification, "ordinary configuration", `public input marked secret: ${entry.name}`);
    for (const file of entry.consumers) {
      assert(inventorySourcePath(file) && files.has(file), `invalid source reference: ${entry.name}`);
      const name = entry.name.replace(/\*$/, "");
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = inputName.test(name) ? new RegExp(`(?<![A-Za-z0-9_])${escaped}${entry.name.endsWith("*") ? "" : "(?![A-Za-z0-9_])"}`) : new RegExp(escaped);
      assert(pattern.test(files.get(file)), `name absent from reference: ${entry.name} in ${file}`);
      references++;
    }
    entries.set(entry.name, policy);
  }
  const { names, aliases } = discoverInventoryInputs(files);
  const excluded = new Set();
  for (const group of catalog.discoveryExclusions) {
    assert(group.reason?.trim() && group.names.length, "exclusion reason required");
    for (const name of group.names) {
      assert(!excluded.has(name) && !entries.has(name), `duplicate/cataloged exclusion: ${name}`);
      excluded.add(name);
    }
  }
  for (const name of names.keys()) assert(entries.has(name) || excluded.has(name), `uncataloged supplied input: ${name}`);
  const rows = catalog.copyLedger.credentials;
  const canonical = new Map(aliases.map(alias => [alias.name, alias.credential]));
  const expected = new Set(catalog.entries.filter(entry =>
    ["application-secret", "application-database", "operational-secret"].includes(entry.profile) &&
    !canonical.has(entry.name)).map(entry => entry.name));
  assert.equal(new Set(rows.map(row => row.credential)).size, rows.length, "duplicate credential authority");
  assert.deepEqual(new Set(rows.map(row => row.credential)), expected, "runtime ledger coverage differs");
  for (const row of rows) {
    assert(row.authority?.trim() && row.unresolved?.trim() && row.copies.length, `missing ledger policy: ${row.credential}`);
    assert.equal(entries.get(row.credential).classification, "secret", `runtime credential misclassified: ${row.credential}`);
    for (const copy of row.copies) {
      assert(copy.location?.trim() && copy.consumer?.trim() && copy.verification?.trim() && copy.names.length, `incomplete copy: ${row.credential}`);
      for (const name of copy.names) {
        assert(entries.has(name), `uncataloged alias: ${name}`);
        assert.equal(canonical.get(name) ?? name, row.credential, `alias belongs to another credential: ${name}`);
      }
    }
  }
  for (const alias of aliases) if (expected.has(alias.credential)) {
    assert(rows.find(row => row.credential === alias.credential).copies.some(copy => copy.names.includes(alias.name)),
      `missing workflow alias: ${alias.name}`);
  }
  return { entries: entries.size, profiles: Object.keys(catalog.profiles).length, references,
    discoveredNames: names.size, credentials: rows.length };
}
