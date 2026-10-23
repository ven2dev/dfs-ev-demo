import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const tasks = separator === -1 ? args : args.slice(0, separator);
const taskArgs = separator === -1 ? [] : args.slice(separator);
const refuse = message => { console.error(message); process.exit(2); };
for (const name of ["TURBO_FORCE_FULL", "TURBO_PLAN_ONLY"]) {
  if (![undefined, "", "0", "1"].includes(process.env[name])) refuse(`${name} must be 0 or 1.`);
}
if (process.env.TURBO_PLAN_ONLY === "1" && !process.env.TURBO_PLAN_FILE) {
  refuse("TURBO_PLAN_FILE is required for a plan-only invocation.");
}
if (!tasks.length || tasks.some(task => !/^[a-zA-Z0-9:_-]+$/.test(task))) {
  refuse("Usage: npm run turbo:affected -- <task> [<task> ...] [-- ...task arguments]; Turbo override flags are refused.");
}

const base = process.env.TURBO_BASE_SHA;
const head = process.env.TURBO_HEAD_SHA;
if (![base, head].every(sha => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))) {
  refuse("TURBO_BASE_SHA and TURBO_HEAD_SHA must be explicit full commit SHAs; implicit Git history is refused.");
}
const git = parameters => spawnSync("git", parameters, { cwd: root, encoding: "utf8" });
const shallow = git(["rev-parse", "--is-shallow-repository"]);
if (shallow.status !== 0 || shallow.stdout.trim() !== "false") {
  refuse("Affected selection requires a complete, non-shallow Git checkout.");
}
for (const sha of [base, head]) {
  if (git(["cat-file", "-e", `${sha}^{commit}`]).status !== 0) refuse(`Git commit is unavailable: ${sha}`);
}
const checkout = git(["rev-parse", "HEAD"]);
if (checkout.status !== 0 || checkout.stdout.trim() !== head) {
  refuse("TURBO_HEAD_SHA must match the checked-out commit, to avoid testing different source.");
}

const turbo = resolve(root, "node_modules/turbo/bin/turbo");
if (!existsSync(turbo)) refuse("Turbo is not installed; run npm ci first.");
// Serial execution prevents shared-port/container lifecycle races. CI retains
// ownership of fixture provisioning and always-run cleanup.
const common = ["run", ...tasks, "--cache=local:rw", "--concurrency=1"];
const filtered = [...common, `--filter=...[${base}...${head}]`];
const dryRun = parameters => {
  const result = spawnSync(process.execPath, [turbo, ...parameters, "--dry=json"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.error(result.error?.message ?? result.stderr);
    process.exit(result.status ?? 1);
  }
  let plan;
  try { plan = JSON.parse(result.stdout); }
  catch { refuse("Turbo did not return a JSON dry-run plan."); }
  if (!Array.isArray(plan.packages) || !plan.packages.every(p => typeof p === "string") ||
      !Array.isArray(plan.tasks) || !plan.tasks.every(t => typeof t.taskId === "string" && typeof t.command === "string")) {
    refuse("Turbo returned an incomplete task plan; an unknown plan cannot mean no work.");
  }
  return plan;
};

let plan = dryRun(process.env.TURBO_FORCE_FULL === "1" ? common : filtered);
// Turbo owns the package/dependency analysis. Its root marker means shared or
// unowned input: use the whole graph even if a known edit is in the same diff.
const full = process.env.TURBO_FORCE_FULL === "1" || plan.packages.includes("//");
const execution = full ? common : filtered;
if (full && process.env.TURBO_FORCE_FULL !== "1") plan = dryRun(common);
// A configured task without a package script is a Turbo transit node. It does
// not execute and cannot count as selected coverage (notably UI-only DB plans).
const executable = plan.tasks.filter(task => task.command !== "<NONEXISTENT>");
const intentionalEmpty = !full && executable.length === 0 && process.env.TURBO_ALLOW_EMPTY === "1";
if (executable.length === 0 && !intentionalEmpty) {
  refuse("Turbo selected no tasks; explicit TURBO_ALLOW_EMPTY=1 is required for an intentional empty selection.");
}
const selection = { schemaVersion: 1, base, head, requestedTasks: tasks,
  mode: full ? "full" : "affected", packages: plan.packages,
  tasks: executable.map(t => t.taskId), intentionalEmpty,
  cache: Object.fromEntries(executable.map(t => [t.taskId, t.resolvedTaskDefinition.cache])) };
console.log(`TURBO_SELECTION ${JSON.stringify(selection)}`);
if (process.env.TURBO_PLAN_ONLY === "1") {
  writeFileSync(process.env.TURBO_PLAN_FILE, JSON.stringify(selection) + "\n", { flag: "wx" });
  process.exit(0);
}
// Publish completion only after successful execution (or an explicit empty
// selection). Planning alone and failed tasks cannot manufacture a receipt.
const complete = () => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `mode=${selection.mode}\nwork=${intentionalEmpty ? "intentional-empty" : "executed"}\n`);
};
if (intentionalEmpty) {
  complete();
  console.log("Intentional empty task selection; no task was skipped or executed.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [turbo, ...execution, ...taskArgs], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
if (result.status === 0) complete();
process.exit(result.status ?? 1);
