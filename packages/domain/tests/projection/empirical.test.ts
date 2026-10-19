import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { equalMassSupport, probabilityAt, priceSide, validateTriple } from "../../src/projection/empirical";
import { priceSide as legacyPriceSide, validateTriple as legacyValidateTriple } from "../../src/projection/baseline";

describe("pure empirical distribution kernel", () => {
  it("gives each observation equal mass and preserves signed values, zeros and ties", () => {
    const values = [2, -2, 0, 2];
    const support = equalMassSupport(values);
    expect(support).toEqual([{ value: -2, mass: .25 }, { value: 0, mass: .25 }, { value: 2, mass: .5 }]);
    expect(values).toEqual([2, -2, 0, 2]);
    expect(equalMassSupport([...values].reverse())).toEqual(support);
    expect(probabilityAt(support, 0)).toEqual({ underProbability: .25, pushProbability: .25, overProbability: .5 });
    expect(probabilityAt(support, .5)).toEqual({ underProbability: .5, pushProbability: 0, overProbability: .5 });
    expect(probabilityAt(support, -3)).toEqual({ underProbability: 0, pushProbability: 0, overProbability: 1 });
    expect(probabilityAt(support, 3)).toEqual({ underProbability: 1, pushProbability: 0, overProbability: 0 });
  });

  it("keeps the original floating-point operation order", () => {
    const support = equalMassSupport([0, 1, 2]);
    expect(support).toEqual([{ value: 0, mass: 1 / 3 }, { value: 1, mass: 1 / 3 }, { value: 2, mass: 1 / 3 }]);
    expect(probabilityAt(support, 1)).toEqual({ underProbability: 1 / 3, pushProbability: 1 / 3, overProbability: 1 - 1 / 3 - 1 / 3 });
  });

  it("does not impose the new adapter's 16-game cap on legacy histories", () => {
    const values = Array.from({ length: 37 }, (_, i) => i - 18);
    const support = equalMassSupport(values);
    expect(support).toHaveLength(37);
    for (let line = -20; line <= 20; line += .5) {
      const p = probabilityAt(support, line)!;
      expect(p.overProbability).toBeCloseTo(values.filter(value => value > line).length / 37, 14);
      expect(p.underProbability).toBeCloseTo(values.filter(value => value < line).length / 37, 14);
      expect(p.pushProbability).toBeCloseTo(values.filter(value => value === line).length / 37, 14);
    }
  });

  it("refunds equality and prices both sides without smoothing zero mass", () => {
    const allPush = probabilityAt(equalMassSupport([0, 0]), 0)!;
    for (const side of ["over", "under"] as const) {
      expect(priceSide(allPush, side, 2)).toEqual({ noPushConditionalProbability: null, fairDecimalPrice: null, expectedProfit: 0 });
    }
    const p = { overProbability: .5, underProbability: .25, pushProbability: .25 };
    expect(priceSide(p, "over", 2)).toEqual({ noPushConditionalProbability: 2 / 3, fairDecimalPrice: 1.5, expectedProfit: .25 });
    expect(priceSide(p, "under", 3)).toEqual({ noPushConditionalProbability: 1 / 3, fairDecimalPrice: 3, expectedProfit: 0 });
    expect(priceSide(p, "over").expectedProfit).toBeNull();
  });

  it("preserves refusal order and the legacy validation/pricing exports", () => {
    expect(probabilityAt(null, 0)).toBeNull();
    for (const line of [NaN, Infinity, -Infinity]) expect(() => probabilityAt(null, line)).toThrow("line must be finite");
    expect(() => probabilityAt([], 0)).toThrow("invalid probability triple");
    const invalid = { overProbability: 1, underProbability: 1, pushProbability: 0 };
    expect(() => priceSide(invalid, "over", 1)).toThrow("invalid probability triple");
    for (const price of [NaN, Infinity, -Infinity, 0, 1]) {
      expect(() => priceSide({ overProbability: 1, underProbability: 0, pushProbability: 0 }, "over", price)).toThrow("invalid decimal price");
    }
    expect(legacyPriceSide).toBe(priceSide);
    expect(legacyValidateTriple).toBe(validateTriple);
  });

  it("has no module dependencies, keeping domain math independent of server and adapter code", () => {
    const source = readFileSync(new URL("../../src/projection/empirical.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("empirical.ts", source, ts.ScriptTarget.Latest, true);
    const dependencies: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)
        || (ts.isExportDeclaration(node) && node.moduleSpecifier)
        || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
        dependencies.push(node.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(dependencies).toEqual([]);
  });
});
