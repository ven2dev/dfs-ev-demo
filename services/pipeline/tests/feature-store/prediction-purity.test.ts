import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as empirical from "@dfs-ev/domain/empirical";
import { buildPredictionResponse, computePredictionForecast, validateModelDescriptor } from "../../src/featureStore/predictionHelpers.ts";
import { predictionDeliveryFixture } from "./prediction-helpers-fixture.ts";

const require = createRequire(import.meta.url);
const helperUrl = new URL("../../src/featureStore/predictionHelpers.ts", import.meta.url);
const allowed = new Map([
  ["node:util", ["isDeepStrictEqual"]],
  ["@dfs-ev/domain/empirical", ["equalMassSupport", "probabilityAt"]],
]);
const forbiddenGlobals = new Set(["Date", "performance", "JSON", "fetch", "process", "globalThis", "eval", "Function",
  "require", "setTimeout", "setInterval", "queueMicrotask", "console", "Buffer", "WebSocket", "Worker"]);

// Inspect emitted JavaScript so erased local type imports cannot hide a runtime
// edge. The sole workspace dependency is inspected too, closing the I/O graph.
const pureRuntime = (source: string, imports: Map<string, string[]>): string[] => {
  const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = ts.createSourceFile("core.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const path = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "unknown";
      const bindings = node.importClause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map(e => (e.propertyName ?? e.name).text).sort() : [];
      if (!imports.has(path) || node.importClause?.name || !names.length
        || names.some(name => !imports.get(path)!.includes(name))) violations.push("runtime-import:" + path);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) violations.push("runtime-re-export");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push("dynamic-import");
    if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text)) violations.push("forbidden-global:" + node.text);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "Math" && node.name.text === "random")
      violations.push("random");
    ts.forEachChild(node, visit);
  };
  visit(file); return violations;
};

describe("#235 deterministic pure work budgets", () => {
  it("keeps the entire runtime dependency graph free of readers, I/O and policy/evaluator imports", () => {
    const source = readFileSync(helperUrl, "utf8");
    expect(pureRuntime(source, allowed)).toEqual([]);
    expect(pureRuntime(readFileSync(require.resolve("@dfs-ev/domain/empirical"), "utf8"), new Map())).toEqual([]);
  });
  it.each([
    'import { readFileSync } from "node:fs"; readFileSync("file");',
    'import { withModelArtifacts } from "./modelArtifacts.ts"; withModelArtifacts();',
    'import { fitBaseline } from "@dfs-ev/domain/baseline"; fitBaseline();',
    'import { inspect } from "node:util"; inspect({});',
    'import { equalMassSupport } from "@dfs-ev/domain/empirical"; await import("pg");',
    'export * from "./modelArtifacts.ts";',
    'require("node:fs");', 'new Date();', 'Date.now();', 'performance.now();',
    'JSON.stringify({});', 'fetch("https://invalid.example");', 'globalThis["fetch"]();',
    'process.stdout.write("private");', 'Math.random();', 'eval("work");', 'setTimeout(() => {}, 1);',
  ])("rejects hidden work in a negative-control source %s", source => {
    expect(pureRuntime(source, allowed).length).toBeGreaterThan(0);
  });
  it("has no public package export or private-subpath resolution escape", () => {
    for (const path of ["@dfs-ev/pipeline/feature-store/prediction-helpers", "@dfs-ev/pipeline/feature-store/predictionHelpers",
      "@dfs-ev/pipeline/src/featureStore/predictionHelpers.ts"])
      expect(() => require.resolve(path)).toThrow(expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }));
  });
  it("uses exactly one shared support construction and probability evaluation per forecast at every n", () => {
    const support = vi.spyOn(empirical, "equalMassSupport"), probability = vi.spyOn(empirical, "probabilityAt");
    try {
      for (let n = 2; n <= 16; n++) {
        support.mockClear(); probability.mockClear();
        const history = Array.from({ length: n }, (_, i) => ({ yards: i }));
        const result = computePredictionForecast({ history, sampleSize: n, line: 1 });
        expect(result.sampleCount).toBe(n); expect(support).toHaveBeenCalledTimes(1); expect(probability).toHaveBeenCalledTimes(1);
      }
    } finally { support.mockRestore(); probability.mockRestore(); }
  });
  it("performs no hashing, serialization, clock read or fetch across descriptor → math → response", () => {
    const input = predictionDeliveryFixture(), forbidden = () => { throw new Error("forbidden-pure-core-operation"); };
    const spies = [vi.spyOn(crypto, "createHash"), vi.spyOn(JSON, "stringify"), vi.spyOn(JSON, "parse"),
      vi.spyOn(Date, "now"), vi.spyOn(performance, "now"), vi.spyOn(globalThis, "fetch")];
    let result;
    try {
      for (const spy of spies) spy.mockImplementation(forbidden);
      const model = validateModelDescriptor(input);
      const forecast = computePredictionForecast({ history: input.history, sampleSize: input.context.feature.sampleSize, line: 200 });
      result = buildPredictionResponse({ request: input.request, model, forecast, context: input.finalContext,
        authorization: input.authorization, delivery: input.delivery });
    } finally { for (const spy of spies) spy.mockRestore(); }
    expect(result).toMatchObject({ status: "available", forecast: { sampleCount: 3, line: 200 } });
  });
});
