import type { SourceStatsPublication } from "../../../src/lib/predictive/sourceClaims.ts";
import { SOURCE_PROFILE_VERSION } from "../../../src/lib/predictive/sourceAdapters.ts";
import { SOURCE_HEADERS } from "../../../src/lib/predictive/sourceHeaders.ts";
import type { SourceStatsFeed } from "../../../src/lib/predictive/sourceStats.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";
import { sourceCsv } from "./source.ts";

export const sourceClaimFixture = (id = "source-A", feed: SourceStatsFeed = "player", bytes = sourceCsv(feed)): SourceStatsPublication => {
  const profileId = "csv-synthetic-" + feed;
  return { id, captureId: id + ":capture", capturedAt: "2026-10-09T12:00:00.000Z",
    profile: { id: profileId, purpose: "synthetic-test", provider: "nflverse", feed, releaseTag: "stats_" + feed,
      assetPattern: "stats_" + feed + "_week_2026.csv", headerProfileSha256: digest(canonical(SOURCE_HEADERS[feed])),
      parserVersion: SOURCE_PROFILE_VERSION, allowlistVersion: "predictive-raw-allowlist-v1", license: "synthetic-test-only",
      attribution: null, evidenceKinds: [feed === "player" ? "player-game-stats" : "team-game-stats"], registeredAt: "2026-01-01T00:00:00.000Z" },
    rightsDecisions: [{ id: "rights:" + profileId, profileId, predecessorId: null, allowedUses: ["internal-research"],
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, decidedAt: "2026-01-01T00:00:00.000Z",
      evidenceKind: "synthetic", evidenceReference: "fixture-only" }],
    artifact: { id: id + ":artifact", profileId, bytes, sha256: digest(bytes), retrievalKind: "full", origin: "fixture://csv-source/" + feed,
      providerEtag: null, providerLastModified: null, releaseUpdatedAt: null, scopeKind: "season-file", scopeSeason: 2026,
      scopeWeek: null, scopeGameId: null, scopeFilter: null } };
};
