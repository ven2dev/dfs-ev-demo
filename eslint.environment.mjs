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

export const environmentSyntax = (instrumentation = false) => [
  // Acquiring a process handle also bypasses ownership via aliases/destructuring.
  { selector: `Identifier[name='process']${instrumentation ? `:not(:matches(${frameworkProcess}))` : ""}`, message: environmentMessage },
  { selector: "MemberExpression[computed=true][property.value='process']", message: environmentMessage },
  { selector: "Identifier[name=/^(globalThis|global)$/]:not(MemberExpression > Identifier.object)", message: environmentMessage },
  { selector: "MemberExpression[object.name=/^(globalThis|global|window|self)$/][computed=true]:not([property.type='Literal'])", message: environmentMessage },
  { selector: "MemberExpression[object.type='MetaProperty'][property.name='env']", message: environmentMessage },
  { selector: "ImportExpression[source.value=/^(node:)?process$/]", message: environmentMessage },
  { selector: "CallExpression[callee.name='require'] > Literal[value=/^(node:)?process$/]", message: environmentMessage },
  { selector: `ImportExpression[source.value=/${exemptImport}/]`, message: "Production source cannot import exempt test or owner-script code." },
  { selector: `CallExpression[callee.name='require'] > Literal[value=/${exemptImport}/]`, message: "Production source cannot import exempt test or owner-script code." },
];

export const environmentImportPatterns = [
  { regex: "^(node:)?process$", message: environmentMessage },
  // Test/owner-tool exceptions cannot become an indirect production reader.
  { regex: "(?:^|/)(?:__tests__|tests|scripts)(?:/|$)|\\.(?:test|spec)(?:\\.|$)",
    message: "Production source cannot import exempt test or owner-script code." },
];
