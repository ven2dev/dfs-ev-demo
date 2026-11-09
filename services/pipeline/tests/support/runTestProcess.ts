import { spawn } from "node:child_process";

type TestProcessOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };

export const runTestProcess = (command: string, args: string[], { cwd, env, timeoutMs }: TestProcessOptions) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // The Node test runner can spawn workers. On CI and macOS the group lets
    // the deadline stop them even if the parent has already exited.
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
          error = new Error("Could not terminate test process group", { cause });
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (cause) => { error = cause; });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut || error) {
        const reason = timedOut ? `Test process timed out after ${timeoutMs} ms` : "Test process failed to start";
        reject(new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error }));
      } else if (signal) {
        reject(new Error(`Test process stopped by ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        resolve({ status, stdout, stderr });
      }
    });
  });
