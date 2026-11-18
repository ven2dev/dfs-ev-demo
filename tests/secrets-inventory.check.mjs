import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkConfigurationAlignment, checkSecretsInventory, discoverTemplateWorkflowInputs, readInventorySources } from "../scripts/security/secrets-inventory.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(readFileSync(new URL("../docs/secrets-inventory.json", import.meta.url), "utf8"));
const files = readInventorySources(root);
const mutate = change => { const copy = structuredClone(catalog); change(copy); return copy; };

test("#98 repository inventory resolves policy, cited source names and runtime copy coverage", () => {
  const result = checkSecretsInventory(catalog, files);
  assert.equal(result.entries, catalog.entries.length);
  assert(result.templateWorkflowNames > 0 && result.references > 0);
  for (const [file, source] of files) if (file.endsWith(".env.example")) {
    for (const match of source.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/gm)) {
      const entry = catalog.entries.find(entry => entry.name === match[1]);
      const policy = { ...catalog.profiles[entry.profile], ...entry.overrides };
      // A failed check names the slot, never echoes a mistakenly filled value.
      if (policy.classification === "secret") assert.equal(Boolean(match[2].trim()), false, `secret template is not blank: ${match[1]}`);
    }
  }
});

test("removing the actual provider credential still fails independent template coverage", () => {
  assert.throws(() => checkSecretsInventory(mutate(c => {
    c.entries = c.entries.filter(entry => entry.name !== "ODDS_API_KEY");
    c.copyLedger.credentials = c.copyLedger.credentials.filter(row => row.credential !== "ODDS_API_KEY");
  }), files), /uncataloged supplied input: ODDS_API_KEY/);
});

test("missing inherited policy, reduced field contract and duplicate inputs refuse", () => {
  assert.throws(() => checkSecretsInventory(mutate(c => delete c.profiles["application-secret"].rotationAuthority), files), /missing rotationAuthority/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.requiredFields.pop()), files), /required inventory fields changed/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.entries.push(c.entries[0])), files), /duplicate input/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.formatVersion++), files), /unknown inventory format/);
});

test("a moved line stays valid, while wrong file, missing name and unsafe references refuse", () => {
  const entry = catalog.entries.find(entry => entry.name === "ODDS_API_KEY");
  const file = entry.consumers.find(file => file.endsWith("oddsApi.ts"));
  const moved = new Map(files).set(file, "\n\n" + files.get(file));
  checkSecretsInventory(catalog, moved);
  const renamed = new Map(files).set(file, files.get(file).replaceAll("ODDS_API_KEY", "ODDS_API_KEY_RENAMED"));
  assert.throws(() => checkSecretsInventory(catalog, renamed), /name absent from reference: ODDS_API_KEY/);
  for (const ref of [".github/dependabot.yml", file + ":164", "apps/web/.env.local", "../outside.ts", "/tmp/outside.ts"]) {
    const copy = mutate(c => c.entries.find(entry => entry.name === "ODDS_API_KEY").consumers = [ref]);
    assert.throws(() => checkSecretsInventory(copy, files), /invalid source reference|name absent from reference/);
  }
});

test("template/workflow extraction rejects uncataloged inputs without scanning executable code", () => {
  for (const [file, source] of [["apps/web/.env.example", "PROBE_NEW_INPUT=\n"],
    [".github/workflows/probe.yml", "env:\n  INPUT: ${{ secrets.PROBE_NEW_INPUT }}\n"]]) {
    assert.throws(() => checkSecretsInventory(catalog, new Map(files).set(file, (files.get(file) ?? "") + "\n" + source)), /uncataloged supplied input: PROBE_NEW_INPUT/);
  }
  const names = discoverTemplateWorkflowInputs(new Map([["probe.ts", 'process.env.NOT_EXTRACTED; // app definitions/lint own code coverage']]));
  assert.equal(names.names.size, 0);
});

test("copy ledger rejects duplicate authorities, wrong/missing aliases and credential reclassification", () => {
  assert.throws(() => checkSecretsInventory(mutate(c => c.copyLedger.credentials.push(c.copyLedger.credentials[0])), files), /duplicate credential authority/);
  assert.throws(() => checkSecretsInventory(mutate(c => {
    c.copyLedger.credentials.find(row => row.credential === "ODDS_HEALTH_SECRET").copies[1].names.push("CRON_SECRET");
  }), files), /alias belongs to another credential/);
  assert.throws(() => checkSecretsInventory(mutate(c => {
    c.copyLedger.credentials.find(row => row.credential === "ODDS_HEALTH_SECRET").copies[1].names = ["ODDS_HEALTH_SECRET"];
  }), files), /missing workflow alias: HEALTH_SECRET/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.profiles["application-secret"].classification = "ordinary configuration"), files), /runtime credential misclassified/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.profiles["firebase-public"].classification = "secret"), files), /public input marked secret/);
});

test("reviewed exclusions cannot silently admit a new name or hide a cataloged credential", () => {
  const source = new Map(files).set("probe/.env.example", "PROBE_UNREVIEWED_OUTPUT=\n");
  assert.throws(() => checkSecretsInventory(catalog, source), /uncataloged supplied input/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.discoveryExclusions.push({ names:["ODDS_API_KEY"], reason:"probe" })), files), /cataloged exclusion/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.discoveryExclusions[0].reason = ""), files), /exclusion reason required/);
});

