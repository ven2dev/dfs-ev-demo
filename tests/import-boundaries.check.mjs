import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";

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
    ["packages/domain/src/boundary-probe.ts", "../../db/tooling/tests/harness.ts"],
    ["apps/web/src/boundary-probe.ts", "../../../services/pipeline/src/featureStore/objectStore.ts"],
  ]) for (const code of forms(source)) await refuses(file, code, "import/no-relative-packages");
});

test("domain cannot import apps or services through relative paths, package names or the web alias", async () => {
  for (const source of ["../../../apps/web/src/lib/livePropCacheRepo.ts", "../../../services/pipeline/src/featureStore/objectStore.ts"])
    for (const code of forms(source)) await refuses("packages/domain/src/boundary-probe.ts", code, "import/no-restricted-paths");
  for (const source of ["@dfs-ev/web", "@dfs-ev/web/src/lib/livePropCacheRepo", "@dfs-ev/pipeline", "@dfs-ev/pipeline/src/featureStore/objectStore", "@/lib/livePropCacheRepo"])
    for (const code of forms(source)) await refuses("packages/domain/src/boundary-probe.ts", code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
});

test("TypeScript inline-import forms cannot bypass workspace checking", async () => {
  for (const source of ["../../../apps/web/src/lib/livePropCacheRepo.ts", "@dfs-ev/pipeline", "@/lib/livePropCacheRepo", "@dfs-ev/domain/src/contracts.ts"])
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

test("root lint runs the negative boundary probes in the CI lint step", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.lint, "eslint && npm run test:import-boundaries");
  assert.equal(pkg.scripts["test:import-boundaries"], "node --test tests/import-boundaries.check.mjs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Lint\n\s+run: npm run lint/);
});


test("database runtime and tooling cannot import consumers through any supported import form", async () => {
  for (const [file, sources] of [
    ["packages/db/src/boundary-probe.ts", ["../../../apps/web/src/lib/livePropCacheRepo.ts", "../../../services/pipeline/src/featureStore/objectStore.ts"]],
    ["packages/db/tooling/tests/boundary-probe.ts", ["../../../../apps/web/src/lib/livePropCacheRepo.ts", "../../../../services/pipeline/src/featureStore/objectStore.ts"]],
  ]) {
    for (const source of sources) for (const code of forms(source)) await refuses(file, code, "import/no-restricted-paths");
    for (const source of ["@dfs-ev/web", "@dfs-ev/web/src/lib/livePropCacheRepo", "@dfs-ev/pipeline", "@dfs-ev/pipeline/src/featureStore/objectStore", "@/lib/livePropCacheRepo"])
      for (const code of forms(source)) await refuses(file, code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
  }
});

test("runtime cannot import tooling but tooling can import runtime and public assets", async () => {
  for (const source of ["../tooling/tests/harness.ts", "../tooling/scripts/db-migrations/files.mjs"])
    for (const code of forms(source)) await refuses("packages/db/src/boundary-probe.ts", code, "import/no-restricted-paths");
  for (const source of ["@dfs-ev/db-tooling", "@dfs-ev/db-tooling/test-support/clients", "@dfs-ev/db-tooling/migrations/files"])
    for (const code of forms(source)) await refuses("packages/db/src/boundary-probe.ts", code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
  const runtime = JSON.parse(readFileSync(new URL("../packages/db/package.json", import.meta.url), "utf8"));
  for (const subpath of Object.keys(runtime.exports)) {
    const source = runtime.name + subpath.slice(1);
    for (const code of forms(source)) assert.deepEqual(await lint("packages/db/tooling/tests/boundary-probe.ts", code), [], code);
  }
});

test("web source and tests may import only the runtime database entry point", async () => {
  for (const file of ["apps/web/src/boundary-probe.ts", "apps/web/tests/db/boundary-probe.ts"]) {
    for (const source of ["@dfs-ev/db", "@dfs-ev/db/assets", "@dfs-ev/db/proposals/138_feature_store.sql", "@dfs-ev/db/src/readiness.ts", "@dfs-ev/db/runtime/../assets", "@dfs-ev/db/unknown", "@dfs-ev/db-tooling", "@dfs-ev/db-tooling/test-support/clients", "@dfs-ev/db-tooling/migrations/files"])
      for (const code of forms(source)) await refuses(file, code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
    for (const code of forms("@dfs-ev/db/runtime")) assert.deepEqual(await lint(file, code), [], code);
  }
  for (const [file, source] of [
    ["apps/web/src/boundary-probe.ts", "../../../packages/db/tooling/tests/harness.ts"],
    ["apps/web/tests/db/boundary-probe.ts", "../../../../packages/db/src/readiness.ts"],
    ["packages/db/tooling/tests/boundary-probe.ts", "../../src/readiness.ts"],
  ]) for (const code of forms(source)) await refuses(file, code, "import/no-relative-packages");
  for (const file of ["apps/web/src/boundary-probe.ts", "packages/db/src/boundary-probe.ts", "packages/db/tooling/tests/boundary-probe.ts"])
    for (const source of ["@dfs-ev/db-tooling/test-support/clients", "@dfs-ev/web", "../../../apps/web/src/lib/livePropCacheRepo.ts"])
      await refuses(file, `type Value = import("${source}").Value;`, "no-restricted-syntax");
});


test("pipeline source, scripts and tests cannot import web through any supported form", async () => {
  for (const file of ["services/pipeline/src/boundary-probe.ts", "services/pipeline/scripts/boundary-probe.ts", "services/pipeline/tests/boundary-probe.ts"]) {
    for (const source of ["@dfs-ev/web", "@dfs-ev/web/src/lib/livePropStore", "@/lib/livePropStore"])
      for (const code of forms(source)) await refuses(file, code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
    await refuses(file, 'import "../../../apps/web/src/lib/livePropCacheRepo.ts";', "import/no-relative-packages");
    await refuses(file, 'type Value = import("@dfs-ev/web").Value;', "no-restricted-syntax");
  }
});

test("pipeline runtime refuses tooling while consumer tests and disposable harness scripts use public test support", async () => {
  for (const source of ["@dfs-ev/db-tooling", "@dfs-ev/db-tooling/test-support/migrated", "@dfs-ev/db-tooling/test-support/scratch", "@dfs-ev/db-tooling/migrations/core"])
    for (const code of forms(source)) await refuses("services/pipeline/src/boundary-probe.ts", code, code.includes("require(") || code.includes("= import(") ? "no-restricted-syntax" : "no-restricted-imports");
  await refuses("services/pipeline/src/boundary-probe.ts", 'type Value = import("@dfs-ev/db-tooling/test-support/migrated").Value;', "no-restricted-syntax");
  await refuses("services/pipeline/src/boundary-probe.ts", 'import Value = require("@dfs-ev/db-tooling/test-support/migrated");', "no-restricted-syntax");
  for (const file of ["services/pipeline/tests/boundary-probe.ts", "services/pipeline/scripts/boundary-probe.ts"])
    for (const code of forms("@dfs-ev/db-tooling/test-support/migrated")) assert.deepEqual(await lint(file, code), [], code);
  for (const code of forms("@dfs-ev/db/runtime")) assert.deepEqual(await lint("services/pipeline/src/boundary-probe.ts", code), [], code);
  for (const source of ["@dfs-ev/db-tooling/test-support/../tests/harness.ts", "../../../packages/db/tooling/tests/harness.ts"])
    await refuses("services/pipeline/src/boundary-probe.ts", `import "${source}";`, source.startsWith(".") ? "import/no-relative-packages" : "no-restricted-imports");
});
