import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import nextEnvironment from "@next/env";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = fileURLToPath(new URL("../apps/web/", import.meta.url));

// Root commands preserve existing local .env files. Hosted deployments keep
// the app's native environment boundary and never load repository-root files.
export const loadLocalWebEnvironment = (directory, mode, environment = process.env) => {
  if (environment.VERCEL || environment.VERCEL_ENV || !["dev", "build", "start"].includes(mode)) return;
  nextEnvironment.loadEnvConfig(directory, mode === "dev", { info() {}, error() {} });
};

export const webCommand = (mode, args = []) => {
  if (!["dev", "build", "start", "typegen"].includes(mode)) throw new Error("Unsupported web command.");
  return [createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve("next/dist/bin/next"), mode, ...args];
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const command = webCommand(mode, args);
  // Help never needs credentials, nor does type generation.
  if (!args.includes("--help") && !args.includes("-h")) loadLocalWebEnvironment(root, mode);
  const environment = { ...process.env };
  delete environment.__NEXT_PROCESSED_ENV;
  const child = spawn(process.execPath, command, { cwd: app, env: environment, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", () => { console.error("Unable to start Next.js."); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); });
}
