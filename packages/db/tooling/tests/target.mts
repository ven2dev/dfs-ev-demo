import type { ClientConfig } from "pg";

// Only the disposable database's public test credentials belong here.
// Never load an application .env file or fall back to DATABASE_URL.
const lane = (project: string, port: number) => Object.freeze({
  project, port, url: `postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:${port}/dfs_ev_test`,
});
const lanes = {
  default: lane("dfs-ev-demo-test", 54329),
  "lane-2": lane("dfs-ev-demo-test-lane-2", 54339),
  "lane-3": lane("dfs-ev-demo-test-lane-3", 54349),
  "lane-4": lane("dfs-ev-demo-test-lane-4", 54359),
};
export const LOCAL_TEST_DATABASE_URL = lanes.default.url;

export const getTestDatabaseLane = (selector = "default") => {
  if (!Object.hasOwn(lanes, selector)) throw new Error("Unknown DB_TEST_LANE. Use default, lane-2, lane-3 or lane-4.");
  return lanes[selector as keyof typeof lanes];
};

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

export function parseTestDatabaseUrl(value: string | undefined, selector = process.env.DB_TEST_LANE ?? "default") {
  const selected = getTestDatabaseLane(selector);
  if (!value) throw new Error("TEST_DATABASE_URL is required; DB tests cannot be skipped.");

  // Errors deliberately never include the supplied URL.
  const refused = () => new Error(
    "TEST_DATABASE_URL must target the disposable loopback dfs_ev_test database for the selected DB_TEST_LANE with its throwaway credentials and no URL options."
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
    url.port !== String(selected.port) ||
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
    port: selected.port,
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

export const parseReplayDatabaseTarget = (environment: NodeJS.ProcessEnv) => {
  assertNoApplicationCredentials(environment);
  if (environment.DB_TEST_LANE !== "lane-2" || environment.DB_TEST_TIER !== "large") {
    throw new Error("Replay requires the registered lane-2 large fixture.");
  }
  return parseTestDatabaseUrl(environment.TEST_DATABASE_URL, environment.DB_TEST_LANE);
};

export const assertReplayScratchTarget = (
  environment: NodeJS.ProcessEnv,
  config: ClientConfig,
  assertRegistered: (config: ClientConfig) => void,
): void => {
  const base = parseReplayDatabaseTarget(environment);
  if (!/^dfs_ev_test_[a-f0-9]{20}$/.test(config.database ?? "") ||
      Object.entries(base).some(([key, value]) => key !== "database" && config[key as keyof typeof base] !== value)) {
    throw new Error("Replay scratch target refused.");
  }
  assertRegistered(config);
};
