import { decodeCompressedSource, type CompressedInspectionRequest } from "./compressedSource.ts";
import { projectScopedSourceClaim } from "./sourceClaims.ts";
import { refuse } from "./validation.ts";

// Independent source claim preparation; not a writer or a rights authorization.
// Roster effective windows need their own adapter and cannot become numeric stats.
export async function prepareCompressedSourceClaims(captureId: string, source: Uint8Array,
  request: CompressedInspectionRequest, options: Parameters<typeof decodeCompressedSource>[2] = {}) {
  if (typeof captureId !== "string" || !captureId.trim() || captureId.length > 256 || /[\u0000-\u001f\u007f]/.test(captureId))
    refuse("source-publication-id-refused");
  if (request.feed !== "player" && request.feed !== "team") refuse("compressed-claims-feed-refused");
  // The decoder pins the request before awaiting; use its verified scope below.
  const { inspection, selectedRows } = await decodeCompressedSource(source, request, options);
  const feed = inspection.feed;
  if (feed !== "player" && feed !== "team") refuse("compressed-claims-feed-refused");
  const rows = selectedRows.map((row, index) => projectScopedSourceClaim(captureId, feed, row, index + 1, inspection.season));
  return { inspection, rows, publicationSupported: false, featuresPublished: false, labelsFinalized: false };
}
