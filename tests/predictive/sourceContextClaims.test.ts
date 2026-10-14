import { describe, expect, it } from "vitest";
import { prepareSourceContextClaims, type ContextRequest } from "../../src/lib/predictive/sourceContextClaims.ts";
import { digest } from "../../src/lib/predictive/validation.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
import type { SourceRow } from "../../src/lib/predictive/sourceAdapters.ts";
const prepare = (feed: ContextRequest["feed"], rows: SourceRow[]) => {
  const bytes = sourceCsv(feed, rows);
  return prepareSourceContextClaims(bytes, { captureId: "context-proof", feed, wireSha256: digest(bytes), wireBytes: Buffer.byteLength(bytes),
    seasonRange: feed === "schedule" ? { fromSeason: 2024, throughSeason: 2026 } : null });
};
const identity = { gsis_id: "00-0000001", position: "QB", espn_id: "123" };
describe("original-byte context claims", () => {
  it("retains every schedule ordinal including old seasons and refused identities without declaring coverage", async () => {
    const game = sourceSamples().schedule[0];
    const result = await prepare("schedule", [game, { ...game, game_id: "2023_06_CAR_PHI", season: "2023", gameday: "2023-10-18" }, { ...game, game_id: "bad" }]);
    expect(result.rows.map(r => [r.rowOrdinal, r.failureCode])).toEqual([[1, null], [2, "context-season-out-of-scope"], [3, "context-schedule-refused"]]);
    expect(result.rows[0].projection).toMatchObject({ kind: "raw-schedule", kickoff: "2026-10-18T17:00:00.000Z", rawHomeTeam: "PHI", rawAwayTeam: "CAR" });
    expect(result).toMatchObject({ canonicalEvidencePublished: false, independentScheduleCoverage: "unqualified", membershipEffectiveBounds: "unqualified", featuresPublished: false });
  });
  it("keeps POST chronology and refuses mismatched game teams or an ambiguous DST kickoff", async () => {
    const game = sourceSamples().schedule[0];
    const result = await prepare("schedule", [{ ...game, game_id: "2025_19_CAR_PHI", season: "2025", week: "19", game_type: "WC" },
      { ...game, away_team: "DAL" }, { ...game, game_id: "2026_07_CAR_PHI", week: "7", gameday: "2026-11-01", gametime: "01:30" },
      { ...game, gameday: "2020-10-18" }]);
    expect(result.rows[0].projection).toMatchObject({ seasonType: "POST", season: 2025 });
    // A second invalid version of the same raw key also withholds the valid
    // version; inspect the independent DST row separately.
    expect(result.rows[2].failureCode).toBe("source-kickoff-refused");
    expect(result.rows[1].failureCode).toBe("context-duplicate-key-conflict");
    expect(result.rows[3].failureCode).toBe("context-duplicate-key-conflict");
  });
  it("uses GSIS and namespaced crosswalks while excluding unselected columns from selected fingerprints", async () => {
    const result = await prepare("identifiers", [{ ...identity, headshot: "private unselected data" }]);
    expect(result.rows[0].projection).toEqual({ kind: "raw-player-identity", gsisId: "00-0000001", position: "QB",
      crosswalk: { nfl_id: null, espn_id: "123", pfr_id: null, esb_id: null, smart_id: null } });
    const changed = await prepare("identifiers", [{ ...identity, headshot: "changed unselected data" }]);
    expect(result.rows).toEqual(changed.rows);
    expect(result.claimsSha256).toBe(changed.claimsSha256);
    expect(result.request.wireSha256).not.toBe(changed.request.wireSha256);
  });
  it("withholds every differing duplicate raw identity rather than selecting the first", async () => {
    const result = await prepare("identifiers", [identity, { ...identity, espn_id: "456" }, { gsis_id: "00-0000002", position: "QB" }]);
    expect(result.rows.map(r => r.failureCode)).toEqual(["context-duplicate-key-conflict", "context-duplicate-key-conflict", null]);
    expect(result.rows.slice(0, 2).every(r => r.projection === null)).toBe(true);
  });
  it.each(["QB", "", "bad position"])("detects reverse crosswalk ambiguity even when the other row has position %j", async position => {
    const result = await prepare("identifiers", [identity, { ...identity, gsis_id: "00-0000002", position }]);
    expect(result.rows.map(r => r.failureCode)).toEqual(["context-reverse-identity-conflict", "context-reverse-identity-conflict"]);
  });
  it("distinguishes namespaces and retains exact duplicate rows without inventing bridges", async () => {
    const result = await prepare("identifiers", [identity, identity, { gsis_id: "00-0000002", position: "QB", nfl_id: "123" }]);
    expect(result.rows.every(r => r.failureCode === null)).toBe(true);
    expect(new Set(result.rows.map(r => r.id)).size).toBe(3);
    expect(result.rows[0].selectedSha256).toBe(result.rows[1].selectedSha256);
  });
  it("withholds an identity whose crosswalk also appears on an unresolved GSIS row", async () => {
    const result = await prepare("identifiers", [identity, { ...identity, gsis_id: "" }]);
    expect(result.rows.map(r => r.failureCode)).toEqual(["context-reverse-identity-conflict", "context-reverse-identity-conflict"]);
  });
  it("retains both conflicting schedule revisions and excludes neither by input order", async () => {
    const game = sourceSamples().schedule[0];
    const a = await prepare("schedule", [game, { ...game, gametime: "16:00" }]);
    const b = await prepare("schedule", [{ ...game, gametime: "16:00" }, game]);
    for (const result of [a, b]) {
      expect(result.rows.map(r => r.failureCode)).toEqual(["context-duplicate-key-conflict", "context-duplicate-key-conflict"]);
      expect(result.rows.every(r => r.projection === null)).toBe(true);
    }
  });
  it("refuses unknown feeds, supplied membership bounds, header drift and a false wire hash", async () => {
    const bytes = sourceCsv("identifiers", [identity]);
    const request: ContextRequest = { captureId: "proof", feed: "identifiers", wireSha256: digest(bytes), wireBytes: Buffer.byteLength(bytes), seasonRange: null };
    await expect(prepareSourceContextClaims(bytes, { ...request, wireSha256: "0".repeat(64) })).rejects.toThrow("artifact-integrity-failed");
    await expect(prepareSourceContextClaims(bytes, { ...request, feed: "roster" } as unknown as ContextRequest)).rejects.toThrow("context-request-refused");
    await expect(prepareSourceContextClaims(bytes, { ...request, effectiveFrom: "2020-01-01" } as ContextRequest)).rejects.toThrow();
    const drift = bytes.replace("gsis_id", "unknown_id");
    await expect(prepareSourceContextClaims(drift, { ...request, wireSha256: digest(drift), wireBytes: Buffer.byteLength(drift) })).rejects.toThrow("source-header-drift");
  });
  it("pins request scope before asynchronous parsing", async () => {
    const bytes = sourceCsv("schedule");
    const request: ContextRequest = { captureId: "proof", feed: "schedule", wireSha256: digest(bytes), wireBytes: Buffer.byteLength(bytes), seasonRange: { fromSeason: 2024, throughSeason: 2026 } };
    const pending = prepareSourceContextClaims(bytes, request);
    request.seasonRange!.throughSeason = 2025;
    expect((await pending).rows[0].projection).toMatchObject({ season: 2026 });
  });
});
