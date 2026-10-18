// Architecture boundary for CI gating (#140). The CI selector
// (scripts/ci/affected.mjs) skips DB integration for PRs that change only the
// skip set: the UI layer and documentation. This config keeps that premise
// true: no code outside the skip set may import from it, through any import
// form dependency-cruiser follows (static, re-export, type-only, dynamic
// import() and require() with literal specifiers, the @/ alias, and the
// test-framework loaders listed in exoticRequireStrings). Imports it cannot
// resolve also fail. Non-literal import()/require() calls are refused by the
// ESLint rule in eslint.config.mjs. Non-import file access is accepted
// residual risk; see docs/database-testing.md.

/**
 * The skip set: the UI layer (src/components, src/store, src/app except
 * src/app/api, public) and documentation (top-level Markdown, docs/, issue
 * templates). Must equal SKIP_SET in scripts/ci/affected.mjs (a test enforces it).
 */
const SKIP_SET = "^(src/components/|src/store/|src/app/(?!api/)|public/|docs/|[^/]+[.]md$|[.]github/ISSUE_TEMPLATE/)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-skip-set-from-outside",
      comment: "Code outside the UI layer and docs must not depend on them, or a skip-set-only PR could skip tests it affects.",
      severity: "error",
      from: { pathNot: SKIP_SET },
      to: { path: SKIP_SET },
    },
    {
      name: "no-unresolvable-outside-skip-set",
      comment: "An import the boundary check cannot resolve (e.g. a tool-specific alias) could hide a dependency on the skip set.",
      severity: "error",
      from: { pathNot: SKIP_SET },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(node_modules|\\.next|out|build|coverage)/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    // Calls that load a module at runtime even though they are not import/require.
    exoticRequireStrings: ["module.require", "vi.importActual", "vi.importMock", "vi.mock", "vi.doMock", "vi.unmock", "vi.doUnmock"],
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json"],
    },
  },
};
