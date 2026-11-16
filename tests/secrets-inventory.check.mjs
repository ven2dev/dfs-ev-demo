import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkSecretsInventory, discoverInventoryInputs, readInventorySources } from "../scripts/security/secrets-inventory.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(readFileSync(new URL("../docs/secrets-inventory.json", import.meta.url), "utf8"));
const files = readInventorySources(root);
const mutate = change => { const copy = structuredClone(catalog); change(copy); return copy; };

test("#98 repository inventory resolves policy, cited source names and runtime copy coverage", () => {
  const result = checkSecretsInventory(catalog, files);
  assert.equal(result.entries, catalog.entries.length);
  assert(result.discoveredNames > 0 && result.references > 0);
  for (const [file, source] of files) if (file.endsWith(".env.example")) {
    for (const match of source.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/gm)) {
      const entry = catalog.entries.find(entry => entry.name === match[1]);
      const policy = { ...catalog.profiles[entry.profile], ...entry.overrides };
      // A failed check names the slot, never echoes a mistakenly filled value.
      if (policy.classification === "secret") assert.equal(Boolean(match[2].trim()), false, `secret template is not blank: ${match[1]}`);
    }
  }
});

test("removing the actual provider credential fails independent source discovery", () => {
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

test("discovery covers literal, bracket, destructured and known adapter inputs without reading string examples", () => {
  const cases = [
    'process.env.PROBE_NEW_INPUT;', 'process.env["PROBE_NEW_INPUT"];',
    'const { PROBE_NEW_INPUT: local } = process.env;', 'environment.PROBE_NEW_INPUT;',
    'deps.env.PROBE_NEW_INPUT;', 'values["PROBE_NEW_INPUT"];',
    'integerSetting("PROBE_NEW_INPUT", 1);',
  ];
  for (const source of cases) {
    const changed = new Map(files).set("apps/web/src/lib/config-probe.ts", source);
    assert.throws(() => checkSecretsInventory(catalog, changed), /uncataloged supplied input: PROBE_NEW_INPUT/);
  }
  for (const [file, source] of [["apps/web/.env.example", "PROBE_NEW_INPUT=\n"],
    [".github/workflows/probe.yml", "env:\n  INPUT: ${{ secrets.PROBE_NEW_INPUT }}\n"]]) {
    assert.throws(() => checkSecretsInventory(catalog, new Map(files).set(file, (files.get(file) ?? "") + "\n" + source)), /uncataloged supplied input: PROBE_NEW_INPUT/);
  }
  const names = discoverInventoryInputs(new Map([["probe.ts", '// process.env.NOT_A_REAL_INPUT\nconst example="process.env.NOT_A_REAL_INPUT";']]));
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
  const source = new Map(files).set("probe.ts", "process.env.PROBE_UNREVIEWED_OUTPUT;");
  assert.throws(() => checkSecretsInventory(catalog, source), /uncataloged supplied input/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.discoveryExclusions.push({ names:["ODDS_API_KEY"], reason:"probe" })), files), /cataloged exclusion/);
  assert.throws(() => checkSecretsInventory(mutate(c => c.discoveryExclusions[0].reason = ""), files), /exclusion reason required/);
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
