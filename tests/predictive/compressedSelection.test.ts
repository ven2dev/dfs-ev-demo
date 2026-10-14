import { expect, it } from "vitest";
import { selectCompressedSourceClaim, type VerifiedCompressedSnapshot } from "../../src/lib/predictive/compressedSelection.ts";
import { projectScopedSourceClaim } from "../../src/lib/predictive/sourceClaims.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { sourceSamples } from "./fixtures/source.ts";

const request = { profileId: "stats", rawGameId: "2025_06_CAR_PHI", rawTeam: "PHI", rawPlayerId: "00-0000001", cutoff: "2026-10-13T12:00:00.000Z" };
const snapshot = (id = "capture", capturedAt = "2026-10-10T00:00:00.000Z", ingestedAt = capturedAt, yards = "80"): VerifiedCompressedSnapshot => {
  const rows = [projectScopedSourceClaim(id, "player", { ...sourceSamples().player[0], season: "2025", game_id: request.rawGameId, passing_yards: yards }, 1, 2025)];
  return { profileId: "stats", season: 2025, feed: "player", rows,
    capture: { id, runId: id, artifactId: id, capturedAt, availableAt: capturedAt, ingestedAt, parsedRows: 1,
      sha256: digest(yards), storageRef: digest(yards) + ".csv.gz", byteSize: 100 },
    publication: { requestHash: digest(id), claimsSha256: digest(canonical(rows)), recordedAt: ingestedAt } };
};

it("preserves historical visibility and chooses capture time instead of import order", () => {
  const old = snapshot("old", "2026-10-09T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "70");
  const latest = snapshot("latest");
  expect(selectCompressedSourceClaim(request, [old, latest], request.cutoff).evidence.captures[0].id).toBe("latest");
  expect(selectCompressedSourceClaim({ ...request, cutoff: "2026-10-09T12:00:00.000Z" }, [old, latest], request.cutoff).reason).toBe("source-capture-missing");
  latest.publication.recordedAt = "2026-10-13T11:00:00.000Z";
  expect(selectCompressedSourceClaim({ ...request, cutoff: "2026-10-13T10:00:00.000Z" }, [latest], request.cutoff).reason).toBe("source-capture-missing");
});

it("preserves conflicting snapshots missing participation and refused numeric claims", () => {
  expect(selectCompressedSourceClaim(request, [snapshot("a"), snapshot("b", undefined, undefined, "81")], request.cutoff).reason).toBe("source-capture-ambiguous");
  expect(selectCompressedSourceClaim({ ...request, rawPlayerId: "00-0000002" }, [snapshot()], request.cutoff).reason).toBe("source-row-missing");
  expect(selectCompressedSourceClaim(request, [snapshot("bad", undefined, undefined, "invalid")], request.cutoff).reason).toBe("source-row-refused");
});

it("rejects tampered seals ordinals receipt clocks duplicate inventory and future cutoffs", () => {
  for (const mutate of [
    (entry: VerifiedCompressedSnapshot) => { entry.rows[0].rowOrdinal = 2; },
    (entry: VerifiedCompressedSnapshot) => { entry.publication.claimsSha256 = "0".repeat(64); },
    (entry: VerifiedCompressedSnapshot) => { entry.capture.ingestedAt = "2026-10-09T00:00:00.000Z"; },
  ]) { const entry = snapshot(); mutate(entry); expect(() => selectCompressedSourceClaim(request, [entry], request.cutoff)).toThrow("compressed-selection-evidence-refused"); }
  expect(() => selectCompressedSourceClaim(request, [snapshot(), snapshot()], request.cutoff)).toThrow();
  expect(() => selectCompressedSourceClaim(request, [], "2026-10-12T00:00:00.000Z")).toThrow();
});

it("returns independent evidence with signed values and a reproducible digest", () => {
  const entry = snapshot("signed", undefined, undefined, "-2");
  const result = selectCompressedSourceClaim(request, [entry], request.cutoff);
  expect(result.status).toBe("observed-source-claim");
  expect(result.inputDigest).toBe(digest(canonical(result.evidence)));
  entry.rows.length = 0;
  expect(result.evidence.rows).toHaveLength(1);
  expect(result.featuresPublished).toBe(false);
  expect(result.labelsFinalized).toBe(false);
});
