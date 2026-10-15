import { prepareSourceContextPublication, type SourceContextPublication } from "./sourceContextPublication.ts";
import { SOURCE_CONTEXT_BOUNDS } from "./sourceContextClaims.ts";
import type { Revision, Schedule, GameBridge } from "./types.ts";
import { canonical, compareText, digest, exact, gameIdentity, refuse, validateRevision } from "./validation.ts";

export const SOURCE_CONTEXT_ASSOCIATION_VERSION = "nflverse-original-schedule-associations-v1";
export const SOURCE_CONTEXT_ASSOCIATION_LIMIT = 256;
export type SourceContextScheduleSelection = {
  claimId: string; gameId: string;
  scheduleHead: Revision<"schedule"> | null; bridgeHead: Revision<"game-bridge"> | null;
};
export type SourceContextAssociationRequest = { source: SourceContextPublication; selections: SourceContextScheduleSelection[] };

// These heads are assertions, not authority. The future SQL recorder must compare
// them with the actual source-chain heads under its write guard, seal the exact
// association set, and stamp a NEW capture's ingestion clock atomically. Never
// attach this output to the earlier raw artifact through the native JSON writer.
export async function prepareSourceContextAssociations(input: SourceContextAssociationRequest, checkedAt: string) {
  exact(input, ["source", "selections"]);
  if (!Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > SOURCE_CONTEXT_ASSOCIATION_LIMIT)
    refuse("context-association-bounds-refused");
  if (typeof input.source?.artifact?.bytes !== "string" || Buffer.byteLength(input.source.artifact.bytes) > SOURCE_CONTEXT_BOUNDS.bytes)
    refuse("artifact-integrity-failed");
  const pinned = structuredClone(input);
  const publication = await prepareSourceContextPublication(pinned.source, checkedAt);
  if (publication.input.profile.feed !== "schedule") refuse("context-association-feed-refused");
  const rows = new Map(publication.prepared.rows.map(row => [row.id, row]));
  const rawGames = new Set<string>(), games = new Set<string>();
  const bindings = pinned.selections.map(selection => {
    exact(selection, ["claimId", "gameId", "scheduleHead", "bridgeHead"]);
    gameIdentity(selection.gameId);
    const row = rows.get(selection.claimId), claim = row?.projection;
    if (!row || row.failureCode !== null || claim?.kind !== "raw-schedule") refuse("context-association-claim-refused");
    if (rawGames.has(claim.rawGameId) || games.has(selection.gameId)) refuse("context-association-identity-conflict");
    rawGames.add(claim.rawGameId); games.add(selection.gameId);
    const schedule: Schedule = { gameId: selection.gameId, rawGameId: claim.rawGameId, season: claim.season,
      seasonType: claim.seasonType, week: claim.week, kickoff: claim.kickoff, rawGameday: claim.rawGameday,
      rawGametime: claim.rawGametime, homeTeamId: "nfl:team:" + claim.rawHomeTeam, awayTeamId: "nfl:team:" + claim.rawAwayTeam,
      rawHomeTeam: claim.rawHomeTeam, rawAwayTeam: claim.rawAwayTeam,
      // This projection does not qualify venue fields; null never asserts that
      // the provider's original venue cell was blank.
      rawRoof: null, rawSurface: null, rawStadiumId: null };
    const bridge: GameBridge = { provider: "nflverse", rawGameId: claim.rawGameId, gameId: selection.gameId };
    const revision = <K extends "schedule" | "game-bridge">(kind: K, data: K extends "schedule" ? Schedule : GameBridge,
      head: Revision<K> | null): Revision<K> => {
      const sourceRecordId = "original-context:" + kind + ":" + claim.rawGameId;
      if (head !== null) {
        validateRevision(head);
        if (head.kind !== kind || head.sourceRecordId !== sourceRecordId || head.data.rawGameId !== claim.rawGameId ||
            head.data.gameId !== selection.gameId) refuse("context-association-head-refused");
        if (canonical(head.data) === canonical(data)) return head;
      }
      return validateRevision({ id: "context-observation:" + digest(canonical([SOURCE_CONTEXT_ASSOCIATION_VERSION,
        publication.input.captureId, row.id, kind, data, head?.id ?? null])), kind, sourceRecordId,
        predecessorId: head?.id ?? null, correctionReason: head === null ? null : "original-context-source-update", data }) as Revision<K>;
    };
    return { claimId: row.id, rowOrdinal: row.rowOrdinal, rawKeySha256: row.rawKeySha256, selectedSha256: row.selectedSha256,
      expectedScheduleHead: selection.scheduleHead?.id ?? null, expectedBridgeHead: selection.bridgeHead?.id ?? null,
      schedule: revision("schedule", schedule, selection.scheduleHead), bridge: revision("game-bridge", bridge, selection.bridgeHead) };
  }).sort((a, b) => compareText(a.claimId, b.claimId));
  const basis = { version: SOURCE_CONTEXT_ASSOCIATION_VERSION, captureId: publication.input.captureId,
    sourceRequestHash: publication.requestHash, claimsSha256: publication.prepared.claimsSha256, bindings };
  return { ...basis, associationSha256: digest(canonical(basis)),
    canonicalEvidencePublished: false, featuresPublished: false, labelsFinalized: false,
    membershipEffectiveBounds: "unqualified", independentScheduleCoverage: "unqualified" } as const;
}
