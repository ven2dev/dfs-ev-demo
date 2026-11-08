import { sha256 } from "./objectStore.ts";
import { downloadPinnedWire } from "./sourceTransfer.ts";

export const NORMALIZER_VERSION = "fs138-normalizer-v1";
export const INGEST_LIMITS = { wireBytes: 64 * 1024 * 1024, decodedBytes: 192 * 1024 * 1024,
  rows: 100_000, recordBytes: 1024 * 1024, deadlineMs: 60_000 } as const;
export type IngestLimits = { [K in keyof typeof INGEST_LIMITS]: number };
export type SourceFeed = "stats_player" | "weekly_rosters" | "pbp_participation" | "schedules";
export type SourceAsset = {
  feed: SourceFeed; season: number | null; name: string; url: string; asset_id: number;
  asset_updated_at: string; provider_digest: string | null; sha256: string | null;
  wire_bytes: number; columns: string[]; license_id: string; attribution: string;
  license_qualification: string; license_evidence_url: string;
};
export const profileId = (source: SourceAsset): string => `nflverse.${source.feed}.${source.season ?? "all"}.v1`;
export const feedKind = { stats_player: "stats", weekly_rosters: "roster", pbp_participation: "participation", schedules: "schedule" } as const;
export const policyDigest = (asset: SourceAsset, limits: IngestLimits): string => sha256(Buffer.from(JSON.stringify({
  normalizer: NORMALIZER_VERSION, feed: asset.feed, season: asset.season, columns: asset.columns,
  seasons: [2021, 2022, 2023, 2024, 2025], regularSeasonOnly: true, limits,
})));

export const checkLimits = (limits: IngestLimits): void => {
  for (const key of Object.keys(INGEST_LIMITS) as (keyof IngestLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > INGEST_LIMITS[key]) throw new Error("ingest-limits-refused");
  }
};

export const downloadSource = async (
  asset: SourceAsset, signal: AbortSignal, limits: IngestLimits = INGEST_LIMITS, fetcher: typeof fetch = fetch,
): Promise<{ bytes: Buffer; capturedAt: string; requests: number }> => {
  checkLimits(limits);
  return downloadPinnedWire(asset.url, asset.wire_bytes, signal, limits.wireBytes, fetcher);
};
