import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type ClientConfig } from "pg";
import { createCatalogVerifier, loadCatalogContracts } from "@dfs-ev/db-tooling/migrations/contracts";
import { runScratchMigrations } from "@dfs-ev/db-tooling/migrations/core";
import { checkMigrationArtifacts } from "@dfs-ev/db-tooling/migrations/files";
import { prepareMigrationContext } from "@dfs-ev/db-tooling/migrations/plans";
import { createScratchHarness } from "@dfs-ev/db-tooling/test-support/scratch";
import { parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";

export const withFeatureStoreDatabase = async <T>(run: (context: {
  admin: Client; writer: Client; reader: Client; openWriter: () => Promise<Client>; createWriterConfig: () => Promise<ClientConfig>; createReaderConfig: () => Promise<ClientConfig>; queryCounts: { writer: number; reader: number };
}) => Promise<T>): Promise<T> => {
  const harness = await createScratchHarness(process.env);
  const names: string[] = [];
  try {
    return await harness.withDatabase(async (admin: Client, config: ClientConfig) => {
      const clients: Client[] = [];
      try {
        const files = await checkMigrationArtifacts();
        const context = await prepareMigrationContext(files, await loadCatalogContracts(files));
        await runScratchMigrations(admin, { expected: config, files: context.files, assertTarget: harness.assertTarget,
          verify: createCatalogVerifier(context.contracts) });
        await admin.query("BEGIN");
        try {
          await admin.query(await readFile(new URL("../../../../packages/db/proposals/138_feature_store.sql", import.meta.url), "utf8")); await admin.query(await readFile(new URL("../../../../packages/db/proposals/138_dataset_governance.sql", import.meta.url), "utf8"));
          await admin.query(await readFile(new URL("../../../../packages/db/proposals/163_effective_rights.sql", import.meta.url), "utf8"));
          await admin.query("COMMIT");
        } catch (error) { await admin.query("ROLLBACK"); throw error; }
        const queryCounts = { writer: 0, reader: 0 };
        const loginConfig = async (role: "writer" | "reader") => {
          const name = "fs138_job_" + randomBytes(8).toString("hex");
          await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'fs138_throwaway' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          names.push(name);
          await admin.query(`GRANT ${role === "writer" ? "fs138_pipeline_writer" : "fs138_reader"} TO ${name}`);
          return { ...config, user: name, password: "fs138_throwaway" };
        };
        const login = async (role: "writer" | "reader") => {
          const client = new Client(await loginConfig(role));
          clients.push(client);
          await client.connect();
          let busy = false;
          return new Proxy(client, { get(target, property) {
            if (property !== "query") return Reflect.get(target, property, target);
            return (...args: unknown[]) => {
              if (busy) throw new Error("concurrent-client-query-refused");
              busy = true; queryCounts[role]++;
              return (Reflect.apply(target.query, target, args) as Promise<unknown>).finally(() => { busy = false; });
            };
          } });
        };
        return await run({ admin, writer: await login("writer"), reader: await login("reader"), openWriter: () => login("writer"), createWriterConfig: () => loginConfig("writer"), createReaderConfig: () => loginConfig("reader"), queryCounts });
      } finally { await Promise.all(clients.map((client) => client.end())); }
    });
  } finally {
    const cleanup = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
    try {
      await cleanup.connect();
      for (const name of names) await cleanup.query(`DROP ROLE ${name}`);
    } finally { await cleanup.end(); await harness.close(); }
  }
};
