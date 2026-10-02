import {
  getCurrentNflSlateWindow,
  getNflCalendarDate,
  nflCalendarDateToDayNumber,
  nflDayNumberToCalendarDate,
  nflLocalDateTimeToInstant,
} from "./nflWeek";
import type { SlateEvent } from "./oddsApi";

export const ODDS_COLLECTION_PROFILES = [
  "disabled",
  "free-pilot",
  "paid-baseline",
] as const;

export type OddsCollectionProfile = (typeof ODDS_COLLECTION_PROFILES)[number];

export type BaselineCheckpointKey =
  | "tuesday-opening"
  | "wednesday-evening"
  | "thursday-evening"
  | "friday-final-practice"
  | "saturday-evening"
  | "t-6h"
  | "t-15m";

export type PlannedOddsCheckpoint = {
  eventId: string;
  kind: "baseline" | "priority";
  checkpointKey: string;
  dueAt: string;
  dueWindowEnd: string;
};

export type BaselineEventSelection = {
  event: SlateEvent;
  reason: "explicit-override" | "latest-sunday" | "full-slate";
};

const EVENING_CHECKPOINTS: readonly {
  dayOffsetFromTuesday: number;
  checkpointKey: BaselineCheckpointKey;
}[] = [
  { dayOffsetFromTuesday: 0, checkpointKey: "tuesday-opening" },
  { dayOffsetFromTuesday: 1, checkpointKey: "wednesday-evening" },
  { dayOffsetFromTuesday: 2, checkpointKey: "thursday-evening" },
  { dayOffsetFromTuesday: 3, checkpointKey: "friday-final-practice" },
  { dayOffsetFromTuesday: 4, checkpointKey: "saturday-evening" },
];

const sundayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});

const validCommenceTime = (event: SlateEvent) => {
  const value = Date.parse(event.commenceTime);
  if (!Number.isFinite(value)) {
    throw new Error(`Event "${event.id}" has an invalid commenceTime`);
  }
  return value;
};

export const parseOddsCollectionProfile = (
  value: string | undefined
): OddsCollectionProfile => {
  if (value === undefined || value.trim() === "") return "disabled";
  if ((ODDS_COLLECTION_PROFILES as readonly string[]).includes(value)) {
    return value as OddsCollectionProfile;
  }
  throw new Error(`Unknown odds collection profile "${value}"`);
};

export const selectBaselineEvents = (
  profile: OddsCollectionProfile,
  events: SlateEvent[],
  options: { freePilotEventId?: string } = {}
): BaselineEventSelection[] => {
  if (profile === "disabled") return [];

  const sorted = [...events].sort(
    (left, right) =>
      validCommenceTime(left) - validCommenceTime(right) || left.id.localeCompare(right.id)
  );
  if (profile === "paid-baseline") {
    return sorted.map((event) => ({ event, reason: "full-slate" }));
  }

  if (options.freePilotEventId) {
    const event = sorted.find((candidate) => candidate.id === options.freePilotEventId);
    if (!event) {
      throw new Error(
        `Free-pilot event override "${options.freePilotEventId}" is not in the current slate`
      );
    }
    return [{ event, reason: "explicit-override" }];
  }

  const sundayEvents = sorted.filter(
    (event) => sundayFormatter.format(new Date(event.commenceTime)) === "Sun"
  );
  const event = sundayEvents.at(-1);
  return event ? [{ event, reason: "latest-sunday" }] : [];
};

