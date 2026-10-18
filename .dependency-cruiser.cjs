// Architecture boundary for CI gating (#140): code outside the UI layer must
// never depend on it. The CI selector (scripts/ci/affected.mjs) skips DB
// integration for PRs that change only the UI layer and docs; this rule keeps
// that premise true for every import form dependency-cruiser understands
// (static, dynamic import(), require(), re-exports and type-only imports,
// including the @/ path alias). Non-import file access is accepted residual
// risk; see docs/database-testing.md.
/** The UI layer. Keep in sync with UI_LAYER in scripts/ci/affected.mjs (a test enforces it). */
const UI_LAYER = "^(src/components/|src/store/|src/app/(?!api/)|public/)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-ui-from-non-ui",
      comment: "Server, library, script, test and tooling code must not depend on the UI layer.",
      severity: "error",
      from: { pathNot: UI_LAYER },
      to: { path: UI_LAYER },
    },
    {
      name: "no-unresolvable-outside-ui",
      comment: "An import the boundary check cannot resolve could hide a dependency on the UI layer.",
      severity: "error",
      from: { pathNot: UI_LAYER },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(node_modules|\\.next|out|build|coverage)/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"],
    },
  },
};
