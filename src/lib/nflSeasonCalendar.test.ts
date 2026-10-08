import { describe, expect, it } from "vitest";
import weekBounds from "../../tests/fixtures/nfl-regular-season-week-bounds-2024-2026.json";
import {
  NFL_REGULAR_SEASON_WEEKS,
  getNflRegularSeasonWeek,
  getNflRegularSeasonWeekWindow,
  getRegisteredNflSeasons,
} from "./nflSeasonCalendar.ts";
import {
  getCurrentNflSlateWindow,
  getCurrentNflWeek,
  nflCalendarDateToDayNumber,
  nflDayNumberToCalendarDate,
  nflLocalDateTimeToInstant,
} from "./nflWeek.ts";

// "2024-09-05T20:20" is Eastern wall-clock time, as published by nflverse.
const kickoffInstant = (local: string): Date => {
  const [date, time] = local.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return nflLocalDateTimeToInstant({ year, month, day }, hour, minute);
};

describe("getNflRegularSeasonWeekWindow", () => {
  it("starts each season's Week 1 at Tuesday midnight Eastern", () => {
    expect(getNflRegularSeasonWeekWindow(2024, 1)?.startTime).toBe("2024-09-03T04:00:00.000Z");
    expect(getNflRegularSeasonWeekWindow(2025, 1)?.startTime).toBe("2025-09-02T04:00:00.000Z");
    expect(getNflRegularSeasonWeekWindow(2026, 1)?.startTime).toBe("2026-09-08T04:00:00.000Z");
  });

  it("follows the daylight-saving change in 2024 without drifting off Tuesday midnight Eastern", () => {
    // EDT before Sunday 2024-11-03, EST after.
    expect(getNflRegularSeasonWeekWindow(2024, 9)).toMatchObject({
      startTime: "2024-10-29T04:00:00.000Z",
      endTime: "2024-11-05T05:00:00.000Z",
    });
    expect(getNflRegularSeasonWeekWindow(2024, 10)?.startTime).toBe("2024-11-05T05:00:00.000Z");
  });

  it("starts every window at Tuesday 00:00 Eastern, including weeks after a daylight-saving change", () => {
    // Kickoff data cannot distinguish a Tuesday boundary from a Wednesday one
    // (no games fall in between), so the convention is asserted directly.
    const easternParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    for (const season of getRegisteredNflSeasons()) {
      for (let week = 1; week <= NFL_REGULAR_SEASON_WEEKS; week++) {
        const { startTime } = getNflRegularSeasonWeekWindow(season, week)!;
        const parts = Object.fromEntries(
          easternParts.formatToParts(new Date(startTime)).map(({ type, value }) => [type, value])
        );
        expect(
          `${parts.weekday} ${parts.hour}:${parts.minute}`,
          `${season} week ${week}`
        ).toBe("Tuesday 00:00");
      }
    }
  });

  it("returns contiguous seven-day half-open windows across all 18 weeks", () => {
    for (const season of getRegisteredNflSeasons()) {
      for (let week = 1; week < NFL_REGULAR_SEASON_WEEKS; week++) {
        const current = getNflRegularSeasonWeekWindow(season, week);
        const next = getNflRegularSeasonWeekWindow(season, week + 1);
        expect(current?.endTime).toBe(next?.startTime);
      }
    }
  });

  it("returns null for unregistered seasons and out-of-range or non-integer weeks", () => {
    expect(getNflRegularSeasonWeekWindow(2023, 1)).toBeNull();
    expect(getNflRegularSeasonWeekWindow(2024, 0)).toBeNull();
    expect(getNflRegularSeasonWeekWindow(2024, 19)).toBeNull();
    expect(getNflRegularSeasonWeekWindow(2024, 1.5)).toBeNull();
  });
});

