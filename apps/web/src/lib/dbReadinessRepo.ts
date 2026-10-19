import "server-only";

import { getSql } from "./db";
import { DB_READINESS_MANIFEST } from "./dbReadinessManifest";
import { DB_READINESS_DEADLINE_MS, DB_READINESS_HISTORY_LIMIT, DB_READINESS_HISTORY_SQL,
  DB_READINESS_RELATIONS_SQL, DB_READINESS_SETTINGS_SQL, readinessRelations,
  type DatabaseReadinessSnapshot } from "./dbReadiness";

export async function getDatabaseReadinessSnapshot(): Promise<DatabaseReadinessSnapshot> {
  const sql = getSql();
  const options = { readOnly: true, isolationLevel: "RepeatableRead" as const,
    fetchOptions: { signal: AbortSignal.timeout(DB_READINESS_DEADLINE_MS) } };
  const tables = [...DB_READINESS_MANIFEST.requiredTables, "db_migrations"];
  // Probe first so an absent ledger never requires SELECT from a missing table.
  const [, probe] = await sql.transaction((tx) => [
    tx.query(DB_READINESS_SETTINGS_SQL), tx.query(DB_READINESS_RELATIONS_SQL, [tables]),
  ], options);
  const state = readinessRelations(probe as { name: string; present: boolean }[]);
  if (!state.ledgerPresent) return { ...state, history: [] };
  // Read relations and history in one snapshot; recheck after the probe to fail
  // closed if concurrent DDL removes/replaces a required relation.
  const [, relations, history] = await sql.transaction((tx) => [
    tx.query(DB_READINESS_SETTINGS_SQL), tx.query(DB_READINESS_RELATIONS_SQL, [tables]),
    tx.query(DB_READINESS_HISTORY_SQL, [DB_READINESS_HISTORY_LIMIT + 1]),
  ], options);
  return { ...readinessRelations(relations as { name: string; present: boolean }[]), history };
}
