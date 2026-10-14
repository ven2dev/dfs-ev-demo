import { prepareCompressedSourceClaims } from "../../../src/lib/predictive/compressedClaims.ts";
import { selectCompressedSourceClaim } from "../../../src/lib/predictive/compressedSelection.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";
import { compressedPublicationFixture } from "./compressedPublication.ts";
import { normalizationFixture, NORMALIZATION_CUTOFF, rewriteNormalizationRows } from "./sourceNormalization.ts";

export const compressedNormalizationFixture = async (season: 2025 | 2026 = 2025, feed: "player" | "team" = "player") => {
  const base = await normalizationFixture(feed), compressed = compressedPublicationFixture(season,feed);
  const { input, source } = compressed;
  base.context.profiles[0] = input.profile;
  if (feed === "team") base.context.identityLinks = [];
  const rawGameId = `${season}_06_CAR_PHI`;
  for (const row of base.bridgeRows) {
    if (row.kind === "game-bridge") row.data.rawGameId = rawGameId;
    if (row.kind === "team-alias") { row.data.effectiveFromSeason = season; row.data.effectiveToSeason = season; }
    if (row.kind === "player-bridge") { row.data.effectiveFrom = `${season}-01-01T00:00:00.000Z`; row.data.effectiveTo = `${season+1}-01-01T00:00:00.000Z`; }
    if (row.kind === "schedule") { row.data.rawGameId = rawGameId; row.data.season = season; row.data.kickoff = `${season}-10-18T17:00:00.000Z`; }
  }
  rewriteNormalizationRows(base.context,base.bridgeRows);
  const prepared = await prepareCompressedSourceClaims(input.captureId,source,{feed,season,wireSha256:input.artifact.sha256,wireBytes:source.length});
  const request = { profileId:input.profile.id,rawGameId,rawTeam:"PHI",rawPlayerId:feed === "player" ? "00-0000001" : null,cutoff:NORMALIZATION_CUTOFF };
  const replay = selectCompressedSourceClaim(request,[{ profileId:input.profile.id,feed,season,rows:prepared.rows,
    capture:{id:input.captureId,runId:input.id,artifactId:input.artifact.id,capturedAt:input.capturedAt,availableAt:input.capturedAt,
      ingestedAt:NORMALIZATION_CUTOFF,parsedRows:prepared.rows.length,sha256:input.artifact.sha256,storageRef:input.artifact.sha256+".csv.gz",byteSize:source.length},
    publication:{requestHash:digest(canonical(input)),claimsSha256:digest(canonical(prepared.rows)),recordedAt:NORMALIZATION_CUTOFF},
  }],NORMALIZATION_CUTOFF);
  return {...compressed,context:base.context,bridgeRows:base.bridgeRows,replay,request};
};
