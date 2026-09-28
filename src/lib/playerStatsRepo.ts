import "server-only";

import { getSql } from "./db";
import type { PlayerGameStatRow } from "./playerStatsSync";

export const readSyncState = async (sourceName: string): Promise<string | null> => {
  const sql = getSql();
  const rows = await sql.query(
    "SELECT last_synced_asset_updated_at FROM sync_state WHERE source_name = $1",
    [sourceName]
  );
  const row = rows[0] as { last_synced_asset_updated_at: string } | undefined;
  return row ? new Date(row.last_synced_asset_updated_at).toISOString() : null;
};

export const writeSyncState = async (sourceName: string, updatedAt: string): Promise<void> => {
  const sql = getSql();
  await sql.query(
    `INSERT INTO sync_state (source_name, last_synced_asset_updated_at, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (source_name)
     DO UPDATE SET last_synced_asset_updated_at = $2, updated_at = now()`,
    [sourceName, updatedAt]
  );
};

const COLUMNS = [
  "player_id",
  "player_name",
  "team",
  "opponent",
  "is_home",
  "season",
  "week",
  "game_date",
  "stat_type",
  "stat_value",
] as const;

// Postgres has a ~65535 bound-parameter limit per query -- batching
// keeps a large full-season sync correct regardless of row count,
// rather than assuming it'll always stay under some magic number.
const BATCH_SIZE = 500;

const upsertBatch = async (rows: PlayerGameStatRow[]): Promise<void> => {
  const sql = getSql();

  const valuesSql = rows
    .map(
      (_, i) =>
        `(${COLUMNS.map((_, j) => `$${i * COLUMNS.length + j + 1}`).join(", ")})`
    )
    .join(", ");
  const params = rows.flatMap((row) => [
    row.player_id,
    row.player_name,
    row.team,
    row.opponent,
    row.is_home,
    row.season,
    row.week,
    row.game_date,
    row.stat_type,
    row.stat_value,
  ]);

  await sql.query(
    `INSERT INTO player_game_stats (${COLUMNS.join(", ")})
     VALUES ${valuesSql}
     ON CONFLICT (player_id, season, week, stat_type)
     DO UPDATE SET
       player_name = EXCLUDED.player_name,
       team = EXCLUDED.team,
       opponent = EXCLUDED.opponent,
       is_home = EXCLUDED.is_home,
       game_date = EXCLUDED.game_date,
       stat_value = EXCLUDED.stat_value`,
    params
  );
};

export const upsertStats = async (rows: PlayerGameStatRow[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await upsertBatch(rows.slice(i, i + BATCH_SIZE));
  }
};
