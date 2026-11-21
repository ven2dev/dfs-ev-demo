import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const transport = "apps/web/src/lib/oddsApi.ts";
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
// Detect provider references in trusted source, including bare host constants.
// Parse the hostname so mentions in paths, queries or lookalike domains do not
// become false matches. This is a source-boundary rule, not URL sanitization.
const isProviderLocation = value => {
  if (value === undefined) return false;
  const providerHostname = "api.the-odds-api.com";
  for (const candidate of [value, value.startsWith("//") ? `https:${value}` : `https://${value}`]) {
    try {
      const hostname = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
      if (hostname === providerHostname) return true;
    } catch { /* Non-URL source literals are irrelevant to this rule. */ }
  }
  return false;
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
  let paidFetches = 0, freeFetches = 0, floorChecks = 0, floorFallbacks = 0;
  for (const { path, source } of sources) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const fail = message => failures.push(`${path}: ${message}`);
    const visit = node => {
      if (path !== transport) {
        if (ts.isIdentifier(node) && node.text === "ODDS_API_BASE") fail("ODDS_API_BASE escaped the provider boundary");
        const literal = constantString(node);
        if (isProviderLocation(literal)) fail("provider URL escaped the provider boundary");
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
      if (path === transport && ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) &&
          node.expression.expression.getText(file) === "checkPaidOddsAdmission") {
        if (enclosingFunction(node)?.name?.getText(file) === "fetchEventOdds") floorChecks++;
      }
      if (path === transport && ts.isCallExpression(node) &&
          (node.expression.getText(file) === "fetch" || /(?:globalThis|global)\s*\.\s*fetch$/.test(node.expression.getText(file)))) {
        const fn = enclosingFunction(node);
        const name = fn?.name?.getText(file);
        if (name === "fetchSlateEvents") freeFetches++;
        else if (name === "fetchEventOdds") paidFetches++;
        else fail("provider fetch outside the guarded entry point or free events");
      }
      if (path === "apps/web/src/lib/paidOddsBoundary.ts" && ts.isPropertyAssignment(node) &&
          node.name.getText(file) === "fallbackFloor" && ts.isArrowFunction(node.initializer) &&
          ts.isCallExpression(node.initializer.body) && node.initializer.body.expression.getText(file) === "checkInteractiveQuotaFloor") floorFallbacks++;
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (paidFetches !== 1 || freeFetches !== 1) failures.push("Expected exactly one paid fetch and one explicitly free events fetch");
  if (floorChecks !== 1) failures.push("Expected one awaited paid admission check in fetchEventOdds");
  if (floorFallbacks !== 1) failures.push("Expected one legacy quota floor fallback at the paid boundary");
  return [...new Set(failures)];
};
