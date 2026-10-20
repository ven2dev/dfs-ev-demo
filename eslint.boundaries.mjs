import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const boundaryExceptions = JSON.parse(readFileSync(new URL("./eslint.boundary-exceptions.json", import.meta.url), "utf8"));
const domain = JSON.parse(readFileSync(new URL("./packages/domain/package.json", import.meta.url), "utf8"));
const publicSubpaths = Object.keys(domain.exports).filter(key => key !== ".").map(key => key.slice(2));
const files = ["apps/*/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", "packages/*/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", "services/*/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

// eslint-plugin-import covers static, type-only, re-export, dynamic and require
// imports. Its visitor omits these two TypeScript forms: use static import type
// for local/workspace types so the resolved boundary checks cannot be bypassed.
const typeSyntax = [
  { selector: "TSImportEqualsDeclaration", message: "Use a static import so workspace boundaries can be checked." },
  { selector: String.raw`TSImportType Literal[value=/^(\.|@dfs-ev\/|@\/)/]`, message: "Use a static import type for local/workspace types so workspace boundaries can be checked." },
];
const reversePackage = String.raw`^(?:@dfs-ev\/(?:web|pipeline)(?:\/|$)|@\/)`;

const boundaries = [
  {
    files,
    rules: {
      "import/no-relative-packages": ["error", { commonjs: true }],
      // Reject private and unknown domain subpaths even if resolution fails.
      "import/no-internal-modules": ["error", { forbid: [
        `@dfs-ev/domain/!(${publicSubpaths.join("|")})`, "@dfs-ev/domain/*/**",
      ] }],
      "no-restricted-syntax": ["error", ...typeSyntax],
    },
  },
  ...boundaryExceptions.map(({ file, imports }) => ({
    files: [file],
    rules: {
      "import/no-relative-packages": ["error", {
        commonjs: true,
        ignore: Object.keys(imports).map(value => "^" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
      }],
    },
  })),
  {
    files: ["packages/domain/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      // Resolve aliases and package names as well as relative paths. No domain
      // exception exists: the shared package cannot depend on either consumer.
      "import/no-restricted-paths": ["error", {
        basePath: fileURLToPath(new URL(".", import.meta.url)),
        zones: [{ target: "packages/domain", from: ["apps", "services"], message: "Domain cannot depend on its app/service consumers." }],
      }],
      "no-restricted-imports": ["error", { patterns: [{ regex: reversePackage, message: "Domain cannot depend on its app/service consumers." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${reversePackage}/]`, message: "Domain cannot depend on its app/service consumers." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${reversePackage}/]`, message: "Domain cannot depend on its app/service consumers." },
      ],
    },
  },
];

export default boundaries;
