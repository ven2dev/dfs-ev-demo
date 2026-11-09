import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runTestProcess } from "../support/runTestProcess.ts";

const isRunning = async (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // A terminated child can remain in the process table until it is reaped.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
};

it("stops a hung Node test runner, its worker and grandchild, and reports captured output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dfs-test-process-"));
  try {
    // The runner buffers test-worker output until a test reports a result.
    await writeFile(join(cwd, "output.mjs"), 'console.log("output before timeout");');
    await writeFile(join(cwd, "hang.test.mjs"), `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { test } from "node:test";
      test("hangs", async () => {
        // The fixtures also exit on their own if the timeout helper regresses.
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"]);
        writeFileSync("pids.json", JSON.stringify([process.ppid, process.pid, child.pid]));
        await new Promise(resolve => setTimeout(resolve, 15_000));
      });
    `);
    const run = runTestProcess(process.execPath,
      ["--import", "./output.mjs", "--test", "hang.test.mjs"], {
        cwd, env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeoutMs: 3_000,
      });
    await expect(run).rejects.toThrow(/Test process timed out after 3000 ms[\s\S]*output before timeout/);
    const pids = JSON.parse(await readFile(join(cwd, "pids.json"), "utf8")) as number[];
    expect(new Set(pids).size).toBe(3);
    await vi.waitFor(async () => {
      expect(await Promise.all(pids.map(isRunning))).toEqual([false, false, false]);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
