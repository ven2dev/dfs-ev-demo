import {
  NFL_TIME_ZONE,
  getNflCalendarDate,
  nflCalendarDateToDayNumber,
  nflDayNumberToCalendarDate,
  nflLocalDateTimeToInstant,
  type NflCalendarDate,
} from "./nflWeek.ts";

export const NFL_REGULAR_SEASON_WEEKS = 18;

// Historical regular-season calendar for the registered creator-corpus
// window (#88). nflWeek.ts is anchored to the current season only, so it
// cannot place an earlier season's date in a week.
//
// Each anchor is the Tuesday, in the league's Eastern calendar, that begins
// that season's first NFL week (the Tuesday on or before the opener).
// Weeks run Tuesday 00:00 to the next Tuesday 00:00 Eastern, which keeps
// Monday night in the old week and follows daylight-saving changes.
// Anchors were derived from the nflverse schedule and are checked against
// every week's first and last kickoff in the committed fixture.
const REGULAR_SEASON_WEEK_ONE_STARTS: readonly {
  season: number;
  weekOneStart: NflCalendarDate;
}[] = [
  { season: 2024, weekOneStart: { year: 2024, month: 9, day: 3 } },
  { season: 2025, weekOneStart: { year: 2025, month: 9, day: 2 } },
  { season: 2026, weekOneStart: { year: 2026, month: 9, day: 8 } },
];

export type NflRegularSeasonWeek = {
  season: number;
  week: number;
  startTime: string;
  endTime: string;
  timeZone: typeof NFL_TIME_ZONE;
};

export const getRegisteredNflSeasons = (): number[] =>
  REGULAR_SEASON_WEEK_ONE_STARTS.map(({ season }) => season);

export const getNflRegularSeasonWeekWindow = (
  season: number,
  week: number
): NflRegularSeasonWeek | null => {
  const anchor = REGULAR_SEASON_WEEK_ONE_STARTS.find((entry) => entry.season === season);
  if (!anchor || !Number.isInteger(week) || week < 1 || week > NFL_REGULAR_SEASON_WEEKS) {
    return null;
  }
  const startDayNumber = nflCalendarDateToDayNumber(anchor.weekOneStart) + (week - 1) * 7;
  return {
    season,
    week,
    startTime: nflLocalDateTimeToInstant(nflDayNumberToCalendarDate(startDayNumber)).toISOString(),
    endTime: nflLocalDateTimeToInstant(nflDayNumberToCalendarDate(startDayNumber + 7)).toISOString(),
    timeZone: NFL_TIME_ZONE,
  };
};

// Returns null outside every registered regular season (preseason, playoffs,
// offseason, unregistered seasons, invalid dates) instead of inventing a week.
export const getNflRegularSeasonWeek = (instant: Date): NflRegularSeasonWeek | null => {
  if (Number.isNaN(instant.getTime())) return null;
  const dayNumber = nflCalendarDateToDayNumber(getNflCalendarDate(instant));
  for (const { season, weekOneStart } of REGULAR_SEASON_WEEK_ONE_STARTS) {
    const offset = dayNumber - nflCalendarDateToDayNumber(weekOneStart);
    if (offset >= 0 && offset < NFL_REGULAR_SEASON_WEEKS * 7) {
      return getNflRegularSeasonWeekWindow(season, Math.floor(offset / 7) + 1);
    }
  }
  return null;
};
