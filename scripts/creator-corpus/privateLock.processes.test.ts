// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCaptureLog } from "../../src/lib/creatorCaptures.ts";
import { NOW, discoveryFor, record } from "./testSupport.ts";

// Real, separate processes against one lock, released together by a barrier
// file. Tests in one process cannot show that two writers are kept apart.
const WORKER = resolve(process.cwd(), "scripts/creator-corpus/testWorkers/lockWorker.ts");
let directory: string;
let shared: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-locks-"));
  shared = await mkdtemp(join(tmpdir(), "creator-corpus-locks-shared-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(shared, { recursive: true, force: true });
});

const goPath = () => join(shared, "go");
const runWorkers = async (count: number, mode: string, target: string, extra?: string) => {
  const outputs = Array.from({ length: count }, () => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", WORKER, mode, target, goPath(), shared, ...(extra ? [extra] : [])],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
      child.on("close", (code) => done({ code, stdout: stdout.trim(), stderr }))
    );
  });
  // Give every child time to start and reach the barrier, then release them together.
  await new Promise((done) => setTimeout(done, 1500));
  await writeFile(goPath(), "go");
  return Promise.all(outputs);
};

// A pid that is certainly gone: a child that has already exited.
const deadPid = () =>
  new Promise<number>((done) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("close", () => done(child.pid as number));
  });
const staleLock = async (target: string) =>
  writeFile(join(directory, `.${target}.lock`), JSON.stringify({ pid: await deadPid(), at: Date.now() - 1000, token: randomUUID() }), { mode: 0o600 });

describe("the file lock across processes", () => {
  it("never displaces a paused takeover claimant, however long it is paused, and recovers once it is gone", async () => {
    // A live process stands in for a claimant that is paused (machine sleep, a debugger):
    // it holds the claim for the stale lock and is not running its takeover.
    const paused = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    try {
      const lockPath = join(directory, ".log.json.lock");
      const stale = { pid: await deadPid(), at: Date.now() - 1000, token: randomUUID() };
      await writeFile(lockPath, JSON.stringify(stale), { mode: 0o600 });
      const claimPath = `${lockPath}.reap-${stale.token}`;
      const claim = JSON.stringify({ pid: paused.pid, at: Date.now() - 3_600_000, token: randomUUID() });
      await writeFile(claimPath, claim, { mode: 0o600 });
      const old = new Date(Date.now() - 3_600_000);
      await utimes(claimPath, old, old);

      const blocked = await runWorkers(6, "try", join(directory, "log.json"));
      expect(blocked.map((result) => result.stdout)).toEqual(Array(6).fill("file-busy"));
      expect(await readFile(claimPath, "utf8")).toBe(claim);
      expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe(stale.token);

      // Once the claimant is gone, contenders recover and exactly one at a time gets in.
      paused.kill("SIGKILL");
      await new Promise((done) => paused.once("close", done));
      await rm(goPath(), { force: true });
      await writeFile(join(shared, "counter.txt"), "0");
      const recovered = await runWorkers(6, "section", join(directory, "log.json"));
      expect(recovered.map((result) => result.stdout)).toEqual(Array(6).fill("done"));
      await expect(stat(join(shared, "violations.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(shared, "counter.txt"), "utf8")).toBe("6");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      paused.kill("SIGKILL");
    }
  }, 120_000);

  it("lets one process at a time into the protected section, even when it starts from a stale lock", async () => {
    const count = 16;
    await writeFile(join(shared, "counter.txt"), "0");
    await staleLock("log.json");
    const results = await runWorkers(count, "section", join(directory, "log.json"));
    expect(results.map((result) => result.stderr)).toEqual(Array(count).fill(""));
    expect(results.map((result) => result.stdout)).toEqual(Array(count).fill("done"));
    await expect(stat(join(shared, "violations.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(shared, "counter.txt"), "utf8")).toBe(String(count));
    expect(await readdir(directory)).toEqual([]);
  }, 60_000);

  it("lets one process at a time in from a clean start too, and from a repeated stale takeover", async () => {
    for (const round of [1, 2, 3]) {
      await rm(goPath(), { force: true });
      await writeFile(join(shared, "counter.txt"), "0");
      if (round !== 1) await staleLock("log.json");
      const results = await runWorkers(10, "section", join(directory, "log.json"));
      expect(results.map((result) => result.stdout), `round ${round}`).toEqual(Array(10).fill("done"));
      await expect(stat(join(shared, "violations.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(shared, "counter.txt"), "utf8")).toBe("10");
    }
  }, 120_000);

  it("keeps two capture requests for the same video from both being saved, leaving a readable log", async () => {
    const count = 8;
    await writeFile(join(shared, "discovery.json"), JSON.stringify(discoveryFor([record(1, { title: "NFL Week 6 Player Props" })])));
    await staleLock("captures.jsonl");
    const target = join(directory, "captures.jsonl");
    const results = await runWorkers(count, "capture", target, NOW.toISOString());
    expect(results.map((result) => result.stderr)).toEqual(Array(count).fill(""));
    const outcomes = results.map((result) => result.stdout).sort();
    expect(outcomes).toEqual(["accepted", ...Array(count - 1).fill("already-captured")]);
    const events = parseCaptureLog(await readFile(target, "utf8"));
    expect(events).toHaveLength(1);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["captures.jsonl"]);
  }, 60_000);
});
