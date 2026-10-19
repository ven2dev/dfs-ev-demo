import { describe, it, expect } from "vitest";
import {
  getCurrentNflSlateWindow,
  getCurrentNflWeek,
  getCurrentNflWeekLabel,
  isEventInNflSlateWindow,
} from "./nflWeek.ts";

describe("getCurrentNflWeek", () => {
  it("is Week 1 on the Tuesday the season's first week begins", () => {
    expect(getCurrentNflWeek(new Date("2026-09-08T12:00:00Z"))).toBe(1);
  });

  it("stays Week 1 for the rest of that week, right up until the next Tuesday", () => {
    expect(getCurrentNflWeek(new Date("2026-09-14T23:00:00Z"))).toBe(1);
  });

  it("does not roll over at Tuesday 00:00 UTC while Monday Night Football is still underway", () => {
    expect(getCurrentNflWeek(new Date("2026-09-15T01:00:00Z"))).toBe(1);
  });

  it("rolls over to Week 2 at Tuesday midnight Eastern", () => {
    expect(getCurrentNflWeek(new Date("2026-09-15T04:00:00Z"))).toBe(2);
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

describe("getCurrentNflSlateWindow", () => {
  it("returns the authoritative Week 4 half-open window in Eastern time", () => {
    expect(getCurrentNflSlateWindow(new Date("2026-09-30T12:00:00Z"))).toEqual({
      label: "Week 4",
      week: 4,
      phase: "regular-season",
      startTime: "2026-09-29T04:00:00.000Z",
      endTime: "2026-10-06T04:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it("accounts for the daylight-saving offset when constructing later windows", () => {
    const window = getCurrentNflSlateWindow(new Date("2026-11-03T12:00:00Z"));
    expect(window.startTime).toBe("2026-11-03T05:00:00.000Z");
    expect(window.endTime).toBe("2026-11-10T05:00:00.000Z");
  });

  it("includes the start and excludes the end of the window", () => {
    const window = getCurrentNflSlateWindow(new Date("2026-09-30T12:00:00Z"));
    expect(isEventInNflSlateWindow(window.startTime, window)).toBe(true);
    expect(isEventInNflSlateWindow("2026-10-06T03:59:59.999Z", window)).toBe(true);
    expect(isEventInNflSlateWindow(window.endTime, window)).toBe(false);
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
