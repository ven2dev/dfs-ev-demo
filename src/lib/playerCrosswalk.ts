import {
  matchPlayerIdentity,
  type PlayerIdentityCandidate,
} from "./playerIdentityMatcher";

export type CrosswalkEntry = {
  playerId: string;
  playerName: string;
};

export type PlayerResolutionContext = {
  season: number;
  eventTeams: readonly string[];
  marketKey: string;
};

export type PlayerCrosswalkDeps = {
  readCrosswalk: (oddsPlayerName: string) => Promise<CrosswalkEntry | null>;
  readRosterCandidates: (
    season: number,
    eventTeams: readonly string[]
  ) => Promise<PlayerIdentityCandidate[]>;
  insertCrosswalkIfAbsent: (
    oddsPlayerName: string,
    candidate: PlayerIdentityCandidate
  ) => Promise<void>;
};

export const resolvePlayerCrosswalk = async (
  oddsPlayerName: string,
  context: PlayerResolutionContext,
  deps: PlayerCrosswalkDeps
): Promise<CrosswalkEntry | null> => {
  const cached = await deps.readCrosswalk(oddsPlayerName);
  if (cached) return cached;

  const candidates = await deps.readRosterCandidates(context.season, context.eventTeams);
  const match = matchPlayerIdentity(
    oddsPlayerName,
    context.marketKey,
    context.eventTeams,
    candidates
  );
  if (!match) return null;

  await deps.insertCrosswalkIfAbsent(oddsPlayerName, match);

  // Re-read instead of returning the local match. A concurrent request
  // or explicit manual override may have won the unique-name insert;
  // the database row is authoritative in either case.
  const persisted = await deps.readCrosswalk(oddsPlayerName);
  if (!persisted) {
    throw new Error("Crosswalk insert completed without a readable row");
  }
  return persisted;
};
