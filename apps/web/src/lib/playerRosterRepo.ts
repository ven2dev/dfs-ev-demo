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
  // Resolve the latest timestamp and its candidates in one statement.
  // Under Postgres READ COMMITTED, one statement observes one snapshot;
  // a concurrent roster upsert therefore cannot move every row from the
  // timestamp read in one round trip before a second round trip uses it.
  // The LEFT JOIN retains the snapshot marker even when there are no
  // candidates for these teams, preserving "no roster" (503) versus
  // "roster exists, no match" (422).
  const rows = (await getSql().query(
    `WITH latest_snapshot AS (
       SELECT MAX(source_updated_at) AS source_updated_at
       FROM nflverse_roster_players
       WHERE season = $1
     )
     SELECT
       latest_snapshot.source_updated_at,
       roster.player_id,
       roster.full_name,
       roster.first_name,
       roster.last_name,
       roster.football_name,
       roster.team,
       roster.position
     FROM latest_snapshot
     LEFT JOIN nflverse_roster_players AS roster
       ON roster.season = $1
      AND roster.source_updated_at = latest_snapshot.source_updated_at
      AND roster.team = ANY($2::text[])`,
    [season, [...teams]]
  )) as {
    source_updated_at: string | null;
    player_id: string | null;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    football_name: string | null;
    team: string | null;
    position: string | null;
  }[];
  if (!rows[0]?.source_updated_at) throw new RosterSnapshotUnavailableError(season);

  return rows.flatMap((row) =>
    row.player_id &&
    row.full_name &&
    row.first_name &&
    row.last_name &&
    row.team &&
    row.position
      ? [
          {
            playerId: row.player_id,
            fullName: row.full_name,
            firstName: row.first_name,
            lastName: row.last_name,
            footballName: row.football_name,
            team: row.team,
            position: row.position,
          },
        ]
      : []
  );
};
