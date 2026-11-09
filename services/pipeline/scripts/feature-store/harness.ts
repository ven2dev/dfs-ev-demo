import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type ClientConfig } from "pg";
import { createCatalogVerifier, loadCatalogContracts } from "@dfs-ev/db-tooling/migrations/contracts";
import { runScratchMigrations } from "@dfs-ev/db-tooling/migrations/core";
import { checkMigrationArtifacts } from "@dfs-ev/db-tooling/migrations/files";
import { prepareMigrationContext } from "@dfs-ev/db-tooling/migrations/plans";
import { createScratchHarness } from "@dfs-ev/db-tooling/test-support/scratch";
import { assertReplayScratchTarget, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";

const replayTargets = new WeakMap<Pick<Client, "query">, () => void>();

export const assertFeatureStoreReplayTarget = (client: Pick<Client, "query">, writer?: Pick<Client, "query">): void => {
  const verify = replayTargets.get(client);
  if (!verify || (writer && replayTargets.get(writer) !== verify)) throw new Error("Unregistered replay scratch client refused.");
  verify();
};

export const withFeatureStoreDatabase = async <T>(run: (context: {
  admin: Client; writer: Client; reader: Client; openWriter: () => Promise<Client>; createWriterConfig: () => Promise<ClientConfig>; createReaderConfig: () => Promise<ClientConfig>; queryCounts: { writer: number; reader: number };
}) => Promise<T>): Promise<T> => {
  const timingEnabled = process.env.FEATURE_STORE_DB_TIMING === "1";
  const started = performance.now();
  let callbackStarted: number | undefined;
  let callbackFinished: number | undefined;
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
          await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/138_feature_store.sql")), "utf8")); await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/138_dataset_governance.sql")), "utf8"));
          await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/163_effective_rights.sql")), "utf8"));
          await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/241_job_visibility.sql")), "utf8"));
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
        const writer = await login("writer");
        const reader = await login("reader");
        const verifyReplayTarget = () => assertReplayScratchTarget(process.env, config, harness.assertTarget);
        replayTargets.set(admin, verifyReplayTarget);
        replayTargets.set(writer, verifyReplayTarget);
        try {
          callbackStarted = performance.now();
          return await run({ admin, writer, reader, openWriter: () => login("writer"),
            createWriterConfig: () => loginConfig("writer"), createReaderConfig: () => loginConfig("reader"), queryCounts });
        } finally {
          callbackFinished = performance.now();
          replayTargets.delete(writer);
          replayTargets.delete(admin);
        }
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
    });
  } finally {
    const cleanup = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL));
    try {
      await cleanup.connect();
      for (const name of names) await cleanup.query(`DROP ROLE ${name}`);
    } finally {
      await cleanup.end();
      await harness.close();
      if (timingEnabled && callbackStarted !== undefined && callbackFinished !== undefined) {
        console.log("feature-store-db-timing", JSON.stringify({
          file: process.argv[1],
          setupMs: callbackStarted - started,
          callbackMs: callbackFinished - callbackStarted,
          cleanupMs: performance.now() - callbackFinished,
        }));
      }
    }
  }
};
