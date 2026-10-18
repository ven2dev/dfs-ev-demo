import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs");

// Runs the real boundary rules against a throwaway project.
const violations = async (files) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-boundary-"));
  try {
    const write = (path, text) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); };
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] }, allowJs: true } }));
    for (const [path, text] of Object.entries(files)) write(path, text);
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const result = await cruise(["."], { ...config.options, ruleSet: { forbidden: config.forbidden }, validate: true });
      return result.output.summary.violations.map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`).sort();
    } finally { process.chdir(previous); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const ui = { "src/store/state.ts": "export const state = 1;\nexport type State = number;\n",
  "src/components/Card.tsx": "export const Card = () => null;\n", "src/app/page.tsx": "export default 1;\n" };

test("every import form from non-UI code into the UI layer is a violation", async () => {
  const found = await violations({ ...ui,
    "src/lib/static.ts": 'import { state } from "../store/state";\nexport const a = state;\n',
    "src/lib/alias.ts": 'import { Card } from "@/components/Card";\nexport const b = Card;\n',
    "src/lib/typeOnly.ts": 'import type { State } from "@/store/state";\nexport type C = State;\n',
    "src/lib/reexport.ts": 'export { state } from "@/store/state";\n',
    "scripts/dynamic.mjs": 'export const load = () => import("../src/app/page.tsx");\n',
    "tests/db/required.cjs": 'module.exports = require("../../src/store/state.ts");\n',
    "src/app/api/route.ts": 'import { state } from "@/store/state";\nexport const GET = () => state;\n' });
  assert.deepEqual(found, [
    "no-ui-from-non-ui: scripts/dynamic.mjs -> src/app/page.tsx",
    "no-ui-from-non-ui: src/app/api/route.ts -> src/store/state.ts",
    "no-ui-from-non-ui: src/lib/alias.ts -> src/components/Card.tsx",
    "no-ui-from-non-ui: src/lib/reexport.ts -> src/store/state.ts",
    "no-ui-from-non-ui: src/lib/static.ts -> src/store/state.ts",
    "no-ui-from-non-ui: src/lib/typeOnly.ts -> src/store/state.ts",
    "no-ui-from-non-ui: tests/db/required.cjs -> src/store/state.ts",
  ]);
});

test("unresolvable imports outside the UI layer are violations", async () => {
  const found = await violations({ ...ui, "src/lib/alias.ts": 'import x from "#unknown-alias";\nexport const y = x;\n' });
  assert.deepEqual(found, ["no-unresolvable-outside-ui: src/lib/alias.ts -> #unknown-alias"]);
});

test("the UI layer may depend on library code", async () => {
  assert.deepEqual(await violations({ "src/lib/math.ts": "export const add = 1;\n",
    "src/components/Card.tsx": 'import { add } from "@/lib/math";\nexport const Card = () => add;\n' }), []);
});
