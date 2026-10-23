import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspaceFiles = ["apps/web/package.json", "packages/domain/package.json", "packages/db/package.json", "packages/db/tooling/package.json", "services/pipeline/package.json"];
const names = workspaceFiles.map(file => JSON.parse(readFileSync(join(root, file))).name);
const tasks = ["test", "test:db:local", "test:feature-store:db"];
const unit = name => `${name}#test`;
const all = [...names.map(unit), "@dfs-ev/db-tooling#test:db:local", "@dfs-ev/pipeline#test:db:local", "@dfs-ev/pipeline#test:feature-store:db"].sort();
const domain = ["@dfs-ev/domain", "@dfs-ev/web", "@dfs-ev/pipeline"].map(unit).concat("@dfs-ev/pipeline#test:db:local", "@dfs-ev/pipeline#test:feature-store:db").sort();
const pipeline = ["@dfs-ev/pipeline#test", "@dfs-ev/pipeline#test:db:local", "@dfs-ev/pipeline#test:feature-store:db"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("Node 24 reproduces affected selection, conservative fallback and execution failures", { timeout: 120_000 }, async t => {
  assert.equal(process.versions.node.split(".")[0], "24", "selection proof is gated on the project's Node 24 runtime");
  const directory = mkdtempSync(join(tmpdir(), "dfs192-matrix-"));
  const run = (command, args, cwd = directory, extraEnv = {}) => spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_CACHE_DIR: join(directory, ".turbo/cache"), TURBO_ALLOW_EMPTY: "", TURBO_FORCE_FULL: "0", TURBO_PLAN_ONLY: "", TURBO_PLAN_FILE: "", ...extraEnv },
  });
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path, contents) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  };
  const commit = message => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const runner = (base, head, selectedTasks = tasks, extraEnv = {}, cwd = directory) => run(process.execPath,
    ["scripts/turbo/run-affected.mjs", ...selectedTasks], cwd,
    { TURBO_BASE_SHA: base, TURBO_HEAD_SHA: head, ...extraEnv });
  const selection = result => {
    const line = result.stdout.split("\n").find(line => line.startsWith("TURBO_SELECTION "));
    assert.ok(line, result.stdout + result.stderr);
    return JSON.parse(line.slice("TURBO_SELECTION ".length));
  };
  const receipt = { node: process.version, turbo: JSON.parse(readFileSync(join(root, "node_modules/turbo/package.json"))).version,
    boundary: "Disposable Git repository using the actual workspace manifests, lockfile, Turbo configuration and runner; task bodies replaced with execution markers. Real workspace tests are verified separately.",
    cache: "All configured tasks uncached; remote caching disabled; no database or mutation is performed by these marker probes.", probes: [], guards: [] };
  try {
    for (const file of ["package.json", "package-lock.json", "turbo.json", "scripts/turbo/run-affected.mjs", "scripts/turbo/ci-db-selection.mjs", ...workspaceFiles]) {
      write(file, readFileSync(join(root, file)));
    }
    for (const file of workspaceFiles) {
      const manifest = JSON.parse(readFileSync(join(directory, file)));
      // The real dependency declarations remain intact. Stubs isolate selection
      // and execution/exit semantics from slow jobs and external services.
      for (const task of Object.keys(manifest.scripts ?? {}))
        manifest.scripts[task] = `node ${relative(dirname(file), "probe.mjs")} ${manifest.name}#${task}`;
      write(file, JSON.stringify(manifest, null, 2) + "\n");
    }
    write("probe.mjs", 'console.log("EXEC:" + process.argv[2]);\n');
    write(".gitignore", "**/node_modules/\n**/.turbo/\n");
    mkdirSync(join(directory, "node_modules"));
    symlinkSync(join(root, "node_modules/turbo"), join(directory, "node_modules/turbo"), "dir");
    git("init", "-q");
    git("config", "user.name", "Disposable selection probe");
    git("config", "user.email", "probe@invalid.local");
    const base = commit("chore(spike): declare disposable task graph");
    receipt.base = base;
    const probes = [
      ["ui", "apps/web/src/probe.ts", "// UI probe\n", ["@dfs-ev/web#test"], "affected"],
      ["domain", "packages/domain/src/probe.ts", "// domain probe\n", domain, "affected"],
      ["db-proposal", "packages/db/proposals/probe.sql", "-- SQL probe\n", all, "full"],
      ["pipeline", "services/pipeline/src/probe.ts", "// pipeline probe\n", pipeline, "affected"],
      ["runbook", "docs/probe.md", "runbook probe\n", all, "full"],
      ["root-config", "tsconfig.json", "{}\n", all, "full"],
      ["toolchain", ".nvmrc", "24\n", all, "full"],
      ["workflow", ".github/workflows/probe.yml", "name: probe\n", all, "full"],
      ["unknown", "unclassified/probe.txt", "unclassified probe\n", all, "full"],
    ];
    for (const [name, path, contents, expected, mode] of probes) await t.test(name, () => {
      git("checkout", "-q", "--detach", base);
      write(path, contents);
      const head = commit(`test(spike): ${name}`);
      const result = runner(base, head);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const plan = selection(result);
      assert.deepEqual(plan.tasks.sort(), expected);
      assert.equal(plan.mode, mode);
      assert.ok(Object.values(plan.cache).every(value => value === false));
      const executions = [...result.stdout.matchAll(/EXEC:([^\r\n]+)/g)].map(match => match[1].trim()).sort();
      assert.deepEqual(executions, expected);
      if (["ui", "domain", "db-proposal", "pipeline"].includes(name)) {
        const planFile = join(directory, ".turbo", `${name}-db-plan.json`);
        const outputs = join(directory, ".turbo", `${name}-outputs.txt`);
        const planOnly = runner(base, head, ["test:db:local", "test:feature-store:db"],
          { TURBO_ALLOW_EMPTY: "1", TURBO_PLAN_ONLY: "1", TURBO_PLAN_FILE: planFile });
        assert.equal(planOnly.status, 0, planOnly.stdout + planOnly.stderr);
        assert.doesNotMatch(planOnly.stdout, /EXEC:/);
        const mapped = run(process.execPath, ["scripts/turbo/ci-db-selection.mjs", planFile], directory,
          { TURBO_BASE_SHA: base, TURBO_HEAD_SHA: head, TURBO_FORCE_FULL: "0", GITHUB_OUTPUT: outputs });
        assert.equal(mapped.status, 0, mapped.stdout + mapped.stderr);
        const values = readFileSync(outputs, "utf8");
        assert.match(values, new RegExp(`db_local=${expected.some(id => id.endsWith("#test:db:local"))}\\n`));
        assert.match(values, new RegExp(`feature_store=${expected.includes("@dfs-ev/pipeline#test:feature-store:db")}\\n`));
        receipt.guards.push({ name: `${name}: actual plan-only runner maps explicit CI booleans without task execution`, verdict: "pass" });
      }
      if (name === "ui") {
        const empty = runner(base, head, ["test:db:local", "test:feature-store:db"]);
        assert.notEqual(empty.status, 0);
        const intentional = runner(base, head, ["test:db:local", "test:feature-store:db"], { TURBO_ALLOW_EMPTY: "1" });
        assert.equal(intentional.status, 0, intentional.stderr);
        assert.deepEqual(selection(intentional).tasks, []);
        assert.doesNotMatch(intentional.stdout, /EXEC:/);
        receipt.guards.push({ name: "UI DB tasks: refused without opt-in; explicit empty succeeds without execution", verdict: "pass" });
        const full = runner(base, head, tasks, { TURBO_FORCE_FULL: "1" });
        assert.equal(full.status, 0, full.stdout + full.stderr);
        assert.equal(selection(full).mode, "full");
        assert.deepEqual(selection(full).tasks.sort(), all);
        assert.deepEqual([...full.stdout.matchAll(/EXEC:([^\r\n]+)/g)].map(match => match[1].trim()).sort(), all);
        receipt.guards.push({ name: "main/manual forced-full mode executes all tasks even on UI-only input", base, head, selected: all, verdict: "pass" });
      }
      receipt.probes.push({ name, path, base, head, mode, selected: plan.tasks, executed: executions, outputHash: sha256(result.stdout), verdict: "pass" });
    });
    for (const kind of ["mixed-unknown-ui", "lockfile", "dependency-lockfile"]) await t.test(kind, () => {
      git("checkout", "-q", "--detach", base);
      if (kind === "mixed-unknown-ui") {
        write("apps/web/src/probe.ts", "// UI\n");
        write("unclassified/probe.txt", "unknown\n");
      } else {
        const lock = JSON.parse(readFileSync(join(directory, "package-lock.json")));
        if (kind === "lockfile") lock.selectionProbe = true;
        else lock.packages["node_modules/react"].version = "19.3.2";
        write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
      }
      const head = commit(`test(spike): ${kind}`);
      const result = runner(base, head, tasks, { TURBO_ALLOW_EMPTY: "1" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const plan = selection(result);
      assert.deepEqual(plan.tasks.sort(), all);
      assert.equal(plan.mode, "full");
      receipt.probes.push({ name: kind, base, head, mode: plan.mode, selected: plan.tasks, outputHash: sha256(result.stdout), verdict: "pass" });
    });
    await t.test("PR merge checkout compares against its explicit target base", () => {
      git("checkout", "-q", "-b", "pr-source", base);
      write("apps/web/src/probe.ts", "// PR source edit\n");
      commit("test(spike): PR UI edit");
      git("checkout", "-q", "-b", "target-source", base);
      write("packages/domain/src/probe.ts", "// advanced target base\n");
      const targetBase = commit("test(spike): target advances before merge");
      git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "pr-source");
      const mergeHead = git("rev-parse", "HEAD");
      const result = runner(targetBase, mergeHead);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const selected = selection(result);
      assert.deepEqual(selected.tasks, ["@dfs-ev/web#test"]);
      receipt.probes.push({ name: "PR merge checkout", base: targetBase, head: mergeHead,
        mode: selected.mode, selected: selected.tasks, outputHash: sha256(result.stdout), verdict: "pass" });
    });
    await t.test("history, task flags, genuine empty selection and failure propagation", () => {
      git("checkout", "-q", "--detach", base);
      const guards = [
        ["missing SHA", runner("", base)],
        ["implicit ref", runner("HEAD~1", base)],
        ["unavailable commit", runner("f".repeat(40), base)],
        ["checkout mismatch", runner(base, receipt.probes[0].head)],
        ["Turbo bypass flag", runner(base, base, ["test", "--dry=json"])],
        ["invalid full-mode flag", runner(base, base, ["test"], { TURBO_FORCE_FULL: "unknown" })],
        ["plan-only without destination", runner(base, base, ["test"], { TURBO_PLAN_ONLY: "1" })],
      ];
      for (const [name, result] of guards) {
        assert.notEqual(result.status, 0, name);
        receipt.guards.push({ name, exitCode: result.status, verdict: "pass" });
      }
      const empty = runner(base, base, ["test"], { TURBO_ALLOW_EMPTY: "1" });
      assert.equal(empty.status, 0, empty.stderr);
      assert.deepEqual(selection(empty).tasks, []);
      assert.doesNotMatch(empty.stdout, /EXEC:/);
      const manifest = JSON.parse(readFileSync(join(directory, "apps/web/package.json")));
      manifest.scripts.test = "node -e 'process.exit(23)'";
      write("apps/web/package.json", JSON.stringify(manifest, null, 2) + "\n");
      const head = commit("test(spike): deliberate task failure");
      const failure = runner(base, head, ["test"]);
      assert.notEqual(failure.status, 0, failure.stdout + failure.stderr);
      receipt.guards.push({ name: "selected task failure", base, head, exitCode: failure.status, verdict: "pass" });
      const shallow = join(directory, "shallow");
      const clone = run("git", ["clone", "-q", "--depth=1", `file://${directory}`, shallow]);
      assert.equal(clone.status, 0, clone.stderr);
      const refusal = runner(head, head, ["test"], { TURBO_ALLOW_EMPTY: "1" }, shallow);
      assert.notEqual(refusal.status, 0);
      assert.match(refusal.stderr, /non-shallow/);
      receipt.guards.push({ name: "shallow checkout even with empty opt-in", exitCode: refusal.status, verdict: "pass" });
    });
    receipt.verdict = "pass";
    if (process.env.TURBO_MATRIX_RECEIPT) writeFileSync(process.env.TURBO_MATRIX_RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
