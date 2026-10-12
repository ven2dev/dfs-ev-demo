import { expect, it } from "vitest";
import { qualifySourceSamples } from "../../src/lib/predictive/sourceQualification.ts";
import { sourceGameId, sourceSamples } from "./fixtures/source.ts";

it("counts a QB with stats and a backup without stats without inferring participation, completion or coverage", () => {
  const report = qualifySourceSamples(sourceSamples(), 2026, sourceGameId);
  expect(report.target.kickoff).toBe("2026-10-18T17:00:00.000Z");
  expect(report.counts).toMatchObject({ playerRows: 1, playerQbRows: 1, playerCountPairs: 1, statsTeamSumMismatches: 0,
    qbRosterCandidates: 2, qbRosterWithStats: 1, qbRosterWithoutStats: 1, qbRosterStatsUnresolved: 0,
    offensiveParticipationConfirmed: 0, offensiveParticipationAbsent: 0, offensiveParticipationUnresolved: 2 });
  expect(report.featureStatus).toBe("unavailable-inputs"); expect(report.modelValidated).toBe(false);
  expect(report.reasons).toEqual(expect.arrayContaining(["completion-source-unqualified", "independent-schedule-enumeration-unqualified", "offensive-participation-unqualified"]));
});
it("reports missing and ambiguous identities separately and removes them from resolved roster/stat matches", () => {
  const samples = sourceSamples(); samples.identifiers = [{ gsis_id: "00-0000001", display_name: "A" }, { gsis_id: "00-0000001", display_name: "B" }];
  const report = qualifySourceSamples(samples, 2026, sourceGameId);
  expect(report.counts).toMatchObject({ playerIdentityAmbiguous: 1, playerIdentityMissing: 0, qbRosterIdentityAmbiguous: 1,
    qbRosterIdentityMissing: 1, qbRosterWithStats: 0, qbRosterWithoutStats: 0, qbRosterStatsUnresolved: 2 });
});
it("never arbitrarily resolves conflicting roster or player revisions", () => {
  const samples = sourceSamples(); samples.roster.push({ ...samples.roster[0], status: "RES" });
  samples.player.push({ ...samples.player[0], passing_yards: "81" });
  const report = qualifySourceSamples(samples, 2026, sourceGameId);
  expect(report.counts).toMatchObject({ rosterConflicts: 1, playerConflicts: 1, qbRosterCandidates: 2, qbRosterAmbiguous: 1,
    qbRosterStatsUnresolved: 1, qbRosterWithStats: 0, qbRosterWithoutStats: 1, statsTeamSumMismatches: 1 });
});
it("does not confuse a weekly roster with a per-game join when schedule or stats metadata conflicts", () => {
  const samples = sourceSamples(); samples.roster[1].week = "7"; samples.player[0].opponent_team = "BUF";
  expect(qualifySourceSamples(samples, 2026, sourceGameId).counts).toMatchObject({ qbRosterScheduleUnresolved: 1,
    playerScheduleUnresolved: 1, qbRosterStatsUnresolved: 2, qbRosterWithStats: 0, statsTeamSumMismatches: 1 });
});
it("checks pooled player/team parity with zeros and signed yards and exposes blanks/invalid counts", () => {
  const samples = sourceSamples(); samples.player[0].attempts = "0"; samples.player[0].passing_yards = "-3";
  samples.team[0].attempts = "0"; samples.team[0].passing_yards = "-3";
  expect(qualifySourceSamples(samples, 2026, sourceGameId).counts.statsTeamSumMismatches).toBe(0);
  samples.player[0].attempts = "";
  expect(qualifySourceSamples(samples, 2026, sourceGameId).counts).toMatchObject({ playerBlankPairs: 1, playerCountPairs: 0, statsTeamSumMismatches: 1 });
  samples.player[0].attempts = "-1";
  expect(qualifySourceSamples(samples, 2026, sourceGameId).counts.playerInvalidNumbers).toBe(1);
});
it("refuses a missing or ambiguous target and keeps same-source enumeration separate from independent coverage", () => {
  const samples = sourceSamples();
  expect(qualifySourceSamples(samples, 2026, sourceGameId).scope[0].gamesBySeason).toEqual([{ season: 2024, games: 0 }, { season: 2025, games: 0 }, { season: 2026, games: 1 }]);
  samples.schedule.push({ ...samples.schedule[0], gametime: "14:00" });
  expect(() => qualifySourceSamples(samples, 2026, sourceGameId)).toThrow("source-target-unresolved");
  expect(() => qualifySourceSamples({}, 2026, sourceGameId)).toThrow("source-target-unresolved");
});