describe("getNflRegularSeasonWeek", () => {
  it("keeps Monday night in the old week and rolls over at Tuesday midnight Eastern", () => {
    expect(getNflRegularSeasonWeek(new Date("2024-09-10T03:59:59.999Z"))).toMatchObject({ season: 2024, week: 1 });
    expect(getNflRegularSeasonWeek(new Date("2024-09-10T04:00:00.000Z"))).toMatchObject({ season: 2024, week: 2 });
  });

  it("starts at Week 1 and ends after Week 18 of each season", () => {
    expect(getNflRegularSeasonWeek(new Date("2025-09-02T04:00:00.000Z"))).toMatchObject({ season: 2025, week: 1 });
    expect(getNflRegularSeasonWeek(new Date("2025-01-07T04:59:59.999Z"))).toMatchObject({ season: 2024, week: 18 });
    expect(getNflRegularSeasonWeek(new Date("2025-01-07T05:00:00.000Z"))).toBeNull();
  });

  it("returns null before a season, in the playoffs and offseason, and for invalid dates", () => {
    expect(getNflRegularSeasonWeek(new Date("2024-09-03T03:59:59.999Z"))).toBeNull();
    expect(getNflRegularSeasonWeek(new Date("2025-01-15T12:00:00Z"))).toBeNull();
    expect(getNflRegularSeasonWeek(new Date("2025-06-01T12:00:00Z"))).toBeNull();
    expect(getNflRegularSeasonWeek(new Date("2023-10-01T12:00:00Z"))).toBeNull();
    expect(getNflRegularSeasonWeek(new Date("not a date"))).toBeNull();
  });

  it("returns a window containing the instant it was asked about", () => {
    const instant = new Date("2025-10-12T17:00:00Z");
    const result = getNflRegularSeasonWeek(instant);
    expect(result).toMatchObject({ season: 2025, week: 6 });
    expect(Date.parse(result!.startTime)).toBeLessThanOrEqual(instant.getTime());
    expect(instant.getTime()).toBeLessThan(Date.parse(result!.endTime));
  });
});

describe("agreement with the nflverse schedule", () => {
  it("fixture covers 18 regular-season weeks for each registered season", () => {
    for (const season of getRegisteredNflSeasons()) {
      const weeks = weekBounds.weeks.filter((entry) => entry.season === season);
      expect(weeks.map((entry) => entry.week)).toEqual(
        Array.from({ length: NFL_REGULAR_SEASON_WEEKS }, (_, index) => index + 1)
      );
    }
    expect(weekBounds.weeks).toHaveLength(getRegisteredNflSeasons().length * NFL_REGULAR_SEASON_WEEKS);
  });

  it("places every week's first and last kickoff in that week's own window", () => {
    for (const { season, week, first, last } of weekBounds.weeks) {
      for (const kickoff of [first, last]) {
        expect(getNflRegularSeasonWeek(kickoffInstant(kickoff)), `${season} week ${week} ${kickoff}`).toMatchObject({
          season,
          week,
        });
      }
    }
  });

  it("keeps every week's first kickoff after the previous week's last kickoff", () => {
    const sorted = [...weekBounds.weeks].sort((a, b) => a.season - b.season || a.week - b.week);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].season !== sorted[index - 1].season) continue;
      expect(kickoffInstant(sorted[index].first).getTime()).toBeGreaterThan(
        kickoffInstant(sorted[index - 1].last).getTime()
      );
    }
  });
});

describe("agreement with the existing current-season calendar", () => {
  it("matches getCurrentNflWeek and the slate window for every day of the 2026 regular season", () => {
    const weekOne = getNflRegularSeasonWeekWindow(2026, 1)!;
    const firstDay = nflCalendarDateToDayNumber({ year: 2026, month: 9, day: 8 });
    expect(weekOne.startTime).toBe(getCurrentNflSlateWindow(new Date("2026-09-09T12:00:00Z")).startTime);
    for (let offset = 0; offset < NFL_REGULAR_SEASON_WEEKS * 7; offset++) {
      const noon = nflLocalDateTimeToInstant(nflDayNumberToCalendarDate(firstDay + offset), 12, 0);
      const ours = getNflRegularSeasonWeek(noon)!;
      expect(ours.week).toBe(getCurrentNflWeek(noon));
      expect(ours.startTime).toBe(getCurrentNflSlateWindow(noon).startTime);
      expect(ours.endTime).toBe(getCurrentNflSlateWindow(noon).endTime);
    }
  });
});
