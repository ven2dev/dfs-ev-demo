import "server-only";

import { getSql } from "./db";
import type { RosterPlayerRow } from "./nflverseRosterSync";
import type { PlayerIdentityCandidate } from "./playerIdentityMatcher";

const ROSTER_COLUMNS = [
  "season",
  "player_id",
  "full_name",
  "first_name",
  "last_name",
  "football_name",
  "team",
  "position",
  "status",
  "source_updated_at",
] as const;

export class RosterSnapshotUnavailableError extends Error {
  constructor(season: number) {
    super(`No synchronized nflverse roster snapshot is available for ${season}`);
    this.name = "RosterSnapshotUnavailableError";
  }
}

// One current-season roster is comfortably below Postgres's parameter
// ceiling (10 values per player). Keeping it in one statement makes the
// new source_updated_at visible atomically: a failed write can never
// leave a partial snapshot that candidate reads mistake for complete.
export const upsertRosterPlayers = async (rows: RosterPlayerRow[]): Promise<void> => {
  if (rows.length === 0) return;
  const valuesSql = rows
    .map(
      (_, rowIndex) =>
        `(${ROSTER_COLUMNS.map(
          (_column, columnIndex) => `$${rowIndex * ROSTER_COLUMNS.length + columnIndex + 1}`
        ).join(", ")})`
    )
    .join(", ");
  const params = rows.flatMap((row) => [
    row.season,
    row.playerId,
    row.fullName,
    row.firstName,
    row.lastName,
    row.footballName,
    row.team,
    row.position,
    row.status,
    row.sourceUpdatedAt,
  ]);

  await getSql().query(
    `INSERT INTO nflverse_roster_players (${ROSTER_COLUMNS.join(", ")})
     VALUES ${valuesSql}
     ON CONFLICT (season, player_id)
     DO UPDATE SET
       full_name = EXCLUDED.full_name,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       football_name = EXCLUDED.football_name,
       team = EXCLUDED.team,
       position = EXCLUDED.position,
       status = EXCLUDED.status,
       source_updated_at = EXCLUDED.source_updated_at,
       synced_at = now()`,
    params
  );
};

export const getLatestRosterCandidates = async (
  season: number,
  teams: readonly string[]
): Promise<PlayerIdentityCandidate[]> => {
  const sql = getSql();
  const snapshotRows = (await sql.query(
    `SELECT MAX(source_updated_at) AS source_updated_at
     FROM nflverse_roster_players
     WHERE season = $1`,
    [season]
  )) as { source_updated_at: string | null }[];
  const sourceUpdatedAt = snapshotRows[0]?.source_updated_at;
  if (!sourceUpdatedAt) throw new RosterSnapshotUnavailableError(season);

  const rows = (await sql.query(
    `SELECT player_id, full_name, first_name, last_name, football_name, team, position
     FROM nflverse_roster_players
     WHERE season = $1
       AND source_updated_at = $2
       AND team = ANY($3::text[])`,
    [season, sourceUpdatedAt, [...teams]]
  )) as {
    player_id: string;
    full_name: string;
    first_name: string;
    last_name: string;
    football_name: string | null;
    team: string;
    position: string;
  }[];

  return rows.map((row) => ({
    playerId: row.player_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    footballName: row.football_name,
    team: row.team,
    position: row.position,
  }));
};
