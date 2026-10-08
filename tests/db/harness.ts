import { Client } from "pg";
import { bootstrapPrimaryTestDatabase } from "./bootstrap.mjs";
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
  return withTestClient((client) => bootstrapPrimaryTestDatabase(client, process.env));
}

export async function resetLivePropCache() {
  await withTestClient(async (client) => {
    await client.query("TRUNCATE TABLE live_prop_inputs_cache");
  });
}
