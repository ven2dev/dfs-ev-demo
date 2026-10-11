import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { RAW_ALLOWLISTS, canonical, digest, easternKickoff, refuse } from "./validation.ts";
import { SOURCE_HEADERS } from "./sourceHeaders.ts";

export type SourceFeed = keyof typeof SOURCE_HEADERS;
export type SourceRow = Record<string, string>;
export const SOURCE_PROFILE_VERSION = "nflverse-csv-qualification-v1";
export const SOURCE_SAMPLE_SEASON = 2026;
export const SOURCE_FEEDS = Object.keys(SOURCE_HEADERS) as SourceFeed[];
const releaseTags: Record<SourceFeed, string> = { player: "stats_player", team: "stats_team", schedule: "schedules",
  identifiers: "players", roster: "weekly_rosters", injuries: "injuries", depth: "depth_charts" };
export const sourceAsset = (feed: SourceFeed, season: number) => {
  if (!SOURCE_FEEDS.includes(feed) || season !== SOURCE_SAMPLE_SEASON) refuse("source-scope-refused");
  const names: Record<SourceFeed, string> = { player: `stats_player_week_${season}.csv`, team: `stats_team_week_${season}.csv`,
    schedule: "games.csv", identifiers: "players.csv", roster: `roster_weekly_${season}.csv`,
    injuries: `injuries_${season}.csv`, depth: `depth_charts_${season}.csv` };
  const tag = releaseTags[feed]; const name = names[feed];
  return { tag, name, metadataUrl: `https://api.github.com/repos/nflverse/nflverse-data/releases/tags/${tag}`,
    url: `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${name}` };
};
export const validateSourceHeader = (feed: SourceFeed, header: string[]) => {
  if (!SOURCE_FEEDS.includes(feed) || canonical(header) !== canonical(SOURCE_HEADERS[feed])) refuse("source-header-drift");
  return digest(canonical(header));
};

// Full raw bases remain private. Only the documented selected columns survive
// parsing. A known excluded column is never imported through a SELECT * path.
export const parseSourceCsv = async (feed: SourceFeed, bytes: string, maxRows: number) => {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 80_000) refuse("source-row-bound-refused");
  let headerSha256 = "";
  const allowed: readonly string[] = RAW_ALLOWLISTS[feed];
  const parser = parse({ bom: true, skip_empty_lines: true, max_record_size: 65_536,
    columns: (header: string[]) => {
      headerSha256 = validateSourceHeader(feed, header);
      return header.map((column) => allowed.includes(column) ? column : false);
    } });
  const stream = Readable.from([bytes]).pipe(parser);
  const rows: SourceRow[] = [];
  try {
    for await (const row of stream) {
      if (rows.length === maxRows) refuse("source-row-budget-exceeded");
      rows.push(row as SourceRow);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("source-")) throw error;
    refuse("source-csv-refused");
  } finally { stream.destroy(); }
  if (!headerSha256 || !rows.length) refuse("source-empty-csv");
  return { rows, headerSha256, selectedColumns: SOURCE_HEADERS[feed].filter((column) => allowed.includes(column)),
    excludedColumns: SOURCE_HEADERS[feed].filter((column) => !allowed.includes(column)) };
};

export const sourceInteger = (value: string, minimum: number, maximum: number) => {
  if (value === "" || value === "NA") return null;
  if (!/^-?\d+$/.test(value)) refuse("source-number-refused");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) refuse("source-number-refused");
  return number;
};

// gametime is Eastern time, regardless of venue. Enumerating both possible
// offsets and round-tripping through IANA refuses missing or repeated DST times.
// Shared with the schedule evidence validator so both use one conversion.
export { easternKickoff };
