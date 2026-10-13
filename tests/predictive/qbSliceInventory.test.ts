import { describe, expect, it } from "vitest";
import { inventoryQbSlice, type SliceSamples } from "../../src/lib/predictive/qbSliceInventory.ts";
const request = { playerId: "00-0036389", rawTeam: "PHI", rawTargetGameId: "2026_07_DAL_PHI", proposedCutoff: "2026-10-26T23:15:00.000Z" };
const game = (id: string, season: number, week: number, date: string, away = "DAL", home = "PHI", gameType = "REG") =>
  ({ game_id: id, season: String(season), week: String(week), gameday: date, gametime: "13:00", away_team: away, home_team: home, game_type: gameType });
const stats = (gameId: string, team: string, opponent: string, season: number, week: number, attempts = "10", yards = "80") =>
  ({ game_id: gameId, team, opponent_team: opponent, season: String(season), week: String(week), season_type: "REG", player_id: request.playerId, attempts, passing_yards: yards });
function samples(): SliceSamples {
  return { identifiers: [{ gsis_id: request.playerId, position: "QB" }], schedule: [
    { ...game(request.rawTargetGameId, 2026, 7, "2026-10-26"), gametime: "20:15" },
    game("2026_06_CAR_PHI", 2026, 6, "2026-10-18", "CAR"),
    game("2026_05_TB_DAL", 2026, 5, "2026-10-11", "TB", "DAL"),
    game("2025_18_WAS_PHI", 2025, 18, "2026-01-04", "WAS"),
    game("2025_19_DAL_PHI", 2025, 19, "2026-01-11", "DAL", "PHI", "WC"),
    game("2023_18_DAL_PHI", 2023, 18, "2024-01-07"),
  ], player: [stats("2026_06_CAR_PHI", "PHI", "CAR", 2026, 6, "0", "-2")],
  team: [stats("2026_05_TB_DAL", "TB", "DAL", 2026, 5)], roster: [] };
}
describe("v1 QB slice discovery inventory", () => {
  it("preserves three-season coverage and separate opponent chronology without manufacturing readiness", () => {
    const report = inventoryQbSlice(samples(), request);
    expect(report.coverage).toMatchObject({ fromSeason: 2024, throughSeason: 2026, state: "independently-unqualified", knownFormerTeams: "not-qualified" });
    expect(report.player.map(row => row.rawGameId)).toEqual(["2026_06_CAR_PHI", "2025_18_WAS_PHI"]);
    expect(report.opposingOffenses.map(row => [row.rawGameId, row.rawOffenseTeam])).toEqual([["2026_05_TB_DAL", "TB"]]);
    expect(report.windows.player[0]).toEqual({ window: 4, expectedRawSlots: 2, observedRawPairs: 1, rawGameIds: ["2026_06_CAR_PHI", "2025_18_WAS_PHI"] });
    expect(report.player[0]).toMatchObject({ statistics: { values: { attempts: 0, passingYards: -2 } }, participation: "unqualified", rosterClaim: "missing" });
    expect(report.player[1]).toMatchObject({ sourceSeasonSupported: false, statistics: { state: "missing" } });
    expect(report.blockers).toContain("prior-season-publication-contract-unsupported");
    expect(report).toMatchObject({ featuresPublished: false, labelsFinalized: false, modelValidated: false, populationCoverage: "unqualified" });
  });
  it("keeps missing newest rows as slots rather than shifting backward", () => {
    const a = samples(); a.player = [];
    const report = inventoryQbSlice(a, request);
    expect(report.player[0].rawGameId).toBe("2026_06_CAR_PHI");
    expect(report.player[0].statistics).toMatchObject({ state: "missing", values: null });
    expect(report.windows.player[0].observedRawPairs).toBe(0);
  });
  it("is order-independent and exposes contradictory statistics", () => {
    const a = samples(), b = structuredClone(a);
    for (const rows of Object.values(b)) rows.reverse();
    expect(inventoryQbSlice(b, request)).toEqual(inventoryQbSlice(a, request));
    a.player!.push({ ...a.player![0], passing_yards: "1" });
    expect(inventoryQbSlice(a, request).player[0].statistics).toMatchObject({ state: "unresolved", reason: "statistics-conflicting", values: null });
  });
  it("refuses inconsistent target/identity/schedule and exact kickoff cutoffs", () => {
    const a = samples();
    expect(() => inventoryQbSlice(a, { ...request, playerId: "name-only" })).toThrow("slice-identity-refused");
    expect(() => inventoryQbSlice(a, { ...request, proposedCutoff: "2026-10-27T00:15:00.000Z" })).toThrow("slice-cutoff-not-pregame");
    a.schedule!.push({ ...a.schedule![0], gametime: "14:00" });
    expect(() => inventoryQbSlice(a, request)).toThrow("slice-target-unresolved");
    const b = samples(); b.schedule![1].away_team = "DAL";
    expect(() => inventoryQbSlice(b, request)).toThrow("slice-schedule-unresolved");
    const c = samples(); c.identifiers!.push({ ...c.identifiers![0], position: "RB" });
    expect(() => inventoryQbSlice(c, request)).toThrow("slice-player-unresolved");
  });
  it("counts at most sixteen chronological slots, with exact 4/8/16 IDs", () => {
    const a = samples();
    a.schedule = [a.schedule![0], ...Array.from({ length: 18 }, (_, i) => game(`2025_${String(i + 1).padStart(2, "0")}_DAL_PHI`, 2025, i + 1, `2025-12-${String(i + 1).padStart(2, "0")}`))];
    const r = inventoryQbSlice(a, request);
    expect(r.player).toHaveLength(16);
    expect(r.player[0].rawGameId).toBe("2025_18_DAL_PHI");
    expect(r.player.at(-1)!.rawGameId).toBe("2025_03_DAL_PHI");
    expect(r.windows.player.map(w => [w.window, w.expectedRawSlots])).toEqual([[4, 4], [8, 8], [16, 16]]);
    expect(r.windows.player[0].rawGameIds).toEqual(["2025_18_DAL_PHI", "2025_17_DAL_PHI", "2025_16_DAL_PHI", "2025_15_DAL_PHI"]);
  });
  it("does not treat roster ACT, paired zero or a positive raw claim as participation decisions", () => {
    const a = samples(); a.roster = [{ season: "2026", week: "6", game_type: "REG", team: "PHI", gsis_id: request.playerId, position: "QB", status: "ACT" }];
    a.player![0].attempts = "20";
    expect(inventoryQbSlice(a, request).player[0]).toMatchObject({ rosterClaim: "observed-weekly-qb-claim", participation: "unqualified", completion: "unqualified", canonicalBinding: "unqualified" });
  });
});
