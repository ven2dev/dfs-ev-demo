import { expect, it } from "vitest";
import { easternKickoff, parseSourceCsv, sourceAsset, sourceInteger } from "../../src/lib/predictive/sourceAdapters.ts";
import { sourceCsv } from "./fixtures/source.ts";

it("projects selected fields while parsing quoted commas, newlines, quotes and BOM", async () => {
  const parsed = await parseSourceCsv("player", "\uFEFF" + sourceCsv("player", [{ player_id: "00-0000001", player_display_name: 'A, B\n"C"', fantasy_points: "999", passing_epa: "123", attempts: "0", passing_yards: "-3" }]), 2);
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.rows[0]).toMatchObject({ player_id: "00-0000001", player_display_name: 'A, B\n"C"', attempts: "0", passing_yards: "-3" });
  expect(parsed.rows[0]).not.toHaveProperty("fantasy_points"); expect(parsed.rows[0]).not.toHaveProperty("passing_epa");
  expect(parsed.excludedColumns).toContain("fantasy_points");
});
it.each(["extra", "missing", "reordered", "duplicate"])("refuses %s source-header drift", async (kind) => {
  const [first, ...rest] = sourceCsv("schedule").split("\n"); const header = first.split(",");
  if (kind === "extra") header.push("unreviewed");
  if (kind === "missing") header.pop();
  if (kind === "reordered") [header[0], header[1]] = [header[1], header[0]];
  if (kind === "duplicate") header[1] = header[0];
  await expect(parseSourceCsv("schedule", [header.join(","), ...rest].join("\n"), 10)).rejects.toThrow("source-header-drift");
});
it("refuses excess rows, empty CSV, malformed quoting and overlong records", async () => {
  await expect(parseSourceCsv("roster", sourceCsv("roster"), 1)).rejects.toThrow("source-row-budget-exceeded");
  await expect(parseSourceCsv("roster", sourceCsv("roster", []), 1)).rejects.toThrow("source-empty-csv");
  await expect(parseSourceCsv("player", sourceCsv("player") + '"unterminated', 10)).rejects.toThrow("source-csv-refused");
  await expect(parseSourceCsv("player", sourceCsv("player", [{ player_name: "x".repeat(70_000) }]), 10)).rejects.toThrow("source-csv-refused");
});
it.each([0, -1, 80_001, 1.1])( "refuses row bound %s before parsing", async (limit) => {
  await expect(parseSourceCsv("player", sourceCsv("player"), limit)).rejects.toThrow("source-row-bound-refused");
});
it("keeps zero, signed yards and blank values distinct; refuses lossy numbers", () => {
  expect(sourceInteger("0", 0, 1000)).toBe(0); expect(sourceInteger("-3", -10000, 10000)).toBe(-3);
  expect(sourceInteger("", 0, 1000)).toBeNull(); expect(sourceInteger("NA", 0, 1000)).toBeNull();
  for (const value of ["-1", "1.1", " 2", "1e2", "NaN", "1001", "9007199254740993"]) expect(() => sourceInteger(value, 0, 1000)).toThrow("source-number-refused");
});
it("converts Eastern kickoff through summer/winter offsets, including late-night UTC rollover", () => {
  expect(easternKickoff("2026-10-18", "13:00")).toBe("2026-10-18T17:00:00.000Z");
  expect(easternKickoff("2026-01-18", "20:15")).toBe("2026-01-19T01:15:00.000Z");
  expect(easternKickoff("2026-10-18", "")).toBeNull();
});
it.each([["2026-03-08", "02:30"], ["2026-11-01", "01:30"], ["2026-02-30", "13:00"], ["2026-10-18", "24:00"]])("refuses nonexistent, ambiguous or invalid local kickoff %s %s", (day, time) => {
  expect(() => easternKickoff(day, time)).toThrow("source-kickoff-refused");
});
it("registers exact assets and limits this qualification profile to its sampled season", () => {
  expect(sourceAsset("player", 2026).name).toBe("stats_player_week_2026.csv");
  expect(sourceAsset("team", 2026).name).toBe("stats_team_week_2026.csv");
  expect(sourceAsset("roster", 2026).tag).toBe("weekly_rosters");
  for (const season of [2024, 2025, 2027]) expect(() => sourceAsset("depth", season)).toThrow("source-scope-refused");
});
