import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

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

export const proveServerLockCancellation = async (query: Query, statement: string, params: unknown[] = []) => {
  try { await query(statement, params); }
  catch (error) {
    const e = error as {code?: string; message?: string};
    requireTrue(e.code === "55P03" && /lock timeout/i.test(e.message ?? ""),
      "Expected PostgreSQL lock timeout, not NOWAIT, statement or client cancellation");
    return;
  }
  throw new Error("Server failed to cancel blocked statement");
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
  requireTrue(['"bench61_206_20261022"', '"bench61_http_role_20261022"'].includes(context.schema), "Unexpected synthetic schema");
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
  const nonce=randomUUID();
  const [marked]=await query("SELECT set_config('bench61.probe_nonce',$1,true) AS nonce,pg_backend_pid() AS pid",[nonce]);
  requireTrue(marked.nonce===nonce,"Session-isolation marker was not installed");
  let reused=false;
  for(let i=0;i<5;i++) {
    const [next]=await query("SELECT current_setting('bench61.probe_nonce',true) AS nonce,pg_backend_pid() AS pid");
    requireTrue(next.nonce!==nonce,"Transaction-local state leaked into another HTTP request");
    if(next.pid===marked.pid){reused=true;break;}
  }
  requireTrue(reused,"Backend reuse was not observed within the finite qualification limit");
  const statementStart=performance.now();
  await proveServerCancellation(query, "SELECT pg_sleep(6)");
  const statementProbeMs=performance.now()-statementStart;
  const before = await observe(`SELECT balance FROM ${context.schema}.budgets WHERE account='timeout-proof'`);
  requireTrue(before.length === 1, "Missing synthetic timeout-proof account");
  const debit = `WITH guard AS MATERIALIZED (SELECT ${context.schema}.guard($1,$2,false)),
    debit AS (UPDATE ${context.schema}.budgets SET balance=balance-3 FROM guard
      WHERE account='timeout-proof' AND active AND balance-3>=floor RETURNING balance)
    SELECT balance,pg_sleep(6) FROM debit`;
  const debitStart=performance.now();
  await proveServerCancellation(query, debit, [context.owner,context.request]);
  const debitRollbackProbeMs=performance.now()-debitStart;
  const after = await observe(`SELECT balance FROM ${context.schema}.budgets WHERE account='timeout-proof'`);
  requireTrue(after.length === 1 && after[0].balance === before[0].balance,
    "Cancelled implicit transaction changed the balance");
  await identity();
  return {qualification:"partial: HTTP defaults, finite statement cancellation and debit rollback only",
    identities,serverStatementCancellation:true,debitRolledBack:true,transactionStateIsolatedOnReusedBackend:true,
    backendReuse:{markerPid:marked.pid,reused},statementProbeMs,debitRollbackProbeMs,
    roundTrips,statements:roundTrips,performanceEnabled:false,
    remaining:["HTTP lock cancellation", "concurrent cleanup fencing", "effective privilege audit"]};
};
