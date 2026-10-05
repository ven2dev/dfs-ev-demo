import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

const clients = new Set<Client>();

export async function openTestClient(): Promise<Client> {
  assertNoApplicationCredentials(process.env);
  const client = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
  clients.add(client);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await closeTestClient(client);
    throw error;
  }
}

export async function closeTestClient(client: Client) {
  try {
    await client.end();
  } finally {
    clients.delete(client);
  }
}

export async function closeTestClients() {
  const results = await Promise.allSettled([...clients].map(closeTestClient));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new Error("Failed to close DB test clients.");
}

export async function withTestClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await openTestClient();
  try {
    return await run(client);
  } finally {
    await closeTestClient(client);
  }
}

export async function bootstrapTestDatabase() {
  const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  await withTestClient(async (client) => {
    const result = await client.query<{
      database: string;
      role: string;
      version: number;
    }>(`SELECT current_database() AS database, current_user AS role,
               current_setting('server_version_num')::integer AS version`);
    const server = result.rows[0];
    if (server.database !== "dfs_ev_test" || server.role !== "dfs_ev_test" ||
        server.version < 180000 || server.version >= 190000) {
      throw new Error("Bootstrap requires the disposable dfs_ev_test database and role on PostgreSQL 18.");
    }
    // Both calls must succeed: #60 can reuse this full-schema bootstrap.
    await client.query(schema);
    await client.query(schema);
  });
}

export async function resetLivePropCache() {
  await withTestClient(async (client) => {
    await client.query("TRUNCATE TABLE live_prop_inputs_cache");
  });
}
