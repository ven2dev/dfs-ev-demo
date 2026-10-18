import { gzipSync } from "node:zlib";
import { sha256 } from "../../src/lib/featureStore/objectStore.ts";
import type { SourceAsset, SourceFeed } from "../../src/lib/featureStore/source.ts";

export const STAT_HEADER = ["player_id", "position", "season", "week", "season_type", "game_id", "team", "attempts", "passing_yards"];
export const STAT_ROW = ["00-0000001", "QB", "2021", "1", "REG", "2021_01_DAL_TB", "DAL", "0", "0"];
export const csvFixture = (header: string[], rows: string[][]): string => [header, ...rows]
  .map((row) => row.map((field) => /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(",")).join("\n") + "\n";
export const sourceFixture = (text = csvFixture(STAT_HEADER, [STAT_ROW]), options: { feed?: SourceFeed; columns?: string[]; gzip?: boolean } = {}) => {
  const bytes = options.gzip ? gzipSync(text) : Buffer.from(text);
  const asset: SourceAsset = { feed: options.feed ?? "stats_player", season: 2021, name: "fixture.csv" + (options.gzip ? ".gz" : ""),
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_player/fixture.csv", asset_id: 1,
    asset_updated_at: "2021-01-01T00:00:00Z", provider_digest: "sha256:" + sha256(bytes), sha256: sha256(bytes),
    wire_bytes: bytes.length, columns: options.columns ?? STAT_HEADER, license_id: "synthetic-test-only",
    attribution: "synthetic fixture", license_qualification: "synthetic-test-only", license_evidence_url: "https://example.invalid/test-only" };
  return { bytes, asset };
};
