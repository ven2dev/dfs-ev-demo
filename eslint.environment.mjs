import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Existing core rules own the syntax checks; no custom rule or data-flow scan.
export const environmentRuleIds = ["no-restricted-syntax", "no-restricted-imports"];
export const environmentReaders = [
  "apps/web/src/lib/config.server.ts", "apps/web/src/lib/config.client.ts",
];
export const environmentTestFiles = ["apps/web/src/**/*.test.*", "apps/web/src/**/*.spec.*"];
export const environmentMessage = "Read application inputs through serverConfig or publicConfig.";

// Only the documented literal in register() can be replaced by Next for Edge.
const runtimeComparison = "BlockStatement > IfStatement > BinaryExpression.test[operator='==='][right.value='nodejs'] > MemberExpression.left[computed=false][optional!=true][property.name='NEXT_RUNTIME'] > MemberExpression.object[computed=false][optional!=true][property.name='env'] > Identifier.object[name='process']";
const frameworkProcess = [
  `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='register'] > ArrowFunctionExpression > ${runtimeComparison}`,
  `ExportNamedDeclaration > FunctionDeclaration[id.name='register'] > ${runtimeComparison}`,
].join(", ");
const exemptImport = String.raw`(?:^|\/)(?:__tests__|tests|scripts)(?:\/|$)|\.(?:test|spec)(?:\.|$)`;

// Owner-approved #300 exception: preserve archived wrapper bytes for the paired
// experiment. Exact branch, syntax and source hashes keep it out of normal app
// configuration and prevent a new read being hidden by the exception.
export const harnessEnvironmentBranch = "feature/dfsEV-300-ps5-ha-stage1";
const proxyCondition = "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='proxy'] > ArrowFunctionExpression > BlockStatement.body > IfStatement > LogicalExpression.test[operator='&&']";
export const harnessEnvironmentExceptionsForBranch = branch => branch === harnessEnvironmentBranch ? [
  {
    file: "apps/web/src/app/api/qualification220/route.ts",
    sha256: "7620b4d9cee437c19125f434b6e6c9e69d12ff0719b371d04c839b75b586a41d",
    processSelectors: ["Program > VariableDeclaration > VariableDeclarator[id.name='handler'] > CallExpression.init[callee.name='createHandler'] > ObjectExpression.arguments > Property[key.name='env'][computed=false][kind='init'] > MemberExpression.value[computed=false][optional!=true][property.name='env'] > Identifier.object[name='process']"],
  },
  {
    file: "apps/web/src/proxy.ts",
    sha256: "9f276559573f147b4d3d66d58727f1d40894f195473c830a50320e4f7511cc85",
    processSelectors: [
      `${proxyCondition} > BinaryExpression.left[operator='==='][right.value='preview'] > MemberExpression.left[computed=false][optional!=true][property.name='VERCEL_ENV'] > MemberExpression.object[computed=false][optional!=true][property.name='env'] > Identifier.object[name='process']`,
      `${proxyCondition} > BinaryExpression.right[operator='==='][right.value='1'] > MemberExpression.left[computed=false][optional!=true][property.name='SPIKE220_ENABLED'] > MemberExpression.object[computed=false][optional!=true][property.name='env'] > Identifier.object[name='process']`,
    ],
  },
] : [];
const checkedOutBranch = () => {
  try {
    return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; } // Detached/unknown source gets no harness exception.
};
export const harnessEnvironmentExceptions = harnessEnvironmentExceptionsForBranch(checkedOutBranch());

export const environmentSyntax = (instrumentation = false, processSelectors = []) => {
  const allowed = [...(instrumentation ? [frameworkProcess] : []), ...processSelectors];
  return [
  // Acquiring a process handle also bypasses ownership via aliases/destructuring.
  { selector: `Identifier[name='process']${allowed.length ? `:not(:matches(${allowed.join(", ")}))` : ""}`, message: environmentMessage },
  { selector: "MemberExpression[computed=true][property.value='process']", message: environmentMessage },
  { selector: "Identifier[name=/^(globalThis|global)$/]:not(MemberExpression > Identifier.object)", message: environmentMessage },
  { selector: "MemberExpression[object.name=/^(globalThis|global|window|self)$/][computed=true]:not([property.type='Literal'])", message: environmentMessage },
  { selector: "MemberExpression[object.type='MetaProperty'][property.name='env']", message: environmentMessage },
  { selector: "ImportExpression[source.value=/^(node:)?process$/]", message: environmentMessage },
  { selector: "CallExpression[callee.name='require'] > Literal[value=/^(node:)?process$/]", message: environmentMessage },
  { selector: `ImportExpression[source.value=/${exemptImport}/]`, message: "Production source cannot import exempt test or owner-script code." },
  { selector: `CallExpression[callee.name='require'] > Literal[value=/${exemptImport}/]`, message: "Production source cannot import exempt test or owner-script code." },
  ];
};

export const environmentImportPatterns = [
  { regex: "^(node:)?process$", message: environmentMessage },
  // Test/owner-tool exceptions cannot become an indirect production reader.
  { regex: "(?:^|/)(?:__tests__|tests|scripts)(?:/|$)|\\.(?:test|spec)(?:\\.|$)",
    message: "Production source cannot import exempt test or owner-script code." },
];
