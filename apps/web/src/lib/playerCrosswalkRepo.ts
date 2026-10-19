import "server-only";

import { getSql } from "./db";
import {
  resolvePlayerCrosswalk,
  type CrosswalkEntry,
  type PlayerResolutionContext,
} from "./playerCrosswalk";
import type { PlayerIdentityCandidate } from "./playerIdentityMatcher";
import { getLatestRosterCandidates } from "./playerRosterRepo";

const readCrosswalk = async (oddsPlayerName: string): Promise<CrosswalkEntry | null> => {
  const rows = (await getSql().query(
    `SELECT nflverse_player_id, nflverse_player_name
     FROM player_crosswalk
     WHERE odds_api_name = $1`,
    [oddsPlayerName]
  )) as { nflverse_player_id: string; nflverse_player_name: string }[];
  const row = rows[0];
  return row
    ? { playerId: row.nflverse_player_id, playerName: row.nflverse_player_name }
    : null;
};

const insertCrosswalkIfAbsent = async (
  oddsPlayerName: string,
  candidate: PlayerIdentityCandidate
): Promise<void> => {
  await getSql().query(
    `INSERT INTO player_crosswalk (
       odds_api_name, nflverse_player_id, nflverse_player_name
     )
     VALUES ($1, $2, $3)
     ON CONFLICT (odds_api_name) DO NOTHING`,
    [oddsPlayerName, candidate.playerId, candidate.fullName]
  );
};

export const getOrCreatePlayerCrosswalk = (
  oddsPlayerName: string,
  context: PlayerResolutionContext
): Promise<CrosswalkEntry | null> =>
  resolvePlayerCrosswalk(oddsPlayerName, context, {
    readCrosswalk,
    readRosterCandidates: getLatestRosterCandidates,
    insertCrosswalkIfAbsent,
  });
