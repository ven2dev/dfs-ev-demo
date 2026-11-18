import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const transport = "apps/web/src/lib/oddsApi.ts";
const primitive = "packages/db/src/providerCreditPermit.ts";
const sourceRoots = ["apps/web/src", "packages/db/src", "packages/domain/src", "services/pipeline/src", "services/pipeline/scripts"];
const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
  const next = join(path, entry.name);
  if (entry.isSymbolicLink()) throw new Error("Provider source guard refuses symlinks");
  return entry.isDirectory() ? walk(next) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|check)\./.test(entry.name) ? [next] : [];
});
export const providerSources = root => sourceRoots.flatMap(path => walk(join(root, path)))
  .map(path => ({ path: relative(root, path).replaceAll("\\", "/"), source: readFileSync(path, "utf8") }));
const constantString = node => {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left), right = constantString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
};
const enclosingFunction = node => {
  while (node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
    if (ts.isFunctionDeclaration(node)) return node;
    node = node.parent;
  }
};
/** Architecture guard for trusted source. It is not a malicious-code sandbox. */
export const checkProviderBoundary = sources => {
  const failures = [];
  let paidFetches = 0, freeFetches = 0;
  for (const { path, source } of sources) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const fail = message => failures.push(`${path}: ${message}`);
    const visit = node => {
      if (path !== transport) {
        if (ts.isIdentifier(node) && node.text === "ODDS_API_BASE") fail("ODDS_API_BASE escaped the provider boundary");
        const literal = constantString(node);
        if (literal?.includes("api.the-odds-api.com")) fail("provider URL escaped the provider boundary");
        if (ts.isIdentifier(node) && node.text === "consumeProviderCreditPermit" && ![primitive, "packages/db/src/runtime.ts"].includes(path)) {
          fail("paid permit consumption escaped the provider boundary");
        }
      }
      if (path === transport && ts.isIdentifier(node) && node.text === "fetch") {
        const parent = node.parent;
        const direct = ts.isCallExpression(parent) && parent.expression === node;
        const global = ts.isPropertyAccessExpression(parent) && ["globalThis", "global"].includes(parent.expression.getText(file)) &&
          ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        if (!direct && !global) fail("provider fetch alias bypasses the transport check");
      }
      if (path === transport && ts.isElementAccessExpression(node) && constantString(node.argumentExpression) === "fetch") {
        fail("computed provider fetch bypasses the transport check");
      }
      if (path === transport && ts.isExportSpecifier(node) && node.getText(file).includes("fetchReservedEventOdds")) {
        fail("private paid transport exported");
      }
      if (path === transport && ts.isCallExpression(node) &&
          (node.expression.getText(file) === "fetch" || /(?:globalThis|global)\s*\.\s*fetch$/.test(node.expression.getText(file)))) {
        const fn = enclosingFunction(node);
        const name = fn?.name?.getText(file);
        if (name === "fetchSlateEvents") freeFetches++;
        else if (name === "fetchReservedEventOdds" && ts.isVariableDeclaration(fn) && ts.isArrowFunction(fn.initializer)) {
          paidFetches++;
          const param = fn.initializer.parameters[0];
          if (param?.type?.getText(file) !== "ProviderCreditPermit") fail("paid transport lost its nominal permit parameter");
          const declaration = fn.parent?.parent;
          if (declaration?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) fail("private paid transport exported");
          let statement = node;
          while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
          const block = statement.parent;
          const previous = ts.isBlock(block) ? block.statements[block.statements.indexOf(statement) - 1] : undefined;
          if (previous?.getText(file) !== "consumeProviderCreditPermit(permit);") fail("paid fetch lacks immediate single-use consumption");
        } else fail("provider fetch outside free-events or permit-only paid transport");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (paidFetches !== 1 || freeFetches !== 1) failures.push("Expected exactly one paid fetch and one explicitly free events fetch");
  return [...new Set(failures)];
};
