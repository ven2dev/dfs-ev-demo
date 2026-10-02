export const NFL_TIME_ZONE = "America/New_York";
const REGULAR_SEASON_WEEKS = 18;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The NFL week containing the 2026 opener begins at midnight Tuesday
// in the league's Eastern-time calendar. Using a local calendar anchor
// instead of a fixed UTC instant keeps Monday night in the old week and
// continues to roll over correctly after daylight-saving time changes.
const WEEK_1_START_LOCAL = { year: 2026, month: 9, day: 8 } as const;

export type NflSlateWindow = {
  label: string;
  week: number;
  phase: "preseason" | "regular-season" | "playoffs";
  startTime: string;
  endTime: string;
  timeZone: typeof NFL_TIME_ZONE;
};

export type NflCalendarDate = { year: number; month: number; day: number };

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: NFL_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NFL_TIME_ZONE,
  timeZoneName: "longOffset",
});

export const getNflCalendarDate = (instant: Date): NflCalendarDate => {
  const parts = easternDateFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
};

export const nflCalendarDateToDayNumber = ({ year, month, day }: NflCalendarDate) =>
  Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);

export const nflDayNumberToCalendarDate = (dayNumber: number): NflCalendarDate => {
  const date = new Date(dayNumber * MS_PER_DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const getTimeZoneOffsetMs = (instant: Date): number => {
  const name = offsetFormatter
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = name?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Unable to resolve ${NFL_TIME_ZONE} offset`);
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000;
};

export const nflLocalDateTimeToInstant = (
  { year, month, day }: NflCalendarDate,
  hour = 0,
  minute = 0
): Date => {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(wallClockAsUtc - getTimeZoneOffsetMs(new Date(wallClockAsUtc)));
  result = new Date(wallClockAsUtc - getTimeZoneOffsetMs(result));
  return result;
};

const weekOneDayNumber = nflCalendarDateToDayNumber(WEEK_1_START_LOCAL);

// Not clamped to 1 -- a date before the season start legitimately
// produces 0 or negative, which is what lets getCurrentNflWeekLabel
// tell "before the season" apart from "Week 1" instead of conflating them.
export const getCurrentNflWeek = (now: Date = new Date()): number => {
  const currentDayNumber = nflCalendarDateToDayNumber(getNflCalendarDate(now));
  return Math.floor((currentDayNumber - weekOneDayNumber) / 7) + 1;
};

// A plain week number doesn't mean anything before the season starts or
// after the regular season ends -- those get their own honest label
// rather than a fabricated "Week 0" or "Week 21".
export const getCurrentNflWeekLabel = (now: Date = new Date()): string => {
  const week = getCurrentNflWeek(now);
  if (week < 1) return "preseason";
  if (week > REGULAR_SEASON_WEEKS) return "playoffs";
  return `Week ${week}`;
};

export const getCurrentNflSlateWindow = (now: Date = new Date()): NflSlateWindow => {
  const week = getCurrentNflWeek(now);
  const startDayNumber = weekOneDayNumber + (week - 1) * 7;
  const startTime = nflLocalDateTimeToInstant(nflDayNumberToCalendarDate(startDayNumber));
  const endTime = nflLocalDateTimeToInstant(nflDayNumberToCalendarDate(startDayNumber + 7));

  return {
    label: getCurrentNflWeekLabel(now),
    week,
    phase:
      week < 1 ? "preseason" : week > REGULAR_SEASON_WEEKS ? "playoffs" : "regular-season",
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    timeZone: NFL_TIME_ZONE,
  };
};

export const isEventInNflSlateWindow = (
  commenceTime: string,
  window: Pick<NflSlateWindow, "startTime" | "endTime">
): boolean => {
  const eventTime = Date.parse(commenceTime);
  return eventTime >= Date.parse(window.startTime) && eventTime < Date.parse(window.endTime);
};
