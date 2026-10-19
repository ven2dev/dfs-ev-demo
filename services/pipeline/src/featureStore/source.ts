import { sha256 } from "./objectStore.ts";

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

const checkedUrl = (value: string, initial: boolean): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !(initial ? ["github.com"] : ["github.com", "release-assets.githubusercontent.com"]).includes(url.hostname) ||
      (initial && (url.search || !url.pathname.startsWith("/nflverse/nflverse-data/releases/download/")))) {
    throw new Error("ingest-url-refused");
  }
  return url;
};

export const downloadSource = async (
  asset: SourceAsset, signal: AbortSignal, limits: IngestLimits = INGEST_LIMITS, fetcher: typeof fetch = fetch,
): Promise<{ bytes: Buffer; capturedAt: string; requests: number }> => {
  checkLimits(limits);
  if (!Number.isSafeInteger(asset.wire_bytes) || asset.wire_bytes < 0 || asset.wire_bytes > limits.wireBytes) throw new Error("ingest-wire-budget-exceeded");
  let url = checkedUrl(asset.url, true).href;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { signal, redirect: "manual", headers: {
      "Accept-Encoding": "identity", "User-Agent": "dfs-ev-demo-feature-store-spike", Accept: "application/octet-stream",
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("ingest-redirect-refused");
      url = checkedUrl(new URL(location, url).href, false).href;
      continue;
    }
    if (!response.ok || response.status !== 200 || !response.body) {
      await response.body?.cancel(); throw new Error("ingest-http-refused");
    }
    // fetch transparently decodes Content-Encoding. Refuse that transformation
    // so the stored hash continues to identify exact release-asset wire bytes.
    const encoding = response.headers.get("content-encoding");
    const length = response.headers.get("content-length");
    if ((encoding && encoding !== "identity") || (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== asset.wire_bytes))) {
      await response.body.cancel(); throw new Error("ingest-wire-metadata-refused");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > limits.wireBytes || count > asset.wire_bytes) throw new Error("ingest-wire-budget-exceeded");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (count !== asset.wire_bytes) throw new Error("ingest-wire-size-mismatch");
    return { bytes: Buffer.concat(chunks, count), capturedAt: new Date().toISOString(), requests: redirects + 1 };
  }
  throw new Error("ingest-redirect-refused");
};
