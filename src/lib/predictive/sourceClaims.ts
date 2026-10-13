import type { Artifact, Profile, RightsDecision } from "./types.ts";
import { parseSourceCsv, sourceAsset, SOURCE_PROFILE_VERSION, SOURCE_SAMPLE_SEASON, type SourceRow } from "./sourceAdapters.ts";
import { projectSourceStats, sourceStatsKey, type SourceStats, type SourceStatsFeed } from "./sourceStats.ts";
import { canonical, digest, instant, PredictiveError, refuse, validateDataset } from "./validation.ts";

export const SOURCE_CLAIM_VERSION = "nflverse-csv-source-claims-v1";
export const SOURCE_CLAIM_BOUNDS = { bytes: 8_000_000, rows: 8192 } as const;
export type SourceStatsPublication = {
  id: string; captureId: string; capturedAt: string;
  profile: Profile; rightsDecisions: RightsDecision[]; artifact: Artifact;
};
export type SourceClaimRow = {
  id: string; rowOrdinal: number; rawKeySha256: string; selectedSha256: string;
  projection: SourceStats | null; failureCode: string | null;
};
export type SourceStatsRequest = {
  profileId: string; rawGameId: string; rawTeam: string; rawPlayerId: string | null; cutoff: string;
};
export type SourceStatsCapture = {
  id: string; runId: string; artifactId: string; capturedAt: string; availableAt: string; ingestedAt: string;
  parsedRows: number; sha256: string; storageRef: string; byteSize: number;
};
export type SourceStatsReplay = {
  status: "unavailable-source-claim" | "observed-source-claim"; reason: string | null;
  evidence: { version: string; request: SourceStatsRequest; captures: SourceStatsCapture[]; rows: SourceClaimRow[] };
  inputDigest: string; featuresPublished: false; labelsFinalized: false; populationCoverage: "unqualified";
};
export const sourceClaimKey = (row: SourceRow, feed: SourceStatsFeed) => digest(sourceStatsKey(row, feed === "player"));
export const projectScopedSourceClaim = (captureId: string, feed: SourceStatsFeed, row: SourceRow, rowOrdinal: number,
  scopeSeason: 2025 | 2026): SourceClaimRow => {
  if (scopeSeason !== 2025 && scopeSeason !== 2026) refuse("source-stats-scope-refused");
  let projection: SourceStats | null = null; let failureCode: string | null = null;
  try {
    projection = projectSourceStats(feed, row);
    if (projection.season !== scopeSeason) refuse("source-stats-scope-refused");
  } catch (error) {
    if (!(error instanceof PredictiveError)) throw error;
    projection = null; failureCode = error.code;
  }
  return { id: "source-row:" + digest(canonical([captureId, rowOrdinal])), rowOrdinal,
    rawKeySha256: sourceClaimKey(row, feed), selectedSha256: digest(canonical(row)), projection, failureCode };
};

// The released text qualification interface retains its 2026-only semantics.
export const projectSourceClaim = (captureId: string, feed: SourceStatsFeed, row: SourceRow, rowOrdinal: number): SourceClaimRow =>
  projectScopedSourceClaim(captureId, feed, row, rowOrdinal, SOURCE_SAMPLE_SEASON);

// Full CSV snapshots of raw claims. Canonical identities, completion decisions
// and labels cannot be inferred here. The source capture time is preserved;
// database ingestion is stamped separately by the publisher's database clock.
export const prepareSourceClaims = async (input: SourceStatsPublication) => {
  for (const value of [input.id, input.captureId])
    if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) refuse("source-publication-id-refused");
  instant(input.capturedAt);
  const { profile, artifact } = input;
  validateDataset({ formatVersion: 2, profiles: [profile], rightsDecisions: input.rightsDecisions,
    artifacts: [{ ...artifact, bytes: "[]", sha256: digest("[]") }], captures: [], decisions: [], labels: [], identityLinks: [] });
  if (!["player", "team"].includes(profile.feed) || profile.parserVersion !== SOURCE_PROFILE_VERSION ||
      profile.allowlistVersion !== "predictive-raw-allowlist-v1" || profile.purpose === "owner-decision" ||
      !profile.evidenceKinds.includes(profile.feed === "player" ? "player-game-stats" : "team-game-stats") ||
      artifact.retrievalKind !== "full" || artifact.scopeKind !== "season-file" || artifact.scopeSeason !== SOURCE_SAMPLE_SEASON ||
      artifact.scopeFilter !== null) refuse("source-publication-profile-refused");
  if (typeof artifact.bytes !== "string" || Buffer.byteLength(artifact.bytes) > SOURCE_CLAIM_BOUNDS.bytes ||
      digest(artifact.bytes) !== artifact.sha256) refuse("artifact-integrity-failed");
  const feed = profile.feed as SourceStatsFeed;
  const expected = sourceAsset(feed, SOURCE_SAMPLE_SEASON);
  if (profile.provider !== "nflverse" || profile.releaseTag !== expected.tag || profile.assetPattern !== expected.name)
    refuse("source-publication-profile-refused");
  const parsed = await parseSourceCsv(feed, artifact.bytes, SOURCE_CLAIM_BOUNDS.rows);
  if (profile.headerProfileSha256 !== parsed.headerSha256) refuse("source-publication-header-refused");
  return { feed, rows: parsed.rows.map((row, index) => projectSourceClaim(input.captureId, feed, row, index + 1)) };
};
