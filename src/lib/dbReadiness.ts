import { DB_READINESS_MANIFEST } from "./dbReadinessManifest";

export const DB_READINESS_HISTORY_LIMIT = 1_024;
export const DB_READINESS_DEADLINE_MS = 5_000;
export const DB_READINESS_SETTINGS_SQL = `SELECT
  pg_catalog.set_config('statement_timeout', '2000', true),
  pg_catalog.set_config('lock_timeout', '1000', true)`;
export const DB_READINESS_RELATIONS_SQL = `SELECT name,
  COALESCE((SELECT relkind IN ('r', 'p') FROM pg_catalog.pg_class
    WHERE oid = pg_catalog.to_regclass('public.' || name)), false) AS present
  FROM pg_catalog.unnest($1::text[]) AS required(name)`;
export const DB_READINESS_HISTORY_SQL = `SELECT version, filename, sha256,
  runner_version, provenance, applied_at FROM public.db_migrations
  ORDER BY version LIMIT $1`;

export type DatabaseReadinessSnapshot = {
  ledgerPresent: boolean;
  requiredTablesPresent: boolean;
  history: unknown[];
};

export type DatabaseReadinessResult = {
  status: "ready" | "not-ready";
  schemaVersion: number | null;
  minimumVersion: number;
  maximumKnownVersion: number;
  reasons: string[];
  warnings: string[];
};

export function readinessRelations(rows: { name: string; present: boolean }[]) {
  const present = new Set(rows.filter((row) => row.present === true).map((row) => row.name));
  return { ledgerPresent: present.has("db_migrations"),
    requiredTablesPresent: DB_READINESS_MANIFEST.requiredTables.every((name) => present.has(name)) };
}

export function evaluateDatabaseReadiness(snapshot: DatabaseReadinessSnapshot): DatabaseReadinessResult {
  const { minimumVersion, maximumKnownVersion, runnerVersion, migrations } = DB_READINESS_MANIFEST;
  const result: DatabaseReadinessResult = { status: "not-ready", schemaVersion: null,
    minimumVersion, maximumKnownVersion, reasons: [], warnings: [] };
  const refuse = (reason: string) => ({ ...result, reasons: [reason] });
  if (!snapshot.ledgerPresent) return { ...refuse("migration-ledger-missing"), schemaVersion: 0 };
  const history = snapshot.history;
  if (history.length > DB_READINESS_HISTORY_LIMIT) return refuse("migration-history-limit-exceeded");
  if (!history.length) return refuse("migration-history-invalid");
  for (const [index, value] of history.entries()) {
    if (typeof value !== "object" || value === null) return refuse("migration-history-invalid");
    const row = value as Record<string, unknown>;
    const version = index + 1;
    const prefix = String(version).padStart(4, "0") + "_";
    const date = row.applied_at;
    if (row.version !== version || typeof row.filename !== "string" || !row.filename.startsWith(prefix) ||
        !/^[0-9]{4}_[a-z][a-z0-9_]*\.sql$/.test(row.filename) ||
        typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
        row.runner_version !== runnerVersion || !["adopted", "executed"].includes(String(row.provenance)) ||
        !(date instanceof Date ? Number.isFinite(date.getTime()) : typeof date === "string" && Number.isFinite(Date.parse(date)))) {
      return refuse("migration-history-invalid");
    }
    const known = migrations[index];
    if (known && (row.filename !== known.filename || row.sha256 !== known.sha256)) return refuse("migration-history-invalid");
  }
  result.schemaVersion = history.length;
  if (result.schemaVersion < minimumVersion) return refuse("schema-behind");
  if (!snapshot.requiredTablesPresent) return refuse("required-tables-missing");
  return { ...result, status: "ready", warnings: result.schemaVersion > maximumKnownVersion ? ["schema-ahead"] : [] };
}
