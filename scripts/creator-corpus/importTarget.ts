import type { ClientConfig } from "pg";

export class CorpusImportTargetError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new CorpusImportTargetError(code);
};

export type CorpusDatabaseRegistration = {
  formatVersion: 1;
  transport: "loopback";
  port: number;
  database: string;
  role: "corpus_importer";
};

const DATABASE = /^[a-z][a-z0-9_]{0,62}$/;

export const parseCorpusDatabaseRegistration = (input: unknown): CorpusDatabaseRegistration => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("invalid-database-registration");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "database,formatVersion,port,role,transport" ||
    value.formatVersion !== 1 ||
    value.transport !== "loopback" ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1024 ||
    (value.port as number) > 65535 ||
    typeof value.database !== "string" ||
    !DATABASE.test(value.database) ||
    value.role !== "corpus_importer"
  ) {
    return fail("invalid-database-registration");
  }
  return value as CorpusDatabaseRegistration;
};

export type CorpusDatabaseConfig = ClientConfig & {
  host: "127.0.0.1" | "::1";
  port: number;
  database: string;
  user: "corpus_importer";
  password: string;
  ssl: false;
};

export const parseCorpusDatabaseTarget = (
  environment: Record<string, string | undefined>,
  registration: CorpusDatabaseRegistration
): CorpusDatabaseConfig => {
  if (Object.keys(environment).some((name) =>
    name === "DATABASE_URL" || name === "MIGRATION_DATABASE_URL" || name.startsWith("POSTGRES_") || name.startsWith("PG")
  )) {
    return fail("ambient-database-configuration-refused");
  }
  const raw = environment.CORPUS_DATABASE_URL;
  if (!raw || /\s/.test(raw)) return fail("local-corpus-database-required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("local-corpus-database-required");
  }
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return fail("local-corpus-database-required");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    Number(url.port) !== registration.port ||
    database !== registration.database ||
    user !== registration.role ||
    !password ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return fail("local-corpus-database-required");
  }
  return {
    host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: registration.port,
    database,
    user: "corpus_importer",
    password,
    ssl: false,
    application_name: "dfs-ev-corpus-import",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
  };
};
