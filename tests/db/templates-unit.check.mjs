import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { getTemplateReference, registerTemplateClone, validateTemplateManifest, createTemplateRun } from "./templates.mts";
import { LOCAL_TEST_DATABASE_URL, parseTestDatabaseUrl } from "./target.mts";

const base = parseTestDatabaseUrl(LOCAL_TEST_DATABASE_URL);
const digest = "a".repeat(64);
const manifest = () => ({ formatVersion: 1, runId: "abcdef123456", sourceDigest: digest,
  target: { host: base.host, port: base.port, database: base.database, user: base.user },
  templates: [1, 2].map((version) => ({ version, database: "dfs_ev_test_abcdef123456" + String(version).padStart(8, "0") })) });

test("template manifests bind the endpoint, immutable source digest and every unique ordered prefix", () => {
  const valid = validateTemplateManifest(manifest(), base, digest, 2);
  assert.ok(Object.isFrozen(valid));
  assert.ok(Object.isFrozen(valid.templates));
  assert.ok(Object.isFrozen(valid.templates[0]));
  const mutations = [
    (m) => { m.target.database = "production"; },
    (m) => { m.target.host = "example.invalid"; },
    (m) => { m.target.extra = true; },
    (m) => { m.sourceDigest = "b".repeat(64); },
    (m) => { m.runId = "not-a-run"; },
    (m) => { m.templates.pop(); },
    (m) => { m.templates[1].version = 1; },
    (m) => { m.templates[1].database = m.templates[0].database; },
    (m) => { m.templates[0].database = "dfs_ev_test"; },
    (m) => { m.templates[0].database = 'dfs_ev_test_abcdef12345600000001"; DROP DATABASE postgres'; },
    (m) => { m.templates[0].database = "dfs_ev_test_ffffffffffff00000001"; },
    (m) => { m.templates[0].extra = true; },
    (m) => { m.formatVersion = 2; },
    (m) => { m.extra = true; },
  ];
  for (const mutate of mutations) {
    const value = manifest(); mutate(value);
    assert.throws(() => validateTemplateManifest(value, base, digest, 2), /unsafe DB test template refused/);
  }
  for (const value of [null, [], "manifest", {}]) assert.throws(() => validateTemplateManifest(value, base, digest, 2));
});

test("template access refuses missing manifests, ambient credentials and unsafe endpoints before connection", async () => {
  await assert.rejects(getTemplateReference({ TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL }), /manifest required/);
  for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "PGHOST", "FIREBASE_ADMIN_PRIVATE_KEY"]) {
    const environment = { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL, [key]: "synthetic-private-value" };
    await assert.rejects(getTemplateReference(environment), /credentials/);
    await assert.rejects(createTemplateRun(environment, "/not-a-real-template-directory"), /credentials/);
  }
  await assert.rejects(createTemplateRun({ TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL.replace("127.0.0.1", "example.invalid") },
    "/not-a-real-template-directory"), /disposable loopback/);
});

test("fabricated template references cannot issue SQL even with plausible database names", async () => {
  const admin = { query: () => assert.fail("A forged reference issued SQL") };
  for (const value of [null, false, 0, "template", { database: "dfs_ev_test_abcdef12345600000001", version: 1 }]) {
    await assert.rejects(registerTemplateClone(admin, value), /refused/);
  }
});

test("an already-cancelled template build does not touch the filesystem or connect", async () => {
  await assert.rejects(createTemplateRun({ TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL },
    "/not-a-real-template-directory", AbortSignal.abort()), { name: "AbortError" });
});


test("template manifests refuse public files and symlinks, and builds preserve nonempty directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs-template-guard-"));
  const environment = { TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL };
  try {
    await mkdir(join(directory, "clones"), { mode: 0o700 });
    const publicFile = join(directory, "public.json");
    await writeFile(publicFile, "{}", { mode: 0o644 });
    await assert.rejects(getTemplateReference({ ...environment, TEST_DATABASE_TEMPLATE_MANIFEST: publicFile }), /refused/);
    const link = join(directory, "link.json");
    await symlink(publicFile, link);
    await assert.rejects(getTemplateReference({ ...environment, TEST_DATABASE_TEMPLATE_MANIFEST: link }), /ELOOP|refused/);
    await assert.rejects(createTemplateRun(environment, directory), /empty private directory/);
    assert.equal(await readFile(publicFile, "utf8"), "{}");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
