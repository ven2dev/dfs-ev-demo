import { fileURLToPath } from "node:url";
import { startDatabaseTestRun } from "@dfs-ev/db-tooling/test-support/lifecycle";
import { startTestProcess } from "../../services/pipeline/tests/support/runTestProcess.ts";

// Explicit owner-approved quiet window only. Target/credential checks are the
// same ones used by the ordinary DB harness; no dotenv or hosted fallback.
const lease = await startDatabaseTestRun(process.env);
const child = startTestProcess(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
  "--config", "vitest.cache-221.config.mts"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, timeoutMs: 75_000,
});
const stop = () => { void child.stop(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
lease.failureSignal.addEventListener("abort", stop, { once: true });
try {
  const result = await child.result;
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  lease.failureSignal.throwIfAborted();
  process.exitCode = result.status ?? 1;
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  lease.failureSignal.removeEventListener("abort", stop);
  await child.stop(); await lease.close();
}