export const planBaselineCheckpoints = (
  event: SlateEvent,
  options: { eveningHourEastern?: number } = {}
): PlannedOddsCheckpoint[] => {
  const kickoffMs = validCommenceTime(event);
  const eveningHourEastern = options.eveningHourEastern ?? 20;
  if (!Number.isInteger(eveningHourEastern) || eveningHourEastern < 0 || eveningHourEastern > 23) {
    throw new Error("eveningHourEastern must be an integer from 0 through 23");
  }

  const kickoff = new Date(kickoffMs);
  const eventDayNumber = nflCalendarDateToDayNumber(getNflCalendarDate(kickoff));
  const week = getCurrentNflSlateWindow(kickoff);
  const tuesdayDayNumber = nflCalendarDateToDayNumber(
    getNflCalendarDate(new Date(week.startTime))
  );

  const checkpoints: Omit<PlannedOddsCheckpoint, "dueWindowEnd">[] = EVENING_CHECKPOINTS.flatMap(
    ({ dayOffsetFromTuesday, checkpointKey }) => {
      const dayNumber = tuesdayDayNumber + dayOffsetFromTuesday;
      if (dayNumber >= eventDayNumber) return [];
      const dueAt = nflLocalDateTimeToInstant(
        nflDayNumberToCalendarDate(dayNumber),
        eveningHourEastern
      );
      return dueAt.getTime() < kickoffMs
        ? [{ eventId: event.id, kind: "baseline" as const, checkpointKey, dueAt: dueAt.toISOString() }]
        : [];
    }
  );

  checkpoints.push(
    {
      eventId: event.id,
      kind: "baseline",
      checkpointKey: "t-6h",
      dueAt: new Date(kickoffMs - 6 * 60 * 60 * 1000).toISOString(),
    },
    {
      eventId: event.id,
      kind: "baseline",
      checkpointKey: "t-15m",
      dueAt: new Date(kickoffMs - 15 * 60 * 1000).toISOString(),
    }
  );

  const sorted = checkpoints.sort(
    (left, right) =>
      Date.parse(left.dueAt) - Date.parse(right.dueAt) ||
      left.checkpointKey.localeCompare(right.checkpointKey)
  );
  return sorted.map((checkpoint, index) => ({
    ...checkpoint,
    dueWindowEnd: sorted[index + 1]?.dueAt ?? kickoff.toISOString(),
  }));
};

export const planPriorityCheckpoints = (
  input: {
    targetId: string;
    eventId: string;
    activatedAt: Date;
    eventStartTime: Date;
  },
  options: { farIntervalMs?: number; activeIntervalMs?: number } = {}
): PlannedOddsCheckpoint[] => {
  const activatedAtMs = input.activatedAt.getTime();
  const kickoffMs = input.eventStartTime.getTime();
  if (!Number.isFinite(activatedAtMs) || !Number.isFinite(kickoffMs)) {
    throw new Error("Priority target times must be valid dates");
  }
  if (activatedAtMs >= kickoffMs) {
    throw new Error("Priority target must be activated before kickoff");
  }
  if (input.targetId.trim().length === 0 || input.eventId.trim().length === 0) {
    throw new Error("Priority target and event ids must not be empty");
  }

  const farIntervalMs = options.farIntervalMs ?? 60 * 60 * 1000;
  const activeIntervalMs = options.activeIntervalMs ?? 5 * 60 * 1000;
  if (!Number.isInteger(farIntervalMs) || farIntervalMs <= 0) {
    throw new Error("farIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(activeIntervalMs) || activeIntervalMs <= 0) {
    throw new Error("activeIntervalMs must be a positive integer");
  }

  const activeWindowStartMs = kickoffMs - 6 * 60 * 60 * 1000;
  const dueTimes = [activatedAtMs];
  let cursor = activatedAtMs;
  while (cursor < kickoffMs) {
    cursor =
      cursor < activeWindowStartMs
        ? Math.min(cursor + farIntervalMs, activeWindowStartMs)
        : cursor + activeIntervalMs;
    if (cursor < kickoffMs && cursor !== dueTimes.at(-1)) dueTimes.push(cursor);
    if (dueTimes.length > 2_000) {
      throw new Error("Priority target schedule exceeds the supported checkpoint limit");
    }
  }

  return dueTimes.map((dueAtMs, index) => ({
    eventId: input.eventId,
    kind: "priority",
    checkpointKey: `priority:${input.targetId}:${index}`,
    dueAt: new Date(dueAtMs).toISOString(),
    dueWindowEnd: new Date(dueTimes[index + 1] ?? kickoffMs).toISOString(),
  }));
};
