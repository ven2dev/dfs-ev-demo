import type { Artifact, Profile, RightsDecision } from "./types.ts";
import { SOURCE_HEADERS } from "./sourceHeaders.ts";
import { prepareSourceContextClaims, SOURCE_CONTEXT_BOUNDS, type ContextRequest } from "./sourceContextClaims.ts";
import { allows, canonical, digest, exact, instant, refuse, rightsInForce, validateDataset } from "./validation.ts";

export const SOURCE_CONTEXT_PROFILE_VERSION = "nflverse-original-context-qualification-v1";
export type SourceContextPublication = { id: string; captureId: string; capturedAt: string; profile: Profile;
  rightsDecisions: RightsDecision[]; artifact: Artifact; seasonRange: ContextRequest["seasonRange"] };

// Detached preparation only: no SQL/profile registration, rights grant, canonical
// assignment or capture clock. The recorder must check persisted metadata and
// rights under its guard using a fresh database clock before committing.
export async function prepareSourceContextPublication(input: SourceContextPublication, checkedAt: string) {
  exact(input, ["id", "captureId", "capturedAt", "profile", "rightsDecisions", "artifact", "seasonRange"]);
  if (typeof input.artifact?.bytes !== "string" || Buffer.byteLength(input.artifact.bytes) > SOURCE_CONTEXT_BOUNDS.bytes) refuse("artifact-integrity-failed");
  const pinned = structuredClone(input), { artifact, profile } = pinned;
  for (const id of [pinned.id, pinned.captureId]) if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) refuse("source-publication-id-refused");
  // Validate the metadata envelope without mistaking CSV for a native JSON
  // revision artifact. The original bytes are checked by the context decoder.
  validateDataset({ formatVersion: 2, profiles: [profile], rightsDecisions: pinned.rightsDecisions,
    artifacts: [{ ...artifact, bytes: "[]", sha256: digest("[]") }], captures: [], decisions: [], labels: [], identityLinks: [] });
  if (!["schedule", "identifiers"].includes(profile.feed)) refuse("context-publication-profile-refused");
  const feed = profile.feed as ContextRequest["feed"];
  const tag = feed === "schedule" ? "schedules" : "players", asset = feed === "schedule" ? "games.csv" : "players.csv";
  const kinds = feed === "schedule" ? ["schedule", "game-bridge", "team-alias"] : ["player-bridge"];
  if (profile.purpose !== "source" || profile.provider !== "nflverse" || profile.parserVersion !== SOURCE_CONTEXT_PROFILE_VERSION ||
      profile.allowlistVersion !== "predictive-raw-allowlist-v1" || profile.releaseTag !== tag || profile.assetPattern !== asset ||
      profile.headerProfileSha256 !== digest(canonical(SOURCE_HEADERS[feed])) || canonical(profile.evidenceKinds) !== canonical(kinds) ||
      artifact.profileId !== profile.id || artifact.origin !== `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${asset}` ||
      artifact.retrievalKind !== "full" || artifact.scopeKind !== "all-seasons" || artifact.scopeSeason !== null ||
      artifact.scopeWeek !== null || artifact.scopeGameId !== null || artifact.scopeFilter !== null) refuse("context-publication-profile-refused");
  const now = instant(checkedAt), captured = instant(pinned.capturedAt);
  if (captured > now || instant(profile.registeredAt) > now || pinned.rightsDecisions.some(d => instant(d.decidedAt) > now) ||
      artifact.releaseUpdatedAt !== null && instant(artifact.releaseUpdatedAt) > captured) refuse("source-publication-time-refused");
  const historical = rightsInForce(pinned.rightsDecisions, profile.id, captured, captured);
  const current = rightsInForce(pinned.rightsDecisions, profile.id, now, now);
  if (!allows(historical, "internal-research") || !allows(current, "internal-research")) refuse("context-publication-rights-refused");
  const prepared = await prepareSourceContextClaims(artifact.bytes, { captureId: pinned.captureId, feed, wireSha256: artifact.sha256,
    wireBytes: Buffer.byteLength(artifact.bytes), seasonRange: pinned.seasonRange });
  return { input: pinned, prepared, rightsAtCapture: historical!.id, rightsAtPreparation: current!.id,
    requestHash: digest(canonical({ version: SOURCE_CONTEXT_PROFILE_VERSION, input: pinned })),
    canonicalEvidencePublished: false, featuresPublished: false, labelsFinalized: false } as const;
}
