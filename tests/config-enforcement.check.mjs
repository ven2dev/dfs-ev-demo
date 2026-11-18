import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";
import { environmentRuleIds } from "../eslint.environment.mjs";
import { checkEnvironmentDisables } from "../scripts/security/config-enforcement.mjs";
import { readInventorySources } from "../scripts/security/secrets-inventory.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const eslint = new ESLint({ cwd: root });
const lint = async (file, source) => {
  const [result] = await eslint.lintText(source, { filePath: resolve(root, file) });
  assert(result && !result.messages.some(message => message.fatal), JSON.stringify(result?.messages));
  assert(!result.messages.some(message => message.message.includes("ignored")), JSON.stringify(result.messages));
  return result.messages.filter(message => environmentRuleIds.includes(message.ruleId));
};
const refuses = async (file, source) => {
  const messages = await lint(file, source);
  assert(messages.length, `Environment bypass admitted in ${file}: ${source}`);
};

test("#287 actual flat config refuses raw, computed, optional, destructured and aliased process access", async () => {
  const cases = [
    "process.env.PROBE_INPUT;", "process.env['PROBE_INPUT'];", "process['env'].PROBE_INPUT;",
    "process['en' + 'v'][name];", "process?.env?.PROBE_INPUT;", "process.env[name];",
    "const { PROBE_INPUT } = process.env;", "const { env: values } = process; values.PROBE_INPUT;",
    "const p = process; p.env.PROBE_INPUT;", "const values = process.env; values.PROBE_INPUT;",
    "import p from 'node:process'; p.env.PROBE_INPUT;", "import { env as values } from 'process'; values.PROBE_INPUT;",
    "const p = await import('node:process'); p.env.PROBE_INPUT;", "const p = require('process'); p.env.PROBE_INPUT;",
    "globalThis.process.env.PROBE_INPUT;", "global.process.env.PROBE_INPUT;", "window['process'].env.PROBE_INPUT;",
    "globalThis?.['process']?.env.PROBE_INPUT;", "globalThis['pro' + 'cess'].env.PROBE_INPUT;",
    "const g = globalThis; g.process.env.PROBE_INPUT;", "const { process: p } = globalThis; p.env.PROBE_INPUT;",
    "window.process.env.PROBE_INPUT;", "window['pro' + 'cess'].env.PROBE_INPUT;",
    "const w = window; w.process.env.PROBE_INPUT;",
    "import.meta.env.PROBE_INPUT;",
  ];
  for (const source of cases) await refuses("apps/web/src/lib/environment-probe.ts", source);
});

test("ordinary slate-window variables, properties and browser detection are allowed", async () => {
  for (const source of [
    "const window = { start: 1 }; const payload = { window }; void payload;",
    "const choose = (window: number) => window; void choose;",
    "const data = { window: 1 }; const selected = data.window; void selected;",
    'if (typeof window === "undefined") {}',
  ]) assert.deepEqual(await lint("apps/web/src/lib/environment-probe.ts", source), [], source);
});

test("only exact readers and synthetic test/owner paths are exempt; a new runtime helper is restricted", async () => {
  for (const file of ["apps/web/src/lib/config.server.ts", "apps/web/src/lib/config.client.ts",
    "apps/web/src/lib/environment-probe.server.test.ts", "apps/web/src/lib/environment-probe.spec.ts", "scripts/environment-probe.mjs"])
    assert.deepEqual(await lint(file, "process.env.PROBE_INPUT;"), [], file);
  for (const file of ["apps/web/src/lib/config.helper.ts", "apps/web/src/lib/testing/environment-probe.ts",
    "apps/web/src/app/api/environment-probe/route.ts"])
    await refuses(file, "process.env.PROBE_INPUT;");
  for (const source of ["./environment-probe.server.test", "@/lib/environment-probe.test.ts", "../../../scripts/environment-probe.mjs"])
    for (const code of [`import { value } from '${source}';`, `const value = import('${source}');`, `const value = require('${source}');`])
      await refuses("apps/web/src/lib/environment-probe.ts", code);
});

