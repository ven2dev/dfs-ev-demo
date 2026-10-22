import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRegistration } from "../scripts/creator-corpus/creatorInputs.ts";
import { startReviewServer } from "../scripts/creator-corpus/reviewServer.ts";
import { readPrivateJson, withPrivateFileLock, writePrivateJson } from "../scripts/creator-corpus/privateOutput.ts";
import { discoveryFor, NOW, record } from "../scripts/creator-corpus/testSupport.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pipelineRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanEnv = { PATH: process.env.PATH, NODE_ENV: "test" };

test("root and workspace creator commands preserve successful local output and argument refusals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-cli-contract-"));
  try {
    const input = join(directory, "synthetic-discovery.json");
    await writePrivateJson(input, discoveryFor([record(1)]));
    const outputs = [];
    for (const cwd of [repositoryRoot, pipelineRoot]) {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const [node, ...args] = pkg.scripts.creators.split(" ");
      assert.equal(node, "node");
      const run = extra => spawnSync(process.execPath, [...args, ...extra], { cwd, env: cleanEnv, encoding: "utf8", timeout: 10_000 });
      const success = run(["screen", "--input", input]);
      assert.ifError(success.error);
      assert.equal(success.status, 0, success.stderr);
      assert.equal(success.stderr, "");
      assert.match(success.stdout, /creator-a/);
      outputs.push(success.stdout);
      const refusal = run(["resolve"]);
      assert.ifError(refusal.error);
      assert.equal(refusal.status, 1);
      assert.equal(refusal.stdout, "");
      assert.equal(refusal.stderr, "creator-corpus: creators-and-output-required\n");
    }
    assert.equal(outputs[0], outputs[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("creator registration and loopback review assets resolve independently of cwd", async () => {
  const registration = await loadRegistration();
  assert.equal(registration.ruleVersion, "v1");
  const directory = await mkdtemp(join(tmpdir(), "pipeline-assets-contract-"));
  let server;
  try {
    server = await startReviewServer({ discovery: discoveryFor([record(1)]), decisionsPath: join(directory, "decisions.json"), now: () => NOW });
    const origin = new URL(server.url).origin;
    for (const [route, asset] of [["/", "index.html"], ["/client.js", "client.js"], ["/capture.js", "capture.js"], ["/app.css", "app.css"]]) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), await readFile(new URL("../scripts/creator-corpus/review/" + asset, import.meta.url), "utf8"));
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("private reads, writes and locks refuse the repository root and every sibling workspace", async () => {
  for (const workspace of ["", "apps/web", "packages/domain", "packages/db", "packages/db/tooling", "services/pipeline"]) {
    const target = join(repositoryRoot, workspace, "package.json");
    const before = await readFile(target);
    let entered = false;
    await assert.rejects(readPrivateJson(target), { code: "must-be-outside-repository" });
    await assert.rejects(writePrivateJson(target, { synthetic: true }), { code: "must-be-outside-repository" });
    await assert.rejects(withPrivateFileLock(target, async () => { entered = true; }), { code: "must-be-outside-repository" });
    assert.equal(entered, false);
    assert.deepEqual(await readFile(target), before);
  }
});

test("cold evaluation worker loads native imports and announces IPC readiness from either cwd", async () => {
  await new Promise((resolve, reject) => {
    const child = fork(new URL("../scripts/feature-store/evaluation-worker.ts", import.meta.url), [], {
      cwd: process.cwd(), execArgv: [], env: cleanEnv, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let ready = false, stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("evaluation-worker-startup-timeout")); }, 10_000);
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("message", message => {
      ready = message.ready === true;
      // No request/config is sent: no connection or fixture is created.
      child.kill("SIGTERM");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (ready && signal === "SIGTERM" && stderr === "") resolve();
      else reject(new Error(`evaluation-worker-startup-failed: ${code}: ${stderr}`));
    });
  });
  for (const [file, refusal] of [["derived-cold.ts", "cold-worker-target-refused"], ["dataset-cold.ts", "dataset-cold-target-refused"], ["empirical-startup.ts", "prototype-startup-target-refused"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/feature-store/" + file, import.meta.url))], {
      cwd: process.cwd(), env: cleanEnv, input: JSON.stringify({ config: { host: "invalid-target" } }), encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(refusal));
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/);
  }
});
