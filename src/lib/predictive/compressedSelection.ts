import { COMPRESSED_SOURCE_CLAIM_VERSION } from "./compressedPublication.ts";
import { sourceClaimKey, type SourceClaimRow, type SourceStatsCapture, type SourceStatsReplay, type SourceStatsRequest } from "./sourceClaims.ts";
import { canonical, digest, instant, refuse } from "./validation.ts";

export type VerifiedCompressedSnapshot = {
  capture: SourceStatsCapture;
  profileId: string;
  season: 2025 | 2026;
  feed: "player" | "team";
  rows: SourceClaimRow[];
  publication: { requestHash: string; claimsSha256: string; recordedAt: string };
};

// Pure selection over already byte-verified publications. Authorization and
// completeness of the supplied snapshot inventory remain the caller's job.
// No normalization or consumer publication follows from this result.
export const selectCompressedSourceClaim = (request: SourceStatsRequest, inventory: VerifiedCompressedSnapshot[], checkedAt: string): SourceStatsReplay => {
  const pinned = structuredClone(request), now = instant(checkedAt), cutoff = instant(pinned.cutoff);
  if (!Array.isArray(inventory) || inventory.length > 64 || inventory.reduce((count, entry) => count + entry.rows.length, 0) > 160_000)
    refuse("compressed-selection-bounds-refused");
  if (cutoff > now || !/^(2025|2026)_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(pinned.rawGameId) ||
      !/^[A-Z]{2,3}$/.test(pinned.rawTeam) || typeof pinned.profileId !== "string" || !pinned.profileId.trim() ||
      pinned.profileId.length > 256 || /[\u0000-\u001f\u007f]/.test(pinned.profileId) ||
      (pinned.rawPlayerId !== null && !/^00-\d{7}$/.test(pinned.rawPlayerId))) refuse("compressed-selection-request-refused");
  const season = Number(pinned.rawGameId.slice(0, 4)), feed = pinned.rawPlayerId === null ? "team" : "player";
  const eligible = inventory.filter(entry => entry.profileId === pinned.profileId && entry.season === season && entry.feed === feed);
  const ids = new Set<string>();
  for (const entry of eligible) {
    const capture = entry.capture;
    if (ids.has(capture.id) || instant(capture.capturedAt) > instant(capture.availableAt) ||
        instant(capture.availableAt) > instant(capture.ingestedAt) || instant(capture.ingestedAt) > instant(entry.publication.recordedAt) ||
        instant(entry.publication.recordedAt) > now || capture.parsedRows !== entry.rows.length ||
        digest(canonical(entry.rows)) !== entry.publication.claimsSha256 ||
        entry.rows.some((row, index) => row.rowOrdinal !== index + 1 || row.id !== "source-row:" + digest(canonical([capture.id, index + 1]))))
      refuse("compressed-selection-evidence-refused");
    ids.add(capture.id);
  }
  const visible = eligible.filter(entry => instant(entry.publication.recordedAt) <= cutoff);
  const newest = Math.max(...visible.map(entry => instant(entry.capture.capturedAt)));
  const selected = visible.filter(entry => instant(entry.capture.capturedAt) === newest)
    .sort((a, b) => instant(a.capture.ingestedAt) - instant(b.capture.ingestedAt) || (a.capture.id < b.capture.id ? -1 : 1));
  const result = (reason: string | null, captures: SourceStatsCapture[], rows: SourceClaimRow[]): SourceStatsReplay => {
    const evidence = structuredClone({ version: COMPRESSED_SOURCE_CLAIM_VERSION, request: pinned, captures, rows });
    return { status: reason ? "unavailable-source-claim" : "observed-source-claim", reason, evidence, inputDigest: digest(canonical(evidence)),
      featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" };
  };
  if (!selected.length) return result("source-capture-missing", [], []);
  if (new Set(selected.map(entry => entry.capture.sha256)).size > 1)
    return result("source-capture-ambiguous", selected.map(entry => entry.capture), []);
  const chosen = selected[0];
  const key = sourceClaimKey({ game_id: pinned.rawGameId, team: pinned.rawTeam, player_id: pinned.rawPlayerId ?? "" }, feed);
  const rows = chosen.rows.filter(row => row.rawKeySha256 === key);
  return result(!rows.length ? "source-row-missing" : new Set(rows.map(row => row.selectedSha256)).size > 1 ? "source-row-ambiguous" :
    rows.some(row => row.failureCode !== null || row.projection === null) ? "source-row-refused" : null, [chosen.capture], rows);
};
