import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const runtimeReversePackage = String.raw`^(?:@dfs-ev\/(?:web|pipeline|db-tooling)(?:\/|$)|@\/)`;
const pipelineRuntimeForbidden = String.raw`^(?:@dfs-ev\/(?:web|db-tooling)(?:\/|$)|@\/)`;
const pipelineWebForbidden = String.raw`^(?:@dfs-ev\/web(?:\/|$)|@\/)`;
const nonRuntimeDatabase = String.raw`^@dfs-ev\/(?:db(?:$|\/(?!runtime$))|db-tooling(?:$|\/))`;

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
  {
    files: ["packages/db/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "import/no-restricted-paths": ["error", {
        basePath: fileURLToPath(new URL(".", import.meta.url)),
        zones: [{ target: "packages/db", from: ["apps", "services"], message: "Database infrastructure cannot depend on its consumers." }],
      }],
      "no-restricted-imports": ["error", { patterns: [{ regex: reversePackage, message: "Database infrastructure cannot depend on its consumers." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${reversePackage}/]`, message: "Database infrastructure cannot depend on its consumers." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${reversePackage}/]`, message: "Database infrastructure cannot depend on its consumers." },
      ],
    },
  },
  {
    files: ["packages/db/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "import/no-restricted-paths": ["error", {
        basePath: fileURLToPath(new URL(".", import.meta.url)),
        zones: [
          { target: "packages/db/src", from: ["apps", "services"], message: "Database runtime cannot depend on its consumers." },
          { target: "packages/db/src", from: "packages/db/tooling", message: "Database runtime cannot depend on tooling." },
        ],
      }],
      "no-restricted-imports": ["error", { patterns: [{ regex: runtimeReversePackage, message: "Database runtime cannot depend on tooling or consumers." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${runtimeReversePackage}/]`, message: "Database runtime cannot depend on tooling or consumers." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${runtimeReversePackage}/]`, message: "Database runtime cannot depend on tooling or consumers." },
      ],
    },
  },
  {
    files: ["services/pipeline/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: pipelineWebForbidden, message: "Pipeline cannot depend on the web app." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${pipelineWebForbidden}/]`, message: "Pipeline cannot depend on the web app." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${pipelineWebForbidden}/]`, message: "Pipeline cannot depend on the web app." },
      ],
    },
  },
  {
    files: ["services/pipeline/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      // Disposable scripts/tests can use the development harness; exported
      // runtime source cannot acquire that dependency through an import.
      "no-restricted-imports": ["error", { patterns: [{ regex: pipelineRuntimeForbidden, message: "Pipeline runtime cannot depend on web or DB tooling." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${pipelineRuntimeForbidden}/]`, message: "Pipeline runtime cannot depend on web or DB tooling." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${pipelineRuntimeForbidden}/]`, message: "Pipeline runtime cannot depend on web or DB tooling." },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      // Checking unresolved/private subpaths too keeps web's build independent
      // of tooling and test-harness dependencies, including in colocated tests.
      "no-restricted-imports": ["error", { patterns: [{ regex: nonRuntimeDatabase, message: "Web may import only @dfs-ev/db/runtime from the database packages." }] }],
      "no-restricted-syntax": ["error", ...typeSyntax,
        { selector: `ImportExpression[source.value=/${nonRuntimeDatabase}/]`, message: "Web may import only @dfs-ev/db/runtime from the database packages." },
        { selector: `CallExpression[callee.name='require'] > Literal[value=/${nonRuntimeDatabase}/]`, message: "Web may import only @dfs-ev/db/runtime from the database packages." },
      ],
    },
  },
];

export default boundaries;
