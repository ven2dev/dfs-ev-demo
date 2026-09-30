import { describe, it, expect } from "vitest";
import { getCurrentNflWeek, getCurrentNflWeekLabel } from "./nflWeek.ts";

describe("getCurrentNflWeek", () => {
  it("is Week 1 on the Tuesday the season's first week begins", () => {
    expect(getCurrentNflWeek(new Date("2026-09-08T12:00:00Z"))).toBe(1);
  });

  it("stays Week 1 for the rest of that week, right up until the next Tuesday", () => {
    expect(getCurrentNflWeek(new Date("2026-09-14T23:00:00Z"))).toBe(1);
  });

  it("rolls over to Week 2 exactly at the next Tuesday boundary", () => {
    expect(getCurrentNflWeek(new Date("2026-09-15T00:00:00Z"))).toBe(2);
  });

  it("matches the real cross-check: 2026-09-29 (the day after a real Week 3 MNF game, the day a real Week 4 game was fetched live) is Week 4", () => {
    expect(getCurrentNflWeek(new Date("2026-09-29T12:00:00Z"))).toBe(4);
  });

  it("returns a number less than 1 before the season has started, not a clamped Week 1", () => {
    expect(getCurrentNflWeek(new Date("2026-08-01T00:00:00Z"))).toBeLessThan(1);
  });

  it("keeps counting past the 18-week regular season into the numeric playoff weeks", () => {
    expect(getCurrentNflWeek(new Date("2027-01-15T00:00:00Z"))).toBeGreaterThan(18);
  });
});

describe("getCurrentNflWeekLabel", () => {
  it("labels a real in-season date as 'Week N'", () => {
    expect(getCurrentNflWeekLabel(new Date("2026-09-29T12:00:00Z"))).toBe("Week 4");
  });

  it("labels a pre-season date as 'preseason', not a misleading 'Week 1'", () => {
    expect(getCurrentNflWeekLabel(new Date("2026-08-01T00:00:00Z"))).toBe("preseason");
  });

  it("labels a date past the 18-week regular season as 'playoffs', not a fabricated week number", () => {
    expect(getCurrentNflWeekLabel(new Date("2027-01-15T00:00:00Z"))).toBe("playoffs");
  });
});
