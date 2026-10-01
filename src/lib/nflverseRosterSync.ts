// Pure roster synchronization orchestration. Network and Postgres
// implementations are injected so timestamp/idempotency behavior can be
// verified without touching either external system.

export const NFLVERSE_ROSTER_SOURCE = "nflverse_roster";

export type NflverseRosterRow = {
  season: string;
  team: string;
  position: string;
  status: string;
  full_name: string;
  first_name: string;
  last_name: string;
  football_name?: string;
  gsis_id: string;
};

export type RosterPlayerRow = {
  season: number;
  playerId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  footballName: string | null;
  team: string;
  position: string;
  status: string;
  sourceUpdatedAt: string;
};

export type SyncNflverseRosterDeps = {
  fetchRosterReleaseUpdatedAt: () => Promise<string>;
  fetchRosterRows: () => Promise<NflverseRosterRow[]>;
  readSyncState: (sourceName: string) => Promise<string | null>;
  writeSyncState: (sourceName: string, updatedAt: string) => Promise<void>;
  upsertRosterPlayers: (rows: RosterPlayerRow[]) => Promise<void>;
};

export type SyncNflverseRosterResult =
  | { status: "up-to-date" }
  | { status: "synced"; rowsUpserted: number };

const sameInstant = (a: string | null, b: string): boolean =>
  a !== null && new Date(a).getTime() === new Date(b).getTime();

export const syncNflverseRoster = async (
  deps: SyncNflverseRosterDeps
): Promise<SyncNflverseRosterResult> => {
  const sourceUpdatedAt = await deps.fetchRosterReleaseUpdatedAt();
  const lastSyncedAt = await deps.readSyncState(NFLVERSE_ROSTER_SOURCE);
  if (sameInstant(lastSyncedAt, sourceUpdatedAt)) {
    return { status: "up-to-date" };
  }

  const rawRows = await deps.fetchRosterRows();
  const playersById = new Map<string, RosterPlayerRow>();

  for (const row of rawRows) {
    const season = Number(row.season);
    if (
      !Number.isInteger(season) ||
      !row.gsis_id ||
      !row.full_name ||
      !row.first_name ||
      !row.last_name ||
      !row.team ||
      !row.position
    ) {
      continue;
    }

    playersById.set(row.gsis_id, {
      season,
      playerId: row.gsis_id,
      fullName: row.full_name,
      firstName: row.first_name,
      lastName: row.last_name,
      footballName: row.football_name || null,
      team: row.team,
      position: row.position,
      status: row.status || "UNKNOWN",
      sourceUpdatedAt,
    });
  }

  const players = Array.from(playersById.values());
  if (players.length === 0) {
    throw new Error("nflverse roster contained no usable player identities");
  }

  await deps.upsertRosterPlayers(players);
  await deps.writeSyncState(NFLVERSE_ROSTER_SOURCE, sourceUpdatedAt);
  return { status: "synced", rowsUpserted: players.length };
};
