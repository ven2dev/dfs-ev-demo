import { runCompressedWorker } from "./compressedWorker.ts";
import type { prepareCompressedSourceClaims } from "./compressedClaims.ts";
import { COMPRESSED_SOURCE_LIMITS } from "./compressedSource.ts";
import { SOURCE_HEADERS } from "./sourceHeaders.ts";
import type { Artifact, Profile, RightsDecision } from "./types.ts";
import { allows, canonical, digest, exact, instant, refuse, rightsInForce, validateDataset } from "./validation.ts";

export const COMPRESSED_SOURCE_PROFILE_VERSION = "nflverse-gzip-csv-source-qualification-v1";
export const COMPRESSED_SOURCE_CLAIM_VERSION = "nflverse-gzip-csv-source-claims-v1";
export type CompressedSourcePublication = {
  id: string; captureId: string; capturedAt: string;
  profile: Profile; rightsDecisions: RightsDecision[];
  artifact: Omit<Artifact, "bytes"> & { wireBytes: number };
};

export const compressedSourceAsset = (feed: "player" | "team", season: 2025 | 2026) => {
  if (!["player", "team"].includes(feed) || ![2025, 2026].includes(season)) refuse("compressed-publication-scope-refused");
  const tag = "stats_" + feed, name = `stats_${feed}_week_${season}.csv.gz`;
  return { tag, name, url: `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${name}` };
};

// Detached preparation contract only. A writer must supply its database clock,
// compare the full registered rights chain, and recheck rights under SQL locks.
// This cannot register a profile or authorize a persisted/consumer publication.
export const checkCompressedPublicationInput = (input: CompressedSourcePublication, checkedAt: string) => {
  exact(input, ["id", "captureId", "capturedAt", "profile", "rightsDecisions", "artifact"]);
  const pinned = structuredClone(input);
  for (const value of [pinned.id, pinned.captureId, pinned.artifact.id]) {
    if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) refuse("source-publication-id-refused");
  }
  exact(pinned.artifact, ["id", "sha256", "wireBytes", "profileId", "retrievalKind", "origin", "providerEtag",
    "providerLastModified", "releaseUpdatedAt", "scopeKind", "scopeSeason", "scopeWeek", "scopeGameId", "scopeFilter"]);
  const { profile, artifact } = pinned;
  const { wireBytes, ...metadata } = artifact;
  validateDataset({ formatVersion: 2, profiles: [profile], rightsDecisions: pinned.rightsDecisions,
    artifacts: [{ ...metadata, bytes: "[]", sha256: digest("[]") }], captures: [], decisions: [], labels: [], identityLinks: [] });
  if (!Number.isSafeInteger(wireBytes) || wireBytes < 1 || wireBytes > COMPRESSED_SOURCE_LIMITS.wireBytes ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)) refuse("compressed-publication-wire-refused");
  if (!["player", "team"].includes(profile.feed) || ![2025, 2026].includes(artifact.scopeSeason ?? 0)) refuse("compressed-publication-scope-refused");
  const feed = profile.feed as "player" | "team", season = artifact.scopeSeason as 2025 | 2026;
  const expected = compressedSourceAsset(feed, season);
  if (profile.provider !== "nflverse" || profile.purpose === "owner-decision" ||
      profile.parserVersion !== COMPRESSED_SOURCE_PROFILE_VERSION || profile.allowlistVersion !== "predictive-raw-allowlist-v1" ||
      profile.releaseTag !== expected.tag || profile.assetPattern !== expected.name ||
      profile.headerProfileSha256 !== digest(canonical(SOURCE_HEADERS[feed])) ||
      canonical(profile.evidenceKinds) !== canonical([feed === "player" ? "player-game-stats" : "team-game-stats"]) ||
      artifact.profileId !== profile.id || artifact.retrievalKind !== "full" || artifact.origin !== expected.url ||
      artifact.scopeKind !== "season-file" || artifact.scopeWeek !== null || artifact.scopeGameId !== null || artifact.scopeFilter !== null)
    refuse("compressed-publication-profile-refused");
  const now = instant(checkedAt), captured = instant(pinned.capturedAt);
  if (captured > now || instant(profile.registeredAt) > now || pinned.rightsDecisions.some(decision => instant(decision.decidedAt) > now) ||
      (artifact.releaseUpdatedAt !== null && instant(artifact.releaseUpdatedAt) > captured)) refuse("source-publication-time-refused");
  const historical = rightsInForce(pinned.rightsDecisions, profile.id, captured, captured);
  const current = rightsInForce(pinned.rightsDecisions, profile.id, now, now);
  if (!allows(historical, "internal-research") || !allows(current, "internal-research")) refuse("compressed-publication-rights-refused");
  return { input: pinned, request: { feed, season, wireSha256: artifact.sha256, wireBytes },
    rightsAtCapture: historical!.id, rightsAtPreparation: current!.id,
    requestHash: digest(canonical({ version: COMPRESSED_SOURCE_CLAIM_VERSION, input: pinned })) };
};

export const prepareCompressedPublication = async (source: Uint8Array, input: CompressedSourcePublication, checkedAt: string,
  options: Pick<NonNullable<Parameters<typeof runCompressedWorker>[3]>, "signal" | "deadlineMs" | "limits"> = {}) => {
  const checked = checkCompressedPublicationInput(input, checkedAt);
  const worker = await runCompressedWorker("claims", source, checked.request, { ...options, captureId: checked.input.captureId });
  const prepared = worker.result as Awaited<ReturnType<typeof prepareCompressedSourceClaims>>;
  if (!prepared.inspection || !Array.isArray(prepared.rows) || prepared.rows.length !== prepared.inspection.rows ||
      prepared.inspection.headerSha256 !== checked.input.profile.headerProfileSha256 ||
      prepared.rows.some((row, index) => row.rowOrdinal !== index + 1 || row.id !== "source-row:" + digest(canonical([checked.input.captureId, index + 1]))))
    refuse("compressed-publication-proof-refused");
  return { ...checked, inspection: prepared.inspection, rows: prepared.rows,
    worker: { memoryLimitBytes: worker.memoryLimitBytes, peakRssBytes: worker.peakRssBytes },
    state: "prepared-only" as const, publicationSupported: false, featuresPublished: false, labelsFinalized: false };
};
