import { describe, expect, it } from "vitest";
import { prepareSourceContextAssociations, type SourceContextAssociationRequest } from "../../src/lib/predictive/sourceContextAssociations.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { sourceContextFixture } from "./fixtures/sourceContext.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
const checkedAt = "2026-10-13T12:00:00.000Z";
const gameId = "00000000-0000-4000-8000-000000000001";
const otherGameId = "00000000-0000-4000-8000-000000000002";
function fixture(): SourceContextAssociationRequest {
  const source = sourceContextFixture();
  return { source, selections: [{ claimId: "context-row:" + digest(canonical([source.captureId, 1])), gameId, scheduleHead: null, bridgeHead: null }] };
}
function replaceRows(input: SourceContextAssociationRequest, rows = sourceSamples().schedule) {
  input.source.artifact.bytes = sourceCsv("schedule", rows);
  input.source.artifact.sha256 = digest(input.source.artifact.bytes);
}
describe("original schedule association preparation", () => {
  it("reconstructs the schedule and game bridge with exact physical row provenance", async () => {
    const result = await prepareSourceContextAssociations(fixture(), checkedAt), binding = result.bindings[0];
    expect(binding.schedule.data).toEqual({ gameId, rawGameId: "2026_06_CAR_PHI", season: 2026, seasonType: "REG", week: 6,
      kickoff: "2026-10-18T17:00:00.000Z", rawGameday: "2026-10-18", rawGametime: "13:00", homeTeamId: "nfl:team:PHI",
      awayTeamId: "nfl:team:CAR", rawHomeTeam: "PHI", rawAwayTeam: "CAR", rawRoof: null, rawSurface: null, rawStadiumId: null });
    expect(binding.bridge.data).toEqual({ provider: "nflverse", rawGameId: "2026_06_CAR_PHI", gameId });
    expect(binding).toMatchObject({ rowOrdinal: 1, expectedScheduleHead: null, expectedBridgeHead: null });
    expect(binding.schedule.predecessorId).toBeNull();
    expect(binding.selectedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({ canonicalEvidencePublished: false, featuresPublished: false, labelsFinalized: false,
      membershipEffectiveBounds: "unqualified", independentScheduleCoverage: "unqualified" });
    expect(Object.keys(result)).not.toContain("ingestedAt");
  });
  it("retains event identity when a later original capture corrects kickoff", async () => {
    const first = (await prepareSourceContextAssociations(fixture(), checkedAt)).bindings[0];
    const input = fixture(); input.source.id += "-correction"; input.source.captureId += "-correction"; input.source.artifact.id += "-correction";
    input.selections[0] = { ...input.selections[0], claimId: "context-row:" + digest(canonical([input.source.captureId, 1])),
      scheduleHead: first.schedule, bridgeHead: first.bridge };
    replaceRows(input, [{ ...sourceSamples().schedule[0], gametime: "16:25" }]);
    const corrected = (await prepareSourceContextAssociations(input, checkedAt)).bindings[0];
    expect(corrected.schedule.data.kickoff).toBe("2026-10-18T20:25:00.000Z");
    expect(corrected.schedule.data.gameId).toBe(gameId);
    expect(corrected.schedule.predecessorId).toBe(first.schedule.id);
    expect(corrected.expectedScheduleHead).toBe(first.schedule.id);
    expect(corrected.schedule.id).not.toBe(first.schedule.id);
    expect(corrected.bridge).toEqual(first.bridge);
  });
  it("reuses an unchanged revision instead of manufacturing a correction", async () => {
    const input = fixture(), first = (await prepareSourceContextAssociations(input, checkedAt)).bindings[0];
    input.selections[0].scheduleHead = first.schedule; input.selections[0].bridgeHead = first.bridge;
    const repeated = (await prepareSourceContextAssociations(input, checkedAt)).bindings[0];
    expect(repeated.schedule).toEqual(first.schedule); expect(repeated.bridge).toEqual(first.bridge);
  });
  it("refuses retargeting an existing game or using another source chain's head", async () => {
    const first = (await prepareSourceContextAssociations(fixture(), checkedAt)).bindings[0];
    for (const mutate of [
      (x: SourceContextAssociationRequest) => { x.selections[0].gameId = otherGameId; },
      (x: SourceContextAssociationRequest) => { x.selections[0].scheduleHead!.sourceRecordId = "another-source"; },
      (x: SourceContextAssociationRequest) => { x.selections[0].bridgeHead!.data.rawGameId = "2026_07_DAL_PHI"; },
    ]) {
      const input = fixture(); input.selections[0].scheduleHead = structuredClone(first.schedule); input.selections[0].bridgeHead = structuredClone(first.bridge);
      mutate(input); await expect(prepareSourceContextAssociations(input, checkedAt)).rejects.toThrow("context-association-head-refused");
    }
  });
  it("refuses unknown, out-of-scope, bad-time and conflicting source claims", async () => {
    const absent = fixture(); absent.selections[0].claimId = "missing";
    await expect(prepareSourceContextAssociations(absent, checkedAt)).rejects.toThrow("context-association-claim-refused");
    for (const rows of [
      [{ ...sourceSamples().schedule[0], season: "2023", game_id: "2023_06_CAR_PHI", gameday: "2023-10-15" }],
      [{ ...sourceSamples().schedule[0], gametime: "" }],
      [sourceSamples().schedule[0], { ...sourceSamples().schedule[0], gametime: "16:25" }],
    ]) { const input = fixture(); replaceRows(input, rows);
      await expect(prepareSourceContextAssociations(input, checkedAt)).rejects.toThrow("context-association-claim-refused"); }
  });
  it("allows selecting one exact duplicate but refuses two bindings for the same raw game", async () => {
    const input = fixture(); replaceRows(input, [sourceSamples().schedule[0], sourceSamples().schedule[0]]);
    expect((await prepareSourceContextAssociations(input, checkedAt)).bindings).toHaveLength(1);
    input.selections.push({ ...input.selections[0], claimId: "context-row:" + digest(canonical([input.source.captureId, 2])), gameId: otherGameId });
    await expect(prepareSourceContextAssociations(input, checkedAt)).rejects.toThrow("context-association-identity-conflict");
  });
  it("refuses mapping two distinct raw games onto one canonical event", async () => {
    const input = fixture(); replaceRows(input, [sourceSamples().schedule[0], { ...sourceSamples().schedule[0], game_id: "2026_07_DAL_PHI", week: "7", away_team: "DAL" }]);
    input.selections.push({ ...input.selections[0], claimId: "context-row:" + digest(canonical([input.source.captureId, 2])) });
    await expect(prepareSourceContextAssociations(input, checkedAt)).rejects.toThrow("context-association-identity-conflict");
  });
  it("pins both source bytes and requested canonical assignments before parsing awaits", async () => {
    const input = fixture(), pending = prepareSourceContextAssociations(input, checkedAt);
    input.selections[0].gameId = otherGameId; input.source.artifact.bytes = "forged";
    expect((await pending).bindings[0].schedule.data.gameId).toBe(gameId);
  });
  it("makes association identity independent of selection order while pinning unselected original bytes", async () => {
    const input = fixture(); replaceRows(input, [sourceSamples().schedule[0], { ...sourceSamples().schedule[0], game_id: "2026_07_DAL_PHI", week: "7", away_team: "DAL" }]);
    input.selections.push({ ...input.selections[0], claimId: "context-row:" + digest(canonical([input.source.captureId, 2])), gameId: otherGameId });
    const first = await prepareSourceContextAssociations(input, checkedAt);
    input.selections.reverse();
    expect(await prepareSourceContextAssociations(input, checkedAt)).toEqual(first);
    // A trailing blank line changes the retained wire hash but no projected row.
    input.source.artifact.bytes += "\n"; input.source.artifact.sha256 = digest(input.source.artifact.bytes);
    const changed = await prepareSourceContextAssociations(input, checkedAt);
    expect(changed.bindings).toEqual(first.bindings);
    expect(changed.associationSha256).not.toBe(first.associationSha256);
  });
  it("refuses injected revision data or caller knowledge clocks and bounds the selection set", async () => {
    const extra = fixture(); Object.assign(extra.selections[0], { kickoff: "2000-01-01T00:00:00.000Z" });
    await expect(prepareSourceContextAssociations(extra, checkedAt)).rejects.toThrow("schema-fields-refused");
    const clock = fixture(); Object.assign(clock, { ingestedAt: checkedAt });
    await expect(prepareSourceContextAssociations(clock, checkedAt)).rejects.toThrow("schema-fields-refused");
    for (const count of [0, 257]) { const input = fixture(); input.selections = Array(count).fill(input.selections[0]);
      await expect(prepareSourceContextAssociations(input, checkedAt)).rejects.toThrow("context-association-bounds-refused"); }
  });
  it("authenticates original bytes and current research rights before preparing associations", async () => {
    const damaged = fixture(); damaged.source.artifact.bytes += "\n";
    await expect(prepareSourceContextAssociations(damaged, checkedAt)).rejects.toThrow("artifact-integrity-failed");
    const revoked = fixture(); revoked.source.rightsDecisions[0].effectiveTo = "2026-10-12T00:00:00.000Z";
    await expect(prepareSourceContextAssociations(revoked, checkedAt)).rejects.toThrow("context-publication-rights-refused");
    const identity = fixture(); identity.source = sourceContextFixture("identifiers");
    await expect(prepareSourceContextAssociations(identity, checkedAt)).rejects.toThrow("context-association-feed-refused");
  });
});
