import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "../tests/db/target.mts";

export class CatalogError extends Error {}
const refuse = (code) => { throw new CatalogError(code); };
export const fingerprint = (value) => createHash("sha256").update(value).digest("hex");

export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function parseCatalogOptions(args, environment) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      environment: { type: "string" }, identity: { type: "boolean" },
      "expected-host-fingerprint": { type: "string" }, "expected-database": { type: "string" },
      output: { type: "string" },
    } }));
  } catch { refuse("invalid-options"); }
  if (!["test", "preview", "production"].includes(values.environment)) refuse("explicit-environment-required");
  if (Object.keys(environment).some((name) => name.startsWith("PG"))) refuse("ambient-pg-options-refused");

  let config;
  if (values.environment === "test") {
    assertNoApplicationCredentials(environment);
    if (environment.MIGRATION_DATABASE_URL !== undefined) refuse("remote-url-refused-in-test-mode");
    config = parseTestDatabaseUrl(environment.TEST_DATABASE_URL);
  } else {
    let url;
    try { url = new URL(environment.MIGRATION_DATABASE_URL); } catch { refuse("explicit-migration-url-required"); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") ||
        !url.hostname.startsWith("ep-") || /-pooler(?:\.|$)/.test(url.hostname) ||
        (url.port && url.port !== "5432") || url.hash || !url.username || !url.password ||
        /\s/.test(environment.MIGRATION_DATABASE_URL)) refuse("direct-neon-url-required");
    for (const [key, value] of url.searchParams) {
      if (!((key === "sslmode" && value === "require") || (key === "channel_binding" && value === "require")) ||
          url.searchParams.getAll(key).length !== 1) refuse("migration-url-options-refused");
    }
    try {
      config = {
        host: url.hostname, port: 5432,
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        application_name: "dfs-ev-catalog", connectionTimeoutMillis: 5_000, query_timeout: 20_000,
      };
    } catch { refuse("invalid-migration-url"); }
    if (!config.database || config.database.includes("/") || /\s/.test(config.database)) refuse("invalid-database-name");
  }
  const identity = {
    declaredEnvironment: values.environment,
    hostFingerprint: fingerprint(config.host).slice(0, 12),
    databaseFingerprint: fingerprint(config.database).slice(0, 12),
  };
  if (!values.identity) {
    if (values["expected-host-fingerprint"] !== identity.hostFingerprint ||
        values["expected-database"] !== config.database) refuse("expected-target-mismatch");
    if (!values.output) refuse("output-required");
  }
  return { config, identity, identityOnly: values.identity === true, output: values.output };
}

export async function readCatalog(client, expected) {
  const sql = await readFile(new URL("../db/catalog.sql", import.meta.url), "utf8");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL search_path = pg_catalog, public");
    const { rows: [server] } = await client.query(
      "SELECT current_database() AS database, current_user AS role, current_setting('server_version_num')::integer AS version"
    );
    if (server.database !== expected.database || server.role !== expected.user) refuse("connected-target-mismatch");
    if (server.version < 180000 || server.version >= 190000) refuse("postgresql-18-required");
    const { rows: objects } = await client.query(sql);
    const catalog = { postgresMajor: 18, schema: "public", objects };
    await client.query("COMMIT");
    return {
      formatVersion: 1, serverVersionNum: server.version, ...catalog,
      catalogFingerprint: fingerprint(canonicalJson(catalog)),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function validateOutputPath(output) {
  const path = resolve(output);
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const parent = await realpath(dirname(path));
  const within = relative(root, parent);
  if (within === "" || (within !== ".." && !within.startsWith(".." + sep) && !within.startsWith(sep))) {
    refuse("output-must-be-outside-repository");
  }
  if (!path.endsWith(".json")) refuse("json-output-required");
  return path;
}

export async function runCatalog(args, environment) {
  const options = parseCatalogOptions(args, environment);
  if (options.identityOnly) {
    process.stdout.write(JSON.stringify(options.identity) + "\n");
    return;
  }
  const output = await validateOutputPath(options.output);
  const { Client } = options.identity.declaredEnvironment === "test"
    ? await import("pg") : await import("@neondatabase/serverless");
  const client = new Client(options.config);
  try {
    await client.connect();
    const snapshot = {
      ...await readCatalog(client, options.config),
      target: options.identity, capturedAt: new Date().toISOString(),
    };
    await writeFile(output, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const tables = snapshot.objects.filter((object) => object.kind === "relation" && ["r", "p"].includes(object.definition.kind));
    process.stdout.write(JSON.stringify({ tables: tables.length, catalogFingerprint: snapshot.catalogFingerprint }) + "\n");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCatalog(process.argv.slice(2), process.env); }
  catch (error) {
    // Only our fixed codes are printed; driver/parser/filesystem errors can
    // contain URLs, credentials, query text or private paths.
    process.stderr.write("db-catalog: " + (error instanceof CatalogError ? error.message : "export-failed") + "\n");
    process.exitCode = 1;
  }
}
