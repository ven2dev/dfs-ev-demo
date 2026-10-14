import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { COMPRESSED_SOURCE_PROFILE_VERSION, compressedSourceAsset, type CompressedSourcePublication } from "../../../src/lib/predictive/compressedPublication.ts";
import { sourceClaimFixture } from "./sourceClaims.ts";
import { sourceCsv, sourceSamples } from "./source.ts";

export const compressedPublicationFixture = (season: 2025 | 2026 = 2025, feed: "player" | "team" = "player") => {
  const text = sourceCsv(feed, [{ ...sourceSamples()[feed][0], season: String(season), game_id: `${season}_06_CAR_PHI`, passing_yards: "-2" }]);
  const source = gzipSync(text), base = sourceClaimFixture("compressed-publication", feed), asset = compressedSourceAsset(feed, season);
  const metadata = { ...base.artifact };
  Reflect.deleteProperty(metadata, "bytes");
  const input: CompressedSourcePublication = { id: base.id, captureId: base.captureId, capturedAt: base.capturedAt,
    profile: { ...base.profile, parserVersion: COMPRESSED_SOURCE_PROFILE_VERSION, assetPattern: asset.name }, rightsDecisions: base.rightsDecisions,
    artifact: { ...metadata, sha256: createHash("sha256").update(source).digest("hex"), wireBytes: source.length,
      scopeSeason: season, origin: asset.url } };
  return { source, input, text, checkedAt: "2026-10-13T12:00:00.000Z" };
};
