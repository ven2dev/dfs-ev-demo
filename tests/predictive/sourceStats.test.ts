import { expect, it } from "vitest";
import { parseSourceCsv, type SourceRow } from "../../src/lib/predictive/sourceAdapters.ts";
import { hasPositiveSourceUsage, projectSourceStats, sourceStatsDigest } from "../../src/lib/predictive/sourceStats.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";

const player = () => ({ ...sourceSamples().player[0], attempts: "12", completions: "8", passing_yards: "95",
  passing_tds: "1", passing_interceptions: "2", carries: "3", rushing_yards: "-4", targets: "2", receptions: "1", receiving_yards: "7" });
it("projects all ten counts from exact CSV fields with raw identity and no prohibited inputs", async () => {
  const raw = { ...player(), fantasy_points: "999", passing_epa: "22", spread_line: "-8", latest_team: "BUF" };
  const parsed = await parseSourceCsv("player", sourceCsv("player", [raw]), 1);
  const result = projectSourceStats("player", parsed.rows[0]);
  expect(result).toMatchObject({ version: "nflverse-raw-stats-v1", feed: "player", rawGameId: "2026_06_CAR_PHI",
    rawPlayerId: "00-0000001", playerIdProvider: "gsis", rawTeam: "PHI", rawOpponent: "CAR", season: 2026, seasonType: "REG", week: 6,
    values: { attempts: 12, completions: 8, passingYards: 95, passingTds: 1, passingInterceptions: 2, carries: 3,
      rushingYards: -4, targets: 2, receptions: 1, receivingYards: 7 }, missing: {} });
  expect(Object.keys(result).sort()).toEqual(["version", "feed", "rawGameId", "rawTeam", "rawOpponent", "rawPlayerId",
    "playerIdProvider", "season", "seasonType", "week", "values", "missing"].sort());
  expect(result).not.toHaveProperty("gameId"); expect(result).not.toHaveProperty("playerId");
  expect(sourceStatsDigest(result)).toBe(sourceStatsDigest(projectSourceStats("player", player())));
});
it("projects team counts without attributing them to a player or inferring participation", () => {
  const result = projectSourceStats("team", player());
  expect(result.rawPlayerId).toBeNull(); expect(result.playerIdProvider).toBeNull(); expect(hasPositiveSourceUsage(result)).toBe(false);
});
it("preserves absent, blank, NA, true zero and negative yardage distinctly", () => {
  const raw: Record<string, string> = { ...player(), passing_tds: "", receptions: "NA", carries: "0", passing_yards: "-1" };
  delete raw.passing_interceptions;
  const result = projectSourceStats("player", raw);
  expect(result.values).toMatchObject({ passingTds: null, receptions: null, passingInterceptions: null, carries: 0, passingYards: -1 });
  expect(result.missing).toEqual({ passingTds: "source-blank", receptions: "source-blank", passingInterceptions: "source-missing" });
});
it.each(["-1", "1.5", "1e2", " 2", "NaN", "1001", "9007199254740993"])("refuses invalid counts %s", (value) => {
  expect(() => projectSourceStats("player", { ...player(), attempts: value })).toThrow("source-number-refused");
});
it.each(["-10001", "10001", "3.1"])("refuses invalid signed yardage %s", (value) => {
  expect(() => projectSourceStats("player", { ...player(), rushing_yards: value })).toThrow("source-number-refused");
});
it.each([{ attempts: "7", completions: "8" }, { targets: "0", receptions: "1" }])("refuses unpaired count relationships %j", (change) => {
  expect(() => projectSourceStats("player", { ...player(), ...change })).toThrow("source-stats-denominator-refused");
});
it.each<SourceRow>([{ week: "5" }, { season: "2025" }, { team: "BUF" }, { opponent_team: "PHI" }, { season_type: "PRE" },
  { season_type: "REG", game_type: "POST" }, { game_id: "2026_06_CAR_CAR" }])("refuses conflicting or unsupported game context %j", (change) => {
  expect(() => projectSourceStats("player", { ...player(), ...change })).toThrow("source-stats-context-refused");
});
it.each(["", "NA", "00-123", "00-0000001|raw", "123"])("refuses malformed GSIS raw identity %s", (player_id) => {
  expect(() => projectSourceStats("player", { ...player(), player_id })).toThrow("source-stats-player-refused");
});
it.each(["attempts", "carries", "targets"])("uses positive %s only as an individual offensive-participation claim", (field) => {
  const raw = { ...player(), attempts: "0", completions: "0", carries: "0", targets: "0", receptions: "0", [field]: "1" };
  expect(hasPositiveSourceUsage(projectSourceStats("player", raw))).toBe(true);
});
it("never treats zero counts, nonzero yards alone or missing usage counts as participation or absence", () => {
  const raw = { ...player(), attempts: "0", completions: "0", carries: "0", targets: "0", receptions: "0", passing_yards: "10" };
  expect(hasPositiveSourceUsage(projectSourceStats("player", raw))).toBe(false);
  expect(hasPositiveSourceUsage(projectSourceStats("player", { ...raw, attempts: "", carries: "NA", targets: "" }))).toBe(false);
});
