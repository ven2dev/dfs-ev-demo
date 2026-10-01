import { getPlayerPropMarket } from "./playerPropMarkets";

export type PlayerIdentityCandidate = {
  playerId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  footballName: string | null;
  team: string;
  position: string;
};

export type PlayerIdentityMatch = PlayerIdentityCandidate & {
  confidence: number;
  matchedAlias: string;
};

const MIN_CONFIDENCE = 0.94;
const MIN_RUNNER_UP_GAP = 0.04;
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const nameTokens = (value: string): string[] => {
  const tokens = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens;
};

const compactName = (value: string): string => nameTokens(value).join("");

const jaroWinkler = (left: string, right: string): number => {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const distance = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatches = Array.from({ length: left.length }, () => false);
  const rightMatches = Array.from({ length: right.length }, () => false);
  let matches = 0;

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const start = Math.max(0, leftIndex - distance);
    const end = Math.min(leftIndex + distance + 1, right.length);
    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      if (rightMatches[rightIndex] || left[leftIndex] !== right[rightIndex]) continue;
      leftMatches[leftIndex] = true;
      rightMatches[rightIndex] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  const matchedLeft = [...left].filter((_character, index) => leftMatches[index]);
  const matchedRight = [...right].filter((_character, index) => rightMatches[index]);
  const transpositions =
    matchedLeft.filter((character, index) => character !== matchedRight[index]).length / 2;
  const jaro =
    (matches / left.length +
      matches / right.length +
      (matches - transpositions) / matches) /
    3;

  let prefixLength = 0;
  while (
    prefixLength < Math.min(4, left.length, right.length) &&
    left[prefixLength] === right[prefixLength]
  ) {
    prefixLength += 1;
  }
  return jaro + prefixLength * 0.1 * (1 - jaro);
};

const aliasesFor = (candidate: PlayerIdentityCandidate): string[] => {
  const aliases = new Set([
    candidate.fullName,
    `${candidate.firstName} ${candidate.lastName}`,
  ]);
  if (candidate.footballName) {
    aliases.add(`${candidate.footballName} ${candidate.lastName}`);
  }
  return Array.from(aliases);
};

const scoreAlias = (oddsName: string, alias: string): number => {
  const queryCompact = compactName(oddsName);
  const aliasCompact = compactName(alias);
  if (queryCompact === aliasCompact) return 1;

  const queryTokens = nameTokens(oddsName);
  const aliasTokens = nameTokens(alias);
  if (
    queryTokens.length === 2 &&
    queryTokens[0].length === 1 &&
    aliasTokens.length >= 2 &&
    queryTokens[0] === aliasTokens[0][0] &&
    queryTokens[1] === aliasTokens[aliasTokens.length - 1]
  ) {
    return 0.96;
  }

  return jaroWinkler(queryCompact, aliasCompact);
};

export const matchPlayerIdentity = (
  oddsPlayerName: string,
  marketKey: string,
  eventTeams: readonly string[],
  candidates: readonly PlayerIdentityCandidate[]
): PlayerIdentityMatch | null => {
  const market = getPlayerPropMarket(marketKey);
  // Identity resolution is allowed only for markets whose registry
  // explicitly defines compatible roster positions. Unknown and
  // positionless markets fail closed instead of silently dropping this
  // disambiguation layer.
  if (!market?.compatibleRosterPositions) return null;
  const allowedPositions = new Set<string>(market.compatibleRosterPositions);
  const eventTeamSet = new Set(eventTeams);

  const scored = candidates
    .filter((candidate) => eventTeamSet.has(candidate.team))
    .filter((candidate) => allowedPositions.has(candidate.position))
    .map((candidate) => {
      let confidence = 0;
      let matchedAlias = candidate.fullName;
      for (const alias of aliasesFor(candidate)) {
        const score = scoreAlias(oddsPlayerName, alias);
        if (score > confidence) {
          confidence = score;
          matchedAlias = alias;
        }
      }
      return { ...candidate, confidence, matchedAlias };
    })
    .sort((left, right) => right.confidence - left.confidence);

  const best = scored[0];
  if (!best || best.confidence < MIN_CONFIDENCE) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.confidence - runnerUp.confidence < MIN_RUNNER_UP_GAP) {
    return null;
  }
  return best;
};
