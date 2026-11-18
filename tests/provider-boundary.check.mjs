import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkProviderBoundary, providerSources } from "../scripts/odds/provider-boundary-guard.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const sources = providerSources(root);
const mutateTransport = transform => sources.map(file => file.path === "apps/web/src/lib/oddsApi.ts" ? { ...file, source: transform(file.source) } : file);
test("all production sources preserve the provider boundary", () => assert.deepEqual(checkProviderBoundary(sources), []));
for (const [name, source] of [
  ["escaped base", 'const ODDS_API_BASE = "synthetic";'],
  ["provider fetch", 'fetch("https://api.the-odds-api.com/v4/sports/example");'],
  ["decoded escaped URL", 'const url = "https://api.the-odds-api\\u002ecom/v4"; const send = fetch; send(url);'],
  ["constant concatenation", 'fetch("https://api.the-" + "odds-api.com/v4");'],
]) test(`guard rejects ${name}`, () => assert.ok(checkProviderBoundary([...sources, { path: "apps/web/src/lib/bypass.ts", source }]).length));
test("guard refuses an extra provider fetch inside the transport module", () => {
  assert.ok(checkProviderBoundary(mutateTransport(source => source + '\nconst bypass = () => fetch("synthetic");')).length);
});
test("guard refuses removing or relocating the paid-leader floor check", () => {
  assert.ok(checkProviderBoundary(mutateTransport(source => source.replace("await checkInteractiveQuotaFloor();", ""))).length);
});
test("ordinary weather fetch and test fixtures remain permitted", () => {
  assert.deepEqual(checkProviderBoundary([...sources, { path: "apps/web/src/lib/weather-example.ts", source: 'fetch("https://weather.invalid");' }]), []);
});
test("the guard runs in the unconditional CI gate, before affected test selection", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.scripts["test:ci-gate"].includes("tests/provider-boundary.check.mjs"));
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.indexOf("run: npm run test:ci-gate") < workflow.indexOf("id: matrix"));
});

test("guard refuses aliased or computed fetch inside the provider module", () => {
  for (const bypass of ['const send = fetch; send("synthetic");', 'globalThis["fetch"]("synthetic");']) {
    assert.ok(checkProviderBoundary(mutateTransport(source => source + "\n" + bypass)).length);
  }
});

test("provider detection uses parsed canonical hostnames, including authority variants", () => {
  for (const value of [
    "https://API.THE-ODDS-API.COM/v4", "https://api.the-odds-api.com.:443/v4",
    "//api.the-odds-api.com/v4", "api.the-odds-api.com", "api.the-odds-api.com:443/v4",
    "https://other.invalid@api.the-odds-api.com/v4", "https://%61pi.the-odds-api.com/v4",
  ]) {
    const failures = checkProviderBoundary([...sources, { path: "apps/web/src/lib/bypass.ts", source: `fetch(${JSON.stringify(value)});` }]);
    assert.ok(failures.some(message => message.endsWith("provider URL escaped the provider boundary")), value);
  }
});
test("provider mentions outside the hostname and lookalike hosts do not match", () => {
  for (const value of [
    "https://api.the-odds-api.com.other.invalid/v4", "https://prefix-api.the-odds-api.com/v4",
    "https://other.invalid/api.the-odds-api.com", "https://other.invalid/?next=https://api.the-odds-api.com/v4",
    "https://api.the-odds-api.com@other.invalid/v4", "not a URL mentioning api.the-odds-api.com",
  ]) {
    assert.deepEqual(checkProviderBoundary([...sources, { path: "apps/web/src/lib/ordinary.ts", source: `const reference = ${JSON.stringify(value)};` }]), [], value);
  }
});
