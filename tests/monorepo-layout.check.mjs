import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { webCommand } from "../scripts/web.mjs";

const root = new URL("../", import.meta.url);
const launcher = new URL("../scripts/web.mjs", import.meta.url).href;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("relocation preserves every frozen database artifact and the runtime readiness manifest", async () => {
  const baseline = JSON.parse(await readFile(new URL("docs/evidence/monorepo-148/baseline.json", root)));
  for (const [old, hash] of Object.entries(baseline.immutableFiles)) {
    const current = old.startsWith("db/") ? "packages/" + old : "apps/web/" + old;
    assert.equal(digest(await readFile(new URL(current, root))), hash, current);
  }
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  for (const name of baseline.rootCommands.names) assert.equal(typeof pkg.scripts[name], "string", name);
});

test("root web commands preserve argument boundaries and reject unsupported commands", () => {
  for (const mode of ["dev", "build", "start", "typegen"]) {
    const command = webCommand(mode, ["--port", "3123", "literal space"]);
    assert.ok(command[0].endsWith("next/dist/bin/next"));
    assert.deepEqual(command.slice(1), [mode, "--port", "3123", "literal space"]);
  }
  assert.throws(() => webCommand("deploy"));
});

test("local root dotenv compatibility preserves precedence while hosted and typegen skip loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dfs148-env-"));
  const key = "DFS148_SENTINEL_" + randomUUID().replaceAll("-", "");
  try {
    await writeFile(join(directory, ".env"), `${key}=generic
`);
    await writeFile(join(directory, ".env.local"), `${key}=local
`);
    await writeFile(join(directory, ".env.development.local"), `${key}=development
`);
    await writeFile(join(directory, ".env.production.local"), `${key}=production
`);
    const run = (mode, extra = {}) => {
      const script = `import { loadLocalWebEnvironment } from ${JSON.stringify(launcher)}; loadLocalWebEnvironment(process.argv[1], process.argv[2]); process.stdout.write(process.env[process.argv[3]] ?? "missing");`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, directory, mode, key], {
        env: { PATH: process.env.PATH, NODE_ENV: mode === "dev" ? "development" : "production", ...extra }, encoding: "utf8", timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(run("dev"), "development");
    assert.equal(run("build"), "production");
    assert.equal(run("start"), "production");
    assert.equal(run("dev", { [key]: "process" }), "process");
    assert.equal(run("dev", { VERCEL: "1" }), "missing");
    assert.equal(run("dev", { VERCEL_ENV: "preview" }), "missing");
    assert.equal(run("typegen"), "missing");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("root and workspace web entry points both resolve Next.js without reading local credentials", () => {
  for (const command of [["scripts/web.mjs", "dev", "--help"], ["node_modules/next/dist/bin/next", "build", "--help"]]) {
    const result = spawnSync(process.execPath, command.map((arg, index) => index === 0 ? fileURLToPath(new URL(arg, root)) : arg), {
      cwd: fileURLToPath(new URL(command[0].startsWith("scripts/") ? "." : "apps/web", root)),
      env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: next/);
  }
});
