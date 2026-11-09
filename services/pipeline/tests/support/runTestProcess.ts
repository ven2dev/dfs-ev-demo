import { spawn } from "node:child_process";

type TestProcessOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };

export const startTestProcess = (command: string, args: string[], { cwd, env, timeoutMs }: TestProcessOptions) => {
  // On CI and macOS the group lets the deadline stop the runner's workers
  // even if their parent has already exited.
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  const kill = () => {
    if (closed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        kill();
      } catch (cause) {
        error = new Error("Could not terminate test process group", { cause });
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (cause) => { error = cause; });
    child.once("close", (status, signal) => {
      closed = true;
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
  const stop = async () => {
    kill();
    await result.catch(() => undefined);
  };
  return { child, result, stop };
};

export const runTestProcess = (command: string, args: string[], options: TestProcessOptions) =>
  startTestProcess(command, args, options).result;
