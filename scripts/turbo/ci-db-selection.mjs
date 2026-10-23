import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const localTaskIds = ["@dfs-ev/db-tooling#test:db:local", "@dfs-ev/pipeline#test:db:local"];
const featureTaskId = "@dfs-ev/pipeline#test:feature-store:db";
const taskIds = [...localTaskIds, featureTaskId];

// Translate a validated Turbo plan into explicit CI booleans. This interprets
// task identities only; package ownership and dependency selection stay in Turbo.
export const databaseSelection = (plan, { base, head, forceFull }) => {
  const refuse = () => { throw new Error("Invalid database task plan; refusing unknown or incomplete selection."); };
  if (plan?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(base ?? "") || !/^[a-f0-9]{40}$/.test(head ?? "") ||
      plan.base !== base || plan.head !== head || !["0", "1"].includes(forceFull) ||
      !["affected", "full"].includes(plan.mode) ||
      (forceFull === "1" && plan.mode !== "full") ||
      JSON.stringify(plan.requestedTasks) !== JSON.stringify(["test:db:local", "test:feature-store:db"]) ||
      !Array.isArray(plan.packages) || !plan.packages.every(p => typeof p === "string") ||
      !Array.isArray(plan.tasks) || new Set(plan.tasks).size !== plan.tasks.length ||
      plan.tasks.some(t => !taskIds.includes(t)) ||
      plan.intentionalEmpty !== (plan.tasks.length === 0 && plan.mode === "affected") ||
      !plan.cache || JSON.stringify(Object.keys(plan.cache).sort()) !== JSON.stringify([...plan.tasks].sort()) ||
      Object.values(plan.cache).some(value => value !== false) ||
      (plan.mode === "full" && plan.tasks.length !== taskIds.length)) refuse();
  return { db_local: String(localTaskIds.some(id => plan.tasks.includes(id))), feature_store: String(plan.tasks.includes(featureTaskId)), mode: plan.mode };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.env.GITHUB_OUTPUT) throw new Error("Plan path and GITHUB_OUTPUT are required.");
  const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const output = databaseSelection(plan, { base: process.env.TURBO_BASE_SHA, head: process.env.TURBO_HEAD_SHA, forceFull: process.env.TURBO_FORCE_FULL });
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([name, value]) => `${name}=${value}\n`).join(""));
  console.log(JSON.stringify(output));
}
