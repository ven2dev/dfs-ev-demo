import { prepareSourceClaims, SOURCE_CLAIM_VERSION, type SourceStatsReplay } from "../../../src/lib/predictive/sourceClaims.ts";
import type { Dataset, Revision } from "../../../src/lib/predictive/types.ts";
import { canonical, digest, refuse } from "../../../src/lib/predictive/validation.ts";
import { sourceClaimFixture } from "./sourceClaims.ts";
import { sourceCsv, sourceGameId } from "./source.ts";
import { addCapture, gameId, profile, revision, rights, schedule } from "./passingYards.ts";

export const NORMALIZATION_CUTOFF = "2026-10-10T12:00:00.000Z";
export const NORMALIZATION_ACCESS = "2026-10-11T12:00:00.000Z";
export const NORMALIZATION_GAME = gameId(66);
export const NORMALIZATION_KICKOFF = "2026-10-18T17:00:00.000Z";
export const BRIDGE_PROFILE = "normalization-bridges-v1";
export const normalizationFixture = async (feed: "player" | "team" = "player", bytes = sourceCsv(feed)) => {
  const input = sourceClaimFixture("normalize-source", feed, bytes);
  const prepared = await prepareSourceClaims(input);
  const projection = prepared.rows.find((row) => row.projection)?.projection ?? refuse("fixture-projection-missing");
  const evidence = { version: SOURCE_CLAIM_VERSION, request: { profileId: input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI",
    rawPlayerId: feed === "player" ? "00-0000001" : null, cutoff: NORMALIZATION_CUTOFF },
    captures: [{ id: input.captureId, runId: input.id, artifactId: input.artifact.id, capturedAt: input.capturedAt,
      availableAt: input.capturedAt, ingestedAt: NORMALIZATION_CUTOFF, parsedRows: prepared.rows.length,
      sha256: input.artifact.sha256, storageRef: input.artifact.sha256 + ".csv", byteSize: Buffer.byteLength(input.artifact.bytes) }],
    rows: prepared.rows.filter((row) => row.projection?.rawPlayerId === projection.rawPlayerId) };
  const source: SourceStatsReplay = { status: "observed-source-claim", reason: null, evidence, inputDigest: digest(canonical(evidence)),
    featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" };
  const bridgeRows: Revision[] = [
    revision("game-map", "game-bridge", { provider: "nflverse", rawGameId: sourceGameId, gameId: NORMALIZATION_GAME }),
    revision("team-map", "team-alias", { provider: "nflverse", rawAlias: "PHI", teamId: "nfl:team:PHI", effectiveFromSeason: 2026, effectiveToSeason: 2026 }),
    revision("opponent-map", "team-alias", { provider: "nflverse", rawAlias: "CAR", teamId: "nfl:team:CAR", effectiveFromSeason: 2026, effectiveToSeason: 2026 }),
    revision("player-map", "player-bridge", { provider: "gsis", rawPlayerId: "00-0000001", playerId: "00-0000001",
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }),
    revision("game-schedule", "schedule", { ...schedule(6, NORMALIZATION_KICKOFF, "nfl:team:PHI", "nfl:team:CAR"),
      gameId: NORMALIZATION_GAME, rawGameId: sourceGameId }),
  ];
  const context: Dataset = { formatVersion: 2, profiles: [input.profile, profile(BRIDGE_PROFILE)],
    rightsDecisions: [...input.rightsDecisions, rights(BRIDGE_PROFILE, { allowedUses: ["internal-research"] })],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [{ id: "raw-stats-gsis-link", statsProfileId: input.profile.id,
      bridgeProfileId: BRIDGE_PROFILE, provider: "gsis", decidedAt: "2026-01-01T00:00:00.000Z" }] };
  addCapture(context, "normalization-evidence", bridgeRows, "2026-10-09T12:00:00.000Z", BRIDGE_PROFILE);
  return { input, source, context, bridgeRows };
};
export const rewriteNormalizationRows = (context: Dataset, rows: Revision[]) => {
  const bytes = canonical(rows); context.artifacts[0].bytes = bytes; context.artifacts[0].sha256 = digest(bytes);
  context.captures[0].parsedRows = rows.length;
};
