import { SOURCE_HEADERS } from "../../../src/lib/predictive/sourceHeaders.ts";
import { SOURCE_FEEDS, sourceAsset, type SourceFeed, type SourceRow } from "../../../src/lib/predictive/sourceAdapters.ts";
import { createSourceTransport, SOURCE_LIMITS, type SourceLimits } from "../../../src/lib/predictive/sourceTransport.ts";
import { digest } from "../../../src/lib/predictive/validation.ts";

export const sourceGameId = "2026_06_CAR_PHI";
export const sourceSamples = (): Record<SourceFeed, SourceRow[]> => ({
  player: [{ player_id: "00-0000001", position: "QB", game_id: sourceGameId, season: "2026", week: "6", season_type: "REG", team: "PHI", opponent_team: "CAR", attempts: "10", passing_yards: "80" }],
  team: [{ game_id: sourceGameId, season: "2026", week: "6", season_type: "REG", team: "PHI", opponent_team: "CAR", attempts: "10", passing_yards: "80" }],
  schedule: [{ game_id: sourceGameId, season: "2026", week: "6", game_type: "REG", home_team: "PHI", away_team: "CAR", gameday: "2026-10-18", gametime: "13:00" }],
  identifiers: [{ gsis_id: "00-0000001", display_name: "Synthetic QB" }, { gsis_id: "00-0000002", display_name: "Synthetic backup" }],
  roster: ["00-0000001", "00-0000002"].map((gsis_id) => ({ gsis_id, position: "QB", season: "2026", week: "6", game_type: "REG", team: "PHI", status: "ACT" })),
  injuries: [{ gsis_id: "00-0000001", team: "PHI", season: "2026", week: "6", season_type: "REG", game_type: "REG", report_status: "Questionable" }],
  depth: [{ gsis_id: "00-0000001", team: "PHI", dt: "2026-10-09T12:00:00Z", pos_abb: "QB", pos_rank: "1" }],
});
const quoted = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export const sourceCsv = (feed: SourceFeed, rows: SourceRow[] = sourceSamples()[feed]) =>
  SOURCE_HEADERS[feed].join(",") + "\n" + rows.map((row) => SOURCE_HEADERS[feed].map((key) => quoted(row[key] ?? "")).join(",")).join("\n") + "\n";

export const fixtureTransport = (options: { partialDepth?: boolean; failFeed?: SourceFeed; badHeader?: SourceFeed; badDigest?: SourceFeed; limits?: SourceLimits } = {}) => {
  const fetched: string[] = [];
  const transport = createSourceTransport(options.limits ?? SOURCE_LIMITS, {
    instant: () => "2026-10-09T12:00:00.000Z",
    fetch: async (url) => {
      const address = String(url); fetched.push(address);
      const feed = SOURCE_FEEDS.find((name) => { const asset = sourceAsset(name, 2026); return asset.url === address || asset.metadataUrl === address; })!;
      const asset = sourceAsset(feed, 2026);
      let bytes = sourceCsv(feed);
      if (options.badHeader === feed) bytes = bytes.replace("\n", ",unexpected\n");
      const partial = feed === "depth" && options.partialDepth;
      const size = partial ? 59_000_000 : Buffer.byteLength(bytes);
      if (address === asset.metadataUrl) return new Response(JSON.stringify({ tag_name: asset.tag, assets: [{ name: asset.name, size,
        browser_download_url: asset.url, updated_at: "2026-10-08T12:00:00Z", digest: "sha256:" + (options.badDigest === feed ? "a".repeat(64) : digest(bytes)) }] }));
      if (options.failFeed === feed) return new Response(null, { status: 403 });
      return new Response(bytes, { status: partial ? 206 : 200, headers: { "content-length": String(Buffer.byteLength(bytes)),
        ...(partial ? { "content-range": `bytes 0-${Buffer.byteLength(bytes) - 1}/${size}` } : {}) } });
    },
  });
  return { transport, fetched };
};
