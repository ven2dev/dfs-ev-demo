import { Client } from "pg";
import { checkConnectedTarget } from "../scripts/db-migrations/core.mjs";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

// Session lock namespace for the disposable DB suite. The second key identifies
// the primary database on this cluster; workers share the parent's session lease.
const LOCK_NAMESPACE = 153045;
export class DatabaseTestRunActiveError extends Error {
  readonly code = "DB_TEST_RUN_ACTIVE";
  constructor() { super("another DB test run is active on this target"); }
}

export async function startDatabaseTestRun(environment: NodeJS.ProcessEnv) {
  assertNoApplicationCredentials(environment);
  const base = parseTestDatabaseUrl(environment.TEST_DATABASE_URL);
  const admin = new Client(base);
  const failure = new AbortController();
  admin.on("error", (cause: Error) => {
    if (!failure.signal.aborted) failure.abort(new Error("DB test run lock connection lost.", { cause }));
  });
  try {
    await admin.connect();
    await checkConnectedTarget(admin, base);
    const { rows } = await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, (SELECT oid::integer FROM pg_database WHERE datname=current_database())) AS acquired",
      [LOCK_NAMESPACE]);
    if (rows[0]?.acquired !== true) throw new DatabaseTestRunActiveError();
    // Literal prefix matching: LIKE would interpret the underscores as wildcards.
    const stale = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, 'dfs_ev_test_') ORDER BY datname");
    for (const { datname } of stale.rows) {
      await admin.query(`DROP DATABASE "${datname.replaceAll('"', '""')}" WITH (FORCE)`);
    }
    failure.signal.throwIfAborted();
    console.log(JSON.stringify({ staleDatabasesSwept: stale.rows.length }));
    return { failureSignal: failure.signal, close: () => admin.end() };
  } catch (error) {
    await admin.end();
    throw error;
  }
}
