// This app supports NFL only. Resolve accepted input to the constant so
// request-provided sport names never become part of a provider URL.
export const DEFAULT_SPORT_KEY = "americanfootball_nfl";

export const isSupportedOddsSport = (sportKey: string): boolean =>
  sportKey === DEFAULT_SPORT_KEY;

export const requireOddsSport = (sportKey: string): typeof DEFAULT_SPORT_KEY => {
  if (!isSupportedOddsSport(sportKey)) {
    throw new Error("Only americanfootball_nfl is supported");
  }
  return DEFAULT_SPORT_KEY;
};

// Opaque provider and fixture IDs must occupy exactly one path segment.
// Reject dots, percent escapes, separators, whitespace, and URL syntax;
// 128 characters leaves room for IDs without accepting unbounded input.
export const isSafeOddsEventId = (eventId: string): boolean =>
  eventId.length >= 1 && eventId.length <= 128 && !/[^A-Za-z0-9_-]/.test(eventId);

export const requireOddsEventId = (eventId: string): string => {
  if (!isSafeOddsEventId(eventId)) {
    throw new Error("Invalid eventId");
  }
  return eventId;
};