test("the exact Next runtime comparison passes only in exported register; nearby reads and moved guards refuse", async () => {
  const file = "apps/web/src/instrumentation.ts";
  const original = readFileSync(resolve(root, file), "utf8");
  assert.deepEqual(await lint(file, original), []);
  assert.deepEqual(await lint(file, "export async function register() { if (process.env.NEXT_RUNTIME === 'nodejs') {} }"), []);
  for (const source of [
    original.replace('process.env.NEXT_RUNTIME === "nodejs"', 'process.env.NEXT_RUNTIME === "edge"'),
    original.replace('process.env.NEXT_RUNTIME', "process.env['NEXT_RUNTIME']"),
    original.replace('process.env.NEXT_RUNTIME', "process?.env.NEXT_RUNTIME"),
    original.replace('process.env.NEXT_RUNTIME', "process.env.PROBE_INPUT"),
    original.replace('register =', 'other ='),
    original + "\nprocess.env.PROBE_INPUT;\n",
    "export const register = async () => { const read = () => process.env.NEXT_RUNTIME; if (read() === 'nodejs') {} };",
  ]) await refuses(file, source);
  await refuses("apps/web/src/lib/environment-probe.ts", original);
});

test("environment restrictions retain the existing web database and TypeScript import boundaries", async () => {
  for (const file of ["apps/web/src/lib/environment-probe.ts", "apps/web/src/instrumentation.ts"])
    for (const source of ["@dfs-ev/db-tooling", "@dfs-ev/db/proposals/138_feature_store.sql"])
      for (const code of [`import { value } from '${source}';`, `const value = import('${source}');`, `const value = require('${source}');`, `type Value = import('${source}').Value;`])
        await refuses(file, code);
  assert.deepEqual(await lint("apps/web/src/lib/environment-probe.ts", "import { serverConfig } from './config.server'; serverConfig.database();"), []);
});

test("named disables of environment rules fail independently of lint suppression; unrelated comments still work", async () => {
  const file = "apps/web/src/lib/environment-probe.ts";
  for (const rule of environmentRuleIds) for (const directive of [
    `// eslint-disable-next-line ${rule} -- synthetic probe\nprocess.env.PROBE_INPUT;`,
    `process.env.PROBE_INPUT; // eslint-disable-line ${rule}`,
    `/* eslint-disable ${rule}, no-console -- synthetic probe */\nprocess.env.PROBE_INPUT;`,
    `/* eslint-disable\n * ${rule}\n */\nprocess.env.PROBE_INPUT;`,
    `/* eslint "${rule}": "off" */\nprocess.env.PROBE_INPUT;`,
    `/* eslint ${rule}: [0] */\nprocess.env.PROBE_INPUT;`,
  ]) await assert.rejects(checkEnvironmentDisables(new Map([[file, directive]]), eslint), /environment rule disable refused/);
  assert.equal((await checkEnvironmentDisables(new Map([[file,
    'const text = "// eslint-disable-next-line no-restricted-syntax";\n// A discussion of eslint-disable no-restricted-imports is not a directive.\nvoid text;',
  ]]), eslint)).checkedFiles, 1);
  const page = "apps/web/src/app/admin/creator-submissions/page.tsx";
  const original = readFileSync(resolve(root, page), "utf8");
  assert.equal((await checkEnvironmentDisables(new Map([[page, original]]), eslint)).checkedFiles, 1);
  const [result] = await eslint.lintText(original, { filePath: resolve(root, page) });
  assert(!result.messages.length, JSON.stringify(result.messages));
  assert(result.suppressedMessages.some(message => message.ruleId === "react-hooks/exhaustive-deps"));
  assert.notEqual((await eslint.calculateConfigForFile(page)).linterOptions.noInlineConfig, true);
});

test("the current production tree has no environment bypass or named rule disable", async () => {
  const result = await checkEnvironmentDisables(readInventorySources(root), eslint);
  assert(result.checkedFiles > 0);
  const messages = (await eslint.lintFiles(["apps/web/src"])).flatMap(result =>
    result.messages.filter(message => environmentRuleIds.includes(message.ruleId)));
  assert.deepEqual(messages, []);
});

test("the CI gate includes environment enforcement and real-definition alignment unconditionally", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert(pkg.scripts["test:ci-gate"].includes("tests/config-enforcement.check.mjs"));
  assert(pkg.scripts["test:ci-gate"].includes("tests/config-definition-import.check.mjs"));
  assert(pkg.scripts["test:ci-gate"].includes("tests/secrets-inventory.check.mjs"));
  const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /name: Verify aggregate CI gate\n\s+run: npm run test:ci-gate/);
});
