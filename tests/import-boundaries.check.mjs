import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";
import ts from "typescript";
import { boundaryExceptions } from "../eslint.boundaries.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const eslint = new ESLint({ cwd: root });
const boundaryRules = new Set(["import/no-relative-packages", "import/no-internal-modules", "import/no-restricted-paths", "no-restricted-imports", "no-restricted-syntax"]);
const lint = async (file, code) => {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, file) });
  assert.ok(result && !result.messages.some(message => message.fatal), JSON.stringify(result?.messages));
  assert.ok(!result.messages.some(message => message.message.includes("ignored")), JSON.stringify(result.messages));
  return result.messages.filter(message => boundaryRules.has(message.ruleId));
};
const refuses = async (file, code, rule) => {
  const messages = await lint(file, code);
  assert.ok(messages.some(message => message.ruleId === rule), `${file}: ${code}\n${JSON.stringify(messages)}`);
};
const forms = source => [
  `import { value } from "${source}";`,
  `import type { Value } from "${source}";`,
  `export { value } from "${source}";`,
  `export * from "${source}";`,
  `const value = import("${source}");`,
  `const value = require("${source}");`,
];

test("workspace relative imports fail in runtime, type-only, re-export, dynamic and require forms", async () => {
  for (const [file, source] of [
    ["apps/web/src/boundary-probe.ts", "../../../packages/domain/src/computeEV.ts"],
    ["apps/web/src/boundary-probe.jsx", "../../../packages/domain/src/computeEV.ts"],
    ["apps/web/src/app/api/boundary-probe.ts", "../../../../../packages/domain/src/projection/empirical.ts"],
    ["services/pipeline/src/boundary-probe.ts", "../../../packages/domain/src/devig.ts"],
    ["packages/domain/src/boundary-probe.ts", "../../db/tests/harness.ts"],
    ["apps/web/src/boundary-probe.ts", "../../../services/pipeline/src/featureStore/objectStore.ts"],
  ]) for (const code of forms(source)) await refuses(file, code, "import/no-relative-packages");
});

test("domain cannot import apps or services through relative paths, package names or the web alias", async () => {
  for (const source of ["../../../apps/web/src/lib/livePropCache.ts", "../../../services/pipeline/src/featureStore/objectStore.ts"])
    for (const code of forms(source)) await refuses("packages/domain/src/boundary-probe.ts", code, "import/no-restricted-paths");
  for (const source of ["@dfs-ev/web", "@dfs-ev/web/src/lib/livePropCache", "@dfs-ev/pipeline", "@dfs-ev/pipeline/src/featureStore/objectStore", "@/lib/livePropCache"])
    for (const code of forms(source)) await refuses("packages/domain/src/boundary-probe.ts", code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
});

test("TypeScript inline-import forms cannot bypass workspace checking", async () => {
  for (const source of ["../../../apps/web/src/lib/livePropCache.ts", "@dfs-ev/pipeline", "@/lib/livePropCache", "@dfs-ev/domain/src/contracts.ts"])
    await refuses("packages/domain/src/boundary-probe.ts", `type Value = import("${source}").Value;`, "no-restricted-syntax");
  await refuses("apps/web/src/boundary-probe.ts", 'import Value = require("../../../packages/domain/src/contracts.ts");', "no-restricted-syntax");
});

test("private and unknown domain package subpaths refuse, including dynamic imports and require", async () => {
  for (const source of ["@dfs-ev/domain/src/contracts.ts", "@dfs-ev/domain/src/projection/empirical.ts", "@dfs-ev/domain/unknown", "@dfs-ev/domain/ev/../src/computeEV.ts"])
    for (const code of forms(source)) await refuses("apps/web/src/boundary-probe.ts", code, "import/no-internal-modules");
});

test("public package exports, local imports and external inline types remain valid", async () => {
  const domain = JSON.parse(readFileSync(new URL("../packages/domain/package.json", import.meta.url), "utf8"));
  for (const subpath of Object.keys(domain.exports)) {
    const source = subpath === "." ? domain.name : domain.name + subpath.slice(1);
    for (const code of forms(source)) assert.deepEqual(await lint("apps/web/src/boundary-probe.ts", code), [], code);
  }
  for (const code of forms("./devig.ts")) assert.deepEqual(await lint("packages/domain/src/boundary-probe.ts", code), [], code);
  assert.deepEqual(await lint("services/pipeline/src/boundary-probe.ts", 'type Value = import("pg").QueryResultRow;'), []);
});

test("transition exceptions are exact existing file/import pairs, ticket-assigned and never apply to domain", async () => {
  const seen = new Set();
  for (const { file, imports } of boundaryExceptions) {
    assert.ok(!file.startsWith("packages/domain/"));
    assert.ok(!/[*?{}!]/.test(file));
    const text = readFileSync(resolve(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const used = new Set();
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) used.add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) used.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const [specifier, ticket] of Object.entries(imports)) {
      assert.ok([190, 191].includes(ticket));
      const key = file + ":" + specifier;
      assert.ok(!seen.has(key), key);
      seen.add(key);
      assert.ok(used.has(specifier), `Remove stale exception: ${key}`);
      const target = relative(root, resolve(root, dirname(file), specifier));
      assert.equal(ticket, file.startsWith("packages/db/") || target.startsWith("packages/db/") ? 190 : 191);
      assert.deepEqual(await lint(file, `import "${specifier}";`), [], key);
      const neighbor = file.replace(/[^/]+$/, "boundary-probe.ts");
      await refuses(neighbor, `import "${specifier}";`, "import/no-relative-packages");
    }
    // An allowlisted importing file still cannot reach any domain source file.
    const privateDomain = relative(resolve(root, dirname(file)), resolve(root, "packages/domain/src/contracts.ts"));
    await refuses(file, `import "${privateDomain}";`, "import/no-relative-packages");
  }
});

test("root lint runs the negative boundary probes in the CI lint step", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.lint, "eslint && npm run test:import-boundaries");
  assert.equal(pkg.scripts["test:import-boundaries"], "node --test tests/import-boundaries.check.mjs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Lint\n\s+run: npm run lint/);
});
