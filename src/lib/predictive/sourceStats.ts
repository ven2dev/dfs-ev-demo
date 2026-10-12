import type { SourceRow } from "./sourceAdapters.ts";
import { sourceInteger } from "./sourceAdapters.ts";
import type { MissingReason, SeasonType, StatField } from "./types.ts";
import { STAT_FIELDS } from "./types.ts";
import { canonical, digest, refuse, TEAM_IDS } from "./validation.ts";

export const SOURCE_STATS_VERSION = "nflverse-raw-stats-v1";
export const SOURCE_STAT_COLUMNS = {
  attempts: "attempts", completions: "completions", passingYards: "passing_yards", passingTds: "passing_tds",
  passingInterceptions: "passing_interceptions", carries: "carries", rushingYards: "rushing_yards",
  targets: "targets", receptions: "receptions", receivingYards: "receiving_yards",
} as const satisfies Record<StatField, string>;
export type SourceStatsFeed = "player" | "team";
// Typed source claims, not canonical observations. Explicit bridge revisions,
// capture provenance and correction lineage must still be bound before SQL use.
export type SourceStats = {
  version: typeof SOURCE_STATS_VERSION; feed: SourceStatsFeed;
  rawGameId: string; rawTeam: string; rawOpponent: string; rawPlayerId: string | null;
  playerIdProvider: "gsis" | null;
  season: number; seasonType: SeasonType; week: number;
  values: Record<StatField, number | null>; missing: Partial<Record<StatField, MissingReason>>;
};
const teams = new Set(TEAM_IDS.map((id) => id.slice("nfl:team:".length)));
export const sourceSeasonType = (row: SourceRow): SeasonType | null => {
  const type = row.season_type || row.game_type;
  if (row.season_type && row.game_type && row.season_type !== row.game_type) return null;
  return type === "REG" || type === "POST" ? type : null;
};
export const sourceStatsKey = (row: SourceRow, player = true) => canonical([row.game_id, row.team, ...(player ? [row.player_id] : [])]);
export const indexSourceRows = (rows: SourceRow[], identify: (row: SourceRow) => string) => {
  const map = new Map<string, SourceRow>(); const conflicts = new Set<string>();
  const fingerprints = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = identify(row); const previous = map.get(key);
    const encoded = canonical(row); const prior = previous && canonical(previous);
    if (prior && prior !== encoded) conflicts.add(key);
    // The representative is diagnostic only when the key conflicts. Choose it
    // deterministically and retain every distinct selected-row fingerprint.
    if (!prior || encoded < prior) map.set(key, row);
    const hashes = fingerprints.get(key) ?? new Set<string>(); hashes.add(digest(encoded)); fingerprints.set(key, hashes);
  }
  return { map, conflicts, fingerprints };
};
export const projectSourceStats = (feed: SourceStatsFeed, row: SourceRow): SourceStats => {
  if (feed !== "player" && feed !== "team") refuse("source-stats-feed-refused");
  const season = sourceInteger(row.season, 1920, 9999), week = sourceInteger(row.week, 1, 22), seasonType = sourceSeasonType(row);
  const parts = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(row.game_id);
  if (season === null || week === null || !seasonType || !parts || Number(parts[1]) !== season || Number(parts[2]) !== week ||
      !teams.has(row.team) || !teams.has(row.opponent_team) || row.team === row.opponent_team ||
      !teams.has(parts[3]) || !teams.has(parts[4]) || parts[3] === parts[4] ||
      ![parts[3], parts[4]].includes(row.team) || ![parts[3], parts[4]].includes(row.opponent_team)) refuse("source-stats-context-refused");
  if (feed === "player" && !/^00-\d{7}$/.test(row.player_id)) refuse("source-stats-player-refused");
  const values = {} as SourceStats["values"]; const missing: SourceStats["missing"] = {};
  for (const field of STAT_FIELDS) {
    const raw = row[SOURCE_STAT_COLUMNS[field]];
    if (raw === undefined) { values[field] = null; missing[field] = "source-missing"; }
    else {
      values[field] = sourceInteger(raw, field.endsWith("Yards") ? -10_000 : 0, field.endsWith("Yards") ? 10_000 : 1000);
      if (values[field] === null) missing[field] = "source-blank";
    }
  }
  if ((values.completions !== null && values.attempts !== null && values.completions > values.attempts) ||
      (values.receptions !== null && values.targets !== null && values.receptions > values.targets)) refuse("source-stats-denominator-refused");
  return { version: SOURCE_STATS_VERSION, feed, rawGameId: row.game_id, rawTeam: row.team, rawOpponent: row.opponent_team,
    rawPlayerId: feed === "player" ? row.player_id : null, playerIdProvider: feed === "player" ? "gsis" : null, season, seasonType, week, values, missing };
};
export const sourceStatsDigest = (stats: SourceStats) => digest(canonical(stats));
export const hasPositiveSourceUsage = (stats: SourceStats) =>
  stats.feed === "player" && [stats.values.attempts, stats.values.carries, stats.values.targets].some((value) => value !== null && value > 0);
