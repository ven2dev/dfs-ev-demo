import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { startDatabaseTestRun } from "@dfs-ev/db-tooling/test-support/lifecycle";
import { parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { certifyReplay, replayCodeIdentity } from "./replay-audit.ts";
import { readReplayBaseline } from "./replay-restore.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";

const run = async () => {
  const target = parseReplayDatabaseTarget(process.env);
  const { values } = parseArgs({ options: {
    root: { type: "string" }, receipt: { type: "string" }, "row-limit": { type: "string" },
  } });
  if (!values.root || !isAbsolute(values.root) || !values.receipt || !isAbsolute(values.receipt)) {
    throw new Error("replay-absolute-root-and-receipt-required");
  }
  let sourceUrl: URL;
  try { sourceUrl = new URL(process.env.FS244_SOURCE_DATABASE_URL ?? ""); }
  catch { throw new Error("replay-source-database-refused"); }
  if (!["postgres:", "postgresql:"].includes(sourceUrl.protocol) || sourceUrl.hostname !== target.host ||
      Number(sourceUrl.port) !== target.port || sourceUrl.pathname !== "/fs244_source" ||
      !sourceUrl.username || !sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new Error("replay-source-database-refused");
  }
  const code = await replayCodeIdentity();
  const baseline = await readReplayBaseline();
  const store = await openLocalObjectStore(values.root, { maxObjectBytes: 64 * 1024 ** 2 });
  const lease = await startDatabaseTestRun(process.env);
  const source = new Client({ host: target.host, port: target.port, database: "fs244_source",
    user: decodeURIComponent(sourceUrl.username), password: decodeURIComponent(sourceUrl.password),
    ssl: false, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 3_000,
    statement_timeout: 15_000 });
  try {
    const harness = fileURLToPath(new URL("../../../../scripts/db/test-db.mjs", import.meta.url));
    execFileSync(process.execPath, [harness, "preflight"], { stdio: "inherit" });
    await source.connect();
    const { rows: [role] } = await source.query<{ allowed: boolean }>(`
      SELECT pg_has_role(session_user,'fs138_reader','member')
        AND NOT pg_has_role(session_user,'fs138_pipeline_writer','member')
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS allowed
      FROM pg_roles WHERE rolname=session_user`);
    if (!role?.allowed) throw new Error("replay-source-reader-required");
    lease.failureSignal.throwIfAborted();
    const result = await certifyReplay({ source, store, code, receiptPath: values.receipt,
      rowLimit: values["row-limit"] === undefined ? undefined : Number(values["row-limit"]) }, baseline);
    console.log(JSON.stringify({ status: result.status, objects: result.normalized.verifiedObjects,
      normalizedRows: result.normalized.normalizedRows, contexts: result.derived.derivedParity.length }));
  } finally {
    try { await source.end(); }
    finally { await lease.close(); }
  }
};

try { await run(); }
catch (error) {
  const code = (error as NodeJS.ErrnoException)?.code;
  const detail = error instanceof Error ? error.message : "";
  const message = detail.startsWith("replay-") ? detail
    : code === "ENOENT" ? "replay-object-missing"
    : detail === "object-digest-mismatch" ? "replay-object-corrupt" : "replay-audit-failed";
  console.error(JSON.stringify({ status: "failed", reason: message }));
  process.exitCode = 1;
}
