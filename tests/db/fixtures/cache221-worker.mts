import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getSharedOddsBatch } from "@dfs-ev/db/runtime";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";

assertNoApplicationCredentials(process.env);
const job = JSON.parse(process.argv[2]) as { event: string; keys: string[]; url: string; pauseAfterClaim?: boolean };
const url = new URL(job.url);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/odds") {
  throw new Error("Only the loopback mock provider is allowed");
}
const client = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DB_TEST_LANE));
const heartbeat = setInterval(() => undefined, 1_000);
await client.connect();
try {
  const result = await getSharedOddsBatch(job.event, job.keys, {
    query: async (text, params) => {
      const rows = (await client.query(text, params)).rows;
      if (job.pauseAfterClaim && text.includes("claim_shared") && rows[0]?.outcome === "leader") {
        console.log(JSON.stringify({ phase: "claimed", pid: process.pid }));
        await new Promise<void>(() => undefined);
      }
      return rows;
    },
    fetch: async (keys, signal) => {
      const response = await fetch(url, { method: "POST", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ event: job.event, keys }) });
      if (!response.ok) throw new Error("Local mock provider failed");
      return await response.json() as Record<string, { bookmakers: [] }>;
    },
    makeOwnerId: randomUUID, monotonicNow: () => performance.now(),
    wait: async ms => {
      console.log(JSON.stringify({ phase: "follower", pid: process.pid }));
      await new Promise(resolve => setTimeout(resolve, ms));
    },
  }, { ttlMs: 90_000 });
  console.log(JSON.stringify({ phase: "complete", pid: process.pid, result }));
} finally {
  clearInterval(heartbeat);
  await client.end();
}
