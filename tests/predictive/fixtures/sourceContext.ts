import type { SourceContextPublication } from "../../../src/lib/predictive/sourceContextPublication.ts";
import { SOURCE_CONTEXT_PROFILE_VERSION } from "../../../src/lib/predictive/sourceContextPublication.ts";
import { SOURCE_HEADERS } from "../../../src/lib/predictive/sourceHeaders.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";
import { sourceClaimFixture } from "./sourceClaims.ts";
import { sourceCsv, sourceSamples } from "./source.ts";

export function sourceContextFixture(feed: "schedule" | "identifiers" = "schedule"): SourceContextPublication {
  const base = sourceClaimFixture("original-context"), bytes = sourceCsv(feed, feed === "schedule" ? sourceSamples().schedule : [{ gsis_id: "00-0000001", position: "QB" }]);
  const tag = feed === "schedule" ? "schedules" : "players", asset = feed === "schedule" ? "games.csv" : "players.csv";
  return { ...base, rightsDecisions: base.rightsDecisions.map(r => ({ ...r, evidenceKind: "terms-review", evidenceReference: "fixture-only-context-terms" })),
    profile: { ...base.profile, purpose: "source", feed, releaseTag: tag, assetPattern: asset,
      parserVersion: SOURCE_CONTEXT_PROFILE_VERSION, headerProfileSha256: digest(canonical(SOURCE_HEADERS[feed])),
      evidenceKinds: feed === "schedule" ? ["schedule", "game-bridge", "team-alias"] : ["player-bridge"] },
    artifact: { ...base.artifact, bytes, sha256: digest(bytes), scopeKind: "all-seasons", scopeSeason: null,
      origin: `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${asset}` },
    seasonRange: feed === "schedule" ? { fromSeason: 2024, throughSeason: 2026 } : null };
}