// Synthetic policy/definitions exercise mutations without copying the app's
// input schema. The unconditional import probe checks the actual 20/7 maps.
const alignmentFixture = () => ({
  catalog: {
    profiles: { private: { classification: "secret" }, ordinary: { classification: "ordinary configuration" } },
    entries: [
      { name: "SYNTHETIC_SERVER_INPUT", profile: "private", reader: "server" },
      { name: "SYNTHETIC_CLIENT_INPUT", profile: "ordinary", reader: "client" },
      { name: "SYNTHETIC_OWNER_INPUT", profile: "private" },
    ],
  },
  definitions: {
    server: { SYNTHETIC_SERVER_INPUT: { classification: "secret" } },
    client: { SYNTHETIC_CLIENT_INPUT: { classification: "ordinary configuration" } },
  },
});

test("configuration names align exactly in both directions, with non-app rows separate", () => {
  const { catalog: c, definitions } = alignmentFixture();
  assert.deepEqual(checkConfigurationAlignment(c, definitions), { server: 1, client: 1 });
  for (const name of ["SYNTHETIC_SERVER_INPUT", "SYNTHETIC_CLIENT_INPUT"]) {
    const copy = structuredClone(c);
    copy.entries = copy.entries.filter(entry => entry.name !== name);
    assert.throws(() => checkConfigurationAlignment(copy, definitions), /input missing from catalog/);
  }
  const copy = structuredClone(c);
  copy.entries[0].name += "_RENAMED";
  assert.throws(() => checkConfigurationAlignment(copy, definitions), /input missing from catalog/);
  copy.entries = structuredClone(c.entries);
  copy.entries[2].reader = "server";
  assert.throws(() => checkConfigurationAlignment(copy, definitions), /app input has no definition/);
  const unread = structuredClone(definitions);
  delete unread.server.SYNTHETIC_SERVER_INPUT;
  assert.throws(() => checkConfigurationAlignment(c, unread), /app input has no definition/);
  copy.entries.push(copy.entries[0]);
  assert.throws(() => checkConfigurationAlignment(copy, definitions), /duplicate catalog input/);
});

test("missing, switched and unknown readers and duplicate executable owners refuse", () => {
  const { catalog: c, definitions } = alignmentFixture();
  for (const reader of [undefined, "client", "unknown"]) {
    const copy = structuredClone(c);
    copy.entries[0].reader = reader;
    assert.throws(() => checkConfigurationAlignment(copy, definitions), /configuration reader differs/);
  }
  const copy = structuredClone(c);
  copy.entries[2].reader = "unknown";
  assert.throws(() => checkConfigurationAlignment(copy, definitions), /invalid configuration reader/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.entries[0].reader = "unknown"), files), /invalid configuration reader/);
  const duplicated = structuredClone(definitions);
  duplicated.client.SYNTHETIC_SERVER_INPUT = duplicated.server.SYNTHETIC_SERVER_INPUT;
  assert.throws(() => checkConfigurationAlignment(c, duplicated), /multiple readers/);
  assert.throws(() => checkConfigurationAlignment(c, { server: definitions.server }), /both configuration readers/);
});

test("alignment resolves profile overrides and refuses a changed classification on either side", () => {
  const { catalog: c, definitions } = alignmentFixture();
  c.entries[0].profile = "ordinary";
  c.entries[0].overrides = { classification: "secret" };
  checkConfigurationAlignment(c, definitions);
  c.entries[0].overrides.classification = "ordinary configuration";
  assert.throws(() => checkConfigurationAlignment(c, definitions), /classification differs/);
  delete c.entries[0].overrides;
  c.profiles.ordinary.classification = "secret";
  assert.throws(() => checkConfigurationAlignment(c, definitions), /classification differs: SYNTHETIC_CLIENT_INPUT/);
  const copy = alignmentFixture();
  copy.definitions.server.SYNTHETIC_SERVER_INPUT.classification = "sensitive identifier";
  assert.throws(() => checkConfigurationAlignment(copy.catalog, copy.definitions), /classification differs/);
});

test("alignment does not evaluate parsers, capabilities or parsing contexts", () => {
  const { catalog: c, definitions } = alignmentFixture();
  for (const inputs of Object.values(definitions)) for (const definition of Object.values(inputs)) {
    for (const name of ["parse", "capabilities", "environments"])
      Object.defineProperty(definition, name, { get() { throw new Error("Code-owned metadata evaluated."); } });
  }
  checkConfigurationAlignment(c, definitions);
});

test("source reader excludes tracked private env files and refuses source symlinks before reading", () => {
  const directory = mkdtempSync(join(tmpdir(), "dfs98-inventory-"));
  try {
    mkdirSync(join(directory, "apps"));
    execFileSync("git", ["init", "--quiet", directory]);
    writeFileSync(join(directory, ".env.example"), "ROOT_TEMPLATE_INPUT=\n");
    writeFileSync(join(directory, "apps/.env.local"), "SYNTHETIC_PRIVATE_INPUT=do-not-read\n");
    writeFileSync(join(directory, "apps/.env.example"), "PUBLIC_TEMPLATE_INPUT=\n");
    execFileSync("git", ["add", "--force", ".env.example", "apps"], { cwd:directory });
    assert.deepEqual([...readInventorySources(directory).keys()], [".env.example", "apps/.env.example"]);
    symlinkSync(".env.local", join(directory, "apps/unsafe.ts"));
    execFileSync("git", ["add", "apps/unsafe.ts"], { cwd:directory });
    assert.throws(() => readInventorySources(directory), /not a regular file/);
    unlinkSync(join(directory, "apps/unsafe.ts"));
    renameSync(join(directory, "apps"), join(directory, "private-target"));
    symlinkSync("private-target", join(directory, "apps"));
    assert.throws(() => readInventorySources(directory), /traverses a symlink/);
  } finally { rmSync(directory, { recursive:true, force:true }); }
});
