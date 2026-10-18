import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // CI gating (#140): outside the skip set (UI layer and docs), every module
  // load must use a literal specifier so the dependency-cruiser boundary in
  // .dependency-cruiser.cjs can follow it. Computed loads fail closed here.
  ...[
    { files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"], ignores: ["src/components/**", "src/store/**", "src/app/**", "public/**", "docs/**"] },
    { files: ["src/app/api/**/*.{js,ts,mjs,mts}"] },
  ].map((scope) => ({
    ...scope,
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "ImportExpression[source.type!='Literal']",
          message: "Use a literal import() specifier outside the UI layer so the CI boundary can follow it (#140)." },
        { selector: "CallExpression[callee.type='Identifier'][callee.name='require'][arguments.0.type!='Literal']",
          message: "Use a literal require() specifier outside the UI layer so the CI boundary can follow it (#140)." },
        { selector: "CallExpression[callee.object.name=/^(require|module|vi)$/][callee.property.name=/^(resolve|require|importActual|importMock|mock|doMock|unmock|doUnmock)$/][arguments.0.type!='Literal']",
          message: "Use a literal module specifier outside the UI layer so the CI boundary can follow it (#140)." },
        { selector: "Identifier[name='require']:not(CallExpression > Identifier.callee):not(MemberExpression > Identifier.object)",
          message: "Do not alias require outside the UI layer; the CI boundary cannot follow aliased loads (#140)." },
        { selector: "ImportSpecifier[imported.name='createRequire']",
          message: "createRequire loads are not followed by the CI boundary; use a literal import outside the UI layer (#140)." },
      ],
    },
  })),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
