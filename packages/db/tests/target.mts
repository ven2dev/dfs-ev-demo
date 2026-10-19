// Only the disposable database's public test credentials belong here.
// Never load an application .env file or fall back to DATABASE_URL.
export const LOCAL_TEST_DATABASE_URL =
  "postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test";

export function assertNoApplicationCredentials(environment: NodeJS.ProcessEnv) {
  const forbidden = Object.keys(environment).some(
    (name) =>
      name === "DATABASE_URL" ||
      name === "MIGRATION_DATABASE_URL" ||
      name === "ODDS_API_KEY" ||
      name.startsWith("FIREBASE_ADMIN_") ||
      name.startsWith("POSTGRES_") ||
      name.startsWith("PG") ||
      name === "GOOGLE_APPLICATION_CREDENTIALS"
  );
  if (forbidden) {
    throw new Error("Application/database credentials are not allowed in the DB test environment.");
  }
}

export function parseTestDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error("TEST_DATABASE_URL is required; DB tests cannot be skipped.");

  // Errors deliberately never include the supplied URL.
  const refused = () => new Error(
    "TEST_DATABASE_URL must target the disposable loopback dfs_ev_test database on port 54329 with its throwaway credentials and no URL options."
  );
  if (/\s/.test(value)) throw refused();

  let url: URL;
  let database: string;
  let user: string;
  let password: string;
  try {
    url = new URL(value);
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw refused();
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== "54329" ||
    database !== "dfs_ev_test" ||
    user !== "dfs_ev_test" ||
    password !== "dfs_ev_test" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw refused();
  }

  // Pass explicit fields to pg; do not let a connection-string parser or
  // ambient PG* variables override the validated target. Avoid localhost DNS.
  return {
    host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: 54329,
    database,
    user,
    password,
    ssl: false as const,
    application_name: "dfs-ev-test",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  };
}
