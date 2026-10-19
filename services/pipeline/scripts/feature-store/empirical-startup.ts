import { Client, type ClientConfig } from "pg";
import { assertNoApplicationCredentials } from "../../../../packages/db/tests/target.mts";
import { createEmpiricalAdapter, type EmpiricalRequest } from "../../src/featureStore/empiricalAdapter.ts";

assertNoApplicationCredentials(process.env);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const { config, request } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { config: ClientConfig; request: EmpiricalRequest };
if (config.host !== "127.0.0.1" || config.port !== 54329 || config.ssl !== false ||
    !/^dfs_ev_test_[a-f0-9]{20}$/.test(String(config.database)) || !/^fs138_job_[a-f0-9]{16}$/.test(String(config.user)) ||
    config.password !== "fs138_throwaway") throw new Error("prototype-startup-target-refused");
const predict = await createEmpiricalAdapter();
// performance.now starts at process launch; includes module loading and stdin/SQL setup.
const processReadyMs = performance.now();
const client = new Client(config);
try {
  const started = performance.now();
  await client.connect();
  const connectionMs = performance.now() - started;
  const read = await predict(client, request, { deadlineAt: started + 300 });
  const requestMs = performance.now() - started;
  if (read.response.status !== "available") throw new Error(`startup-adapter-refusal:${read.response.reason}`);
  const result = { timing: { connection: connectionMs, authorization: read.timingMs.authorization, history: read.timingMs.history,
    calculation: read.timingMs.calculation, delivery: read.timingMs.delivery, serialization: read.timingMs.serialization, request: requestMs },
    work: read.work };
  process.stdout.write(JSON.stringify({ processReadyMs, result }) + "\n");
} finally { await client.end(); }
