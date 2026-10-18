import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { cruise } from "dependency-cruiser";
import { ESLint } from "eslint";

const { default: config } = await import("../.dependency-cruiser.cjs");

// Runs the real boundary rules against a throwaway project.
const violations = async (files) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-boundary-"));
  try {
    const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] }, allowJs: true, resolveJsonModule: true } }));
    for (const [path, text] of Object.entries(files)) write(path, text);
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const result = await cruise(["."], { ...config.options, ruleSet: { forbidden: config.forbidden }, validate: true });
      return result.output.summary.violations.map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`).sort();
    } finally { process.chdir(previous); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const skipSet = { "src/store/state.ts": "export const state = 1;\nexport type State = number;\n",
  "src/components/Card.tsx": "export const Card = () => null;\n", "src/app/page.tsx": "export default 1;\n",
  "docs/data/example.json": "{}\n" };

test("every import form from outside the skip set into it is a violation", async () => {
  const found = await violations({ ...skipSet,
    "src/lib/static.ts": 'import { state } from "../store/state";\nexport const a = state;\n',
    "src/lib/alias.ts": 'import { Card } from "@/components/Card";\nexport const b = Card;\n',
    "src/lib/typeOnly.ts": 'import type { State } from "@/store/state";\nexport type C = State;\n',
    "src/lib/reexport.ts": 'export { state } from "@/store/state";\n',
    "src/lib/docData.ts": 'import data from "../../docs/data/example.json";\nexport const d = data;\n',
    "scripts/dynamic.mjs": 'export const load = () => import("../src/app/page.tsx");\n',
    "tests/db/required.cjs": 'module.exports = require("../../src/store/state.ts");\n',
    "tests/db/moduleRequire.cjs": 'module.exports = module.require("../../src/store/state.ts");\n',
    "tests/db/actual.test.ts": 'const m = await vi.importActual("../../src/store/state");\nexport const e = m;\n',
    "tests/db/mockModule.test.ts": 'const m = await vi.importMock("../../src/components/Card");\nexport const f = m;\n',
    "tests/db/mocked.test.ts": 'vi.mock("../../src/app/page");\nexport const g = 1;\n',
    "src/app/api/route.ts": 'import { state } from "@/store/state";\nexport const GET = () => state;\n' });
  const rule = "no-skip-set-from-outside";
  assert.deepEqual(found, [
    `${rule}: scripts/dynamic.mjs -> src/app/page.tsx`,
    `${rule}: src/app/api/route.ts -> src/store/state.ts`,
    `${rule}: src/lib/alias.ts -> src/components/Card.tsx`,
    `${rule}: src/lib/docData.ts -> docs/data/example.json`,
    `${rule}: src/lib/reexport.ts -> src/store/state.ts`,
    `${rule}: src/lib/static.ts -> src/store/state.ts`,
    `${rule}: src/lib/typeOnly.ts -> src/store/state.ts`,
    `${rule}: tests/db/actual.test.ts -> src/store/state.ts`,
    `${rule}: tests/db/mockModule.test.ts -> src/components/Card.tsx`,
    `${rule}: tests/db/mocked.test.ts -> src/app/page.tsx`,
    `${rule}: tests/db/moduleRequire.cjs -> src/store/state.ts`,
    `${rule}: tests/db/required.cjs -> src/store/state.ts`,
  ]);
});

test("unresolvable imports outside the skip set are violations, e.g. a tool-only alias", async () => {
  const found = await violations({ ...skipSet,
    "src/lib/alias.ts": 'import x from "#unknown-alias";\nexport const y = x;\n',
    "tests/db/vitestAlias.test.ts": 'import notes from "@docs/data/example.json";\nexport const z = notes;\n' });
  assert.deepEqual(found, [
    "no-unresolvable-outside-skip-set: src/lib/alias.ts -> #unknown-alias",
    "no-unresolvable-outside-skip-set: tests/db/vitestAlias.test.ts -> @docs/data/example.json",
  ]);
});

test("the skip set may depend on library code", async () => {
  assert.deepEqual(await violations({ "src/lib/math.ts": "export const add = 1;\n",
    "src/components/Card.tsx": 'import { add } from "@/lib/math";\nexport const Card = () => add;\n' }), []);
});

// Runs the repository's real ESLint config on virtual files.
const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "..") });
const refused = async (path, code) => {
  const [result] = await eslint.lintText(code, { filePath: path });
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax").length > 0;
};

test("non-literal module loads outside the skip set fail lint", async () => {
  for (const [path, code] of [
    ["src/lib/x.ts", "const target = 'a';\nexport const m = import(target);\n"],
    ["src/lib/x.ts", "export const m = import(`../store/${'state'}`);\n"],
    ["scripts/x.cjs", "const target = 'a';\nmodule.exports = require(target);\n"],
    ["scripts/x.cjs", "const load = require;\nmodule.exports = load('a');\n"],
    ["scripts/x.cjs", "const target = 'a';\nmodule.exports = module.require(target);\n"],
    ["scripts/x.mjs", "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\n"],
    ["tests/db/x.test.ts", "const target = 'a';\nexport const m = await vi.importActual(target);\n"],
    ["tests/db/x.test.ts", "const target = 'a';\nvi.mock(target);\n"],
    ["src/app/api/x/route.ts", "const target = 'a';\nexport const m = import(target);\n"],
  ]) assert.equal(await refused(path, code), true, `${path}: ${code}`);
});

test("literal module loads, and any load inside the skip set, pass lint", async () => {
  for (const [path, code] of [
    ["src/lib/x.ts", "export const m = import('./y');\n"],
    ["scripts/x.cjs", "module.exports = require('./y');\n"],
    ["tests/db/x.test.ts", "export const m = await vi.importActual('./y');\nvi.mock('./z');\n"],
    ["src/components/X.tsx", "const target = 'a';\nexport const m = import(target);\n"],
  ]) assert.equal(await refused(path, code), false, `${path}: ${code}`);
});
