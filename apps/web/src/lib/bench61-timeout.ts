import { neon } from "@neondatabase/serverless";

// Functional probes only. No timing distributions or performance workload.
export const timeoutRole = "bench61_http_timeout_20261022";
type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const requireTrue = (ok: boolean, reason: string) => { if (!ok) throw new Error(reason); };
export const proveServerCancellation = async (query: Query, statement: string, params: unknown[] = []) => {
  try { await query(statement, params); }
  catch (error) {
    const e = error as {code?: string; message?: string};
    requireTrue(e.code === "57014" && /statement timeout/i.test(e.message ?? ""),
      "Expected PostgreSQL statement timeout, not client abort or generic cancellation");
    return;
  }
  throw new Error("Server failed to cancel finite statement");
};

export const qualifyHttpTimeout = async (
  url: string, host: string, database: string,
  context: {schema: string; owner: string; request: string},
  observe: Query,
) => {
  const parsed = new URL(url);
  requireTrue(parsed.hostname === host && decodeURIComponent(parsed.username) === timeoutRole
    && decodeURIComponent(parsed.pathname.slice(1)) === database,
  "Dedicated benchmark credential identity mismatch");
  // The caller owns the fixed quoted schema; never accept request-supplied SQL identifiers.
  requireTrue(context.schema === '"bench61_206_20261022"', "Unexpected synthetic schema");
  const sql = neon(url);
  let roundTrips = 0;
  const query: Query = async (text, params = []) => {
    requireTrue(++roundTrips <= 20, "Functional probe round-trip cap");
    return await sql.query(text, params, {fetchOptions: {signal: AbortSignal.timeout(10000)}});
  };
  const identitySql = `SELECT session_user,current_user,current_database() AS database,
    current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
    current_setting('transaction_isolation') AS isolation,pg_backend_pid() AS pid`;
  const identities: Record<string, unknown>[] = [];
  const identity = async () => {
    const [r] = await query(identitySql);
    requireTrue(r.session_user === timeoutRole && r.current_user === timeoutRole && r.database === database
      && r.statement === "5s" && r.lock === "2s" && r.isolation === "read committed",
    "Effective login defaults differ from qualified policy");
    identities.push(r);
  };
  await identity(); await identity();
  // All started requests are drained before any error escapes.
  const concurrent = await Promise.allSettled(Array.from({length: 3}, identity));
  const failed = concurrent.find(r => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  await proveServerCancellation(query, "SELECT pg_sleep(6)");
  const before = await observe(`SELECT balance FROM ${context.schema}.budgets WHERE account='timeout-proof'`);
  requireTrue(before.length === 1, "Missing synthetic timeout-proof account");
  const debit = `WITH guard AS MATERIALIZED (SELECT ${context.schema}.guard($1,$2,false)),
    debit AS (UPDATE ${context.schema}.budgets SET balance=balance-3 FROM guard
      WHERE account='timeout-proof' AND active AND balance-3>=floor RETURNING balance)
    SELECT balance,pg_sleep(6) FROM debit`;
  await proveServerCancellation(query, debit, [context.owner,context.request]);
  const after = await observe(`SELECT balance FROM ${context.schema}.budgets WHERE account='timeout-proof'`);
  requireTrue(after.length === 1 && after[0].balance === before[0].balance,
    "Cancelled implicit transaction changed the balance");
  await identity();
  return {qualification:"partial: HTTP defaults, finite statement cancellation and debit rollback only",
    identities,serverStatementCancellation:true,debitRolledBack:true,
    roundTrips,statements:roundTrips,performanceEnabled:false,
    remaining:["HTTP lock cancellation", "concurrent cleanup fencing", "effective privilege audit"]};
};
