import "server-only";

import { parse } from "csv-parse/sync";
import type { NflverseStatsRow, NflverseScheduleRow } from "./playerStatsSync";

const NFLVERSE_REPO = "nflverse/nflverse-data";

// NFL seasons are labeled by their start year; games run from ~September
// through the Super Bowl in February. Before March, "now" still belongs
// to the season that started the PREVIOUS calendar year.
export const getCurrentSeason = (now: Date = new Date()): number => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  return month >= 3 ? year : year - 1;
};

type GithubReleaseAsset = { name: string; updated_at: string };
type GithubRelease = { assets: GithubReleaseAsset[] };

const fetchReleaseAssetUpdatedAt = async (tag: string, assetName: string): Promise<string> => {
  const res = await fetch(`https://api.github.com/repos/${NFLVERSE_REPO}/releases/tags/${tag}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API request failed for tag "${tag}": ${res.status}`);
  }
  const release = (await res.json()) as GithubRelease;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`Asset "${assetName}" not found in release "${tag}"`);
  }
  return asset.updated_at;
};

// nflverse's CSV fields can contain embedded commas inside quoted values
// (e.g. headshot_url's "f_auto,q_auto/..." Cloudinary params) -- a real
// parser is required, naive splitting on "," would corrupt those rows.
const fetchCsvRows = async <T>(tag: string, assetName: string): Promise<T[]> => {
  const res = await fetch(
    `https://github.com/${NFLVERSE_REPO}/releases/download/${tag}/${assetName}`
  );
  if (!res.ok) {
    throw new Error(`Failed to download "${assetName}" from release "${tag}": ${res.status}`);
  }
  const csvText = await res.text();
  return parse(csvText, { columns: true, skip_empty_lines: true }) as T[];
};

const currentStatsAssetName = () => `stats_player_week_${getCurrentSeason()}.csv`;

export const fetchStatsReleaseUpdatedAt = (): Promise<string> =>
  fetchReleaseAssetUpdatedAt("stats_player", currentStatsAssetName());

export const fetchSchedulesReleaseUpdatedAt = (): Promise<string> =>
  fetchReleaseAssetUpdatedAt("schedules", "games.csv");

export const fetchStatsRows = (): Promise<NflverseStatsRow[]> =>
  fetchCsvRows<NflverseStatsRow>("stats_player", currentStatsAssetName());

// The full schedules file spans every season since 1999 -- not filtered
// down here since playerStatsSync's join only ever looks up game_ids
// that actually appear in the current season's stats rows; the extra
// historical rows are harmless, and games.csv is small regardless.
export const fetchScheduleRows = (): Promise<NflverseScheduleRow[]> =>
  fetchCsvRows<NflverseScheduleRow>("schedules", "games.csv");
