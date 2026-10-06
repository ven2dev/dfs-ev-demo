import { collectCatalog } from "../db-catalog.mjs";
import { RUNNER_VERSION } from "./files.mjs";
import { refuse } from "./errors.mjs";

export const LOCK_NAMESPACE = 60604560;
export const LOCK_KEY = 1;
export const ledgerSql = `CREATE TABLE public.db_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  filename text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  runner_version integer NOT NULL CHECK (runner_version = 1),
  provenance text NOT NULL CHECK (provenance IN ('executed', 'adopted')),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function checkConnectedTarget(client, expected) {
  const { rows: [server] } = await client.query(
    "SELECT current_database() AS database, current_user AS role, current_setting('server_version_num')::integer AS version"
  );
  if (server.database !== expected.database || server.role !== expected.user) refuse("connected-target-mismatch");
  if (server.version < 180000 || server.version >= 190000) refuse("postgresql-18-required");
}

export function validateHistory(history, files) {
  if (!history.length || history.length > files.length) refuse("invalid-migration-history");
  for (const [index, row] of history.entries()) {
    const file = files[index];
    if (row.version !== file.version || row.filename !== file.filename ||
        row.sha256 !== file.sha256 || row.runner_version !== RUNNER_VERSION ||
        !["adopted", "executed"].includes(row.provenance) || !row.applied_at) refuse("invalid-migration-history");
  }
}

export async function readLedger(client, files) {
  const { rows: [state] } = await client.query("SELECT to_regclass('public.db_migrations') AS ledger");
  if (state.ledger === null) return null;
  const { rows } = await client.query("SELECT version, filename, sha256, runner_version, provenance, applied_at FROM public.db_migrations ORDER BY version");
  validateHistory(rows, files);
  return rows;
}

export async function configureTransaction(client) {
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
  // The static SQL guard treats ordinary strings with PostgreSQL's standard
  // quoting rules, independent of an inherited session setting.
  await client.query("SET LOCAL standard_conforming_strings = on");
  // Omitted pg_catalog is searched implicitly before public for lookup, while
  // unqualified CREATE targets public rather than the system catalog.
  await client.query("SET LOCAL search_path = public");
}

export async function readMigrationStatus(client, expected, files) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await configureTransaction(client);
    await checkConnectedTarget(client, expected);
    const history = await readLedger(client, files);
    await client.query("COMMIT");
    return { ledger: history === null ? "absent" : "valid", schemaVersion: history?.at(-1).version ?? 0,
      knownVersion: files.length, history: history ?? [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Shared boundary for scratch installation and fingerprint-approved adoption.
// This takes the lock before invoking any history/catalog reader or writer.
export async function withMigrationTransaction(client, expected, run) {
  await client.query("BEGIN");
  try {
    await configureTransaction(client);
    await checkConnectedTarget(client, expected);
    const { rows: [lock] } = await client.query("SELECT pg_try_advisory_xact_lock($1, $2) AS acquired", [LOCK_NAMESPACE, LOCK_KEY]);
    if (!lock.acquired) refuse("migration-lock-busy");
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function insertLedgerRow(client, file, provenance) {
  if (!["executed", "adopted"].includes(provenance)) refuse("invalid-migration-provenance");
  await client.query(`INSERT INTO public.db_migrations
    (version, filename, sha256, runner_version, provenance)
    VALUES ($1, $2, $3, $4, $5)`,
  [file.version, file.filename, file.sha256, RUNNER_VERSION, provenance]);
}

// Unapproved scratch bootstrap retains refusal of every unversioned nonempty
// catalog. Adoption is available only through the approved-plan engine.
export async function runScratchMigrations(client, { expected, files, assertTarget, verify }) {
  if (typeof assertTarget !== "function" || typeof verify !== "function") refuse("scratch-verifier-required");
  assertTarget(expected);
  return withMigrationTransaction(client, expected, async () => {
    let history = await readLedger(client, files);
    if (history === null) {
      if ((await collectCatalog(client)).objects.length) refuse("unversioned-schema-refused");
      await client.query(ledgerSql);
      history = [];
    }
    const pending = files.slice(history.length);
    for (const file of pending) {
      // Execute the entire reviewed multi-statement file on this session.
      await client.query(file.sql);
      await insertLedgerRow(client, file, "executed");
    }
    await verify(client, files.length);
    if ((await readLedger(client, files))?.length !== files.length) refuse("incomplete-migration-history");
    return { schemaVersion: files.length, executed: pending.map((file) => file.version) };
  });
}
