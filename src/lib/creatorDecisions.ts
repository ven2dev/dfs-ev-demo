import type { ReviewDecision } from "./creatorCorpusManifest.ts";

// Owner review decisions are an append-only event log: nothing is edited or
// deleted, so every reason and date stays on record. The latest event for a
// video is the active one, and `clear` withdraws an earlier include/exclude
// while keeping why and when it was withdrawn.
export const DECISION_REASON_MAX_LENGTH = 500;

export type DecisionKind = "include" | "exclude" | "clear";

export type DecisionEvent = {
  videoId: string;
  decision: DecisionKind;
  reason: string;
  ruleVersion: string;
  decidedAt: string;
};

export type DecisionsFile = Record<string, DecisionEvent[]>;

export type DecisionEventProblem =
  | "invalid-event"
  | "invalid-video-id"
  | "invalid-decision"
  | "reason-required"
  | "reason-too-long"
  | "invalid-rule-version"
  | "invalid-decided-at";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const RULE_VERSION = /^v[0-9]{1,3}$/;
const CREATOR_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The exact form `Date#toISOString` writes, so a hand-edited date is refused.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const EVENT_KEYS = ["decidedAt", "decision", "reason", "ruleVersion", "videoId"];

export const isCreatorKey = (value: string): boolean => CREATOR_KEY.test(value);

export const checkDecisionEvent = (value: unknown): DecisionEventProblem | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-event";
  if (Object.keys(value).sort().join(",") !== EVENT_KEYS.join(",")) return "invalid-event";
  const event = value as Record<string, unknown>;
  if (typeof event.videoId !== "string" || !VIDEO_ID.test(event.videoId)) return "invalid-video-id";
  if (event.decision !== "include" && event.decision !== "exclude" && event.decision !== "clear") {
    return "invalid-decision";
  }
  if (typeof event.reason !== "string" || !event.reason.trim()) return "reason-required";
  if (event.reason.length > DECISION_REASON_MAX_LENGTH) return "reason-too-long";
  if (typeof event.ruleVersion !== "string" || !RULE_VERSION.test(event.ruleVersion)) return "invalid-rule-version";
  if (
    typeof event.decidedAt !== "string" ||
    !ISO_INSTANT.test(event.decidedAt) ||
    Number.isNaN(Date.parse(event.decidedAt))
  ) {
    return "invalid-decided-at";
  }
  return null;
};

export class DecisionsFileError extends Error {
  code = "invalid-decisions-file";
  constructor() {
    super("invalid-decisions-file");
  }
}

// { "<creatorKey>": [event, ...] }. Any malformed entry rejects the whole file
// rather than silently dropping a decision the owner made.
export const parseDecisionsFile = (input: unknown): DecisionsFile => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new DecisionsFileError();
  const file: DecisionsFile = {};
  for (const [creatorKey, events] of Object.entries(input)) {
    if (!isCreatorKey(creatorKey) || !Array.isArray(events)) throw new DecisionsFileError();
    for (const event of events) if (checkDecisionEvent(event) !== null) throw new DecisionsFileError();
    file[creatorKey] = events as DecisionEvent[];
  }
  return file;
};

// The active decision per video: the latest event by decision time, with file
// order breaking ties. A final `clear` leaves the video with no override.
export const effectiveDecisions = (events: readonly DecisionEvent[]): ReviewDecision[] => {
  const latest = new Map<string, { event: DecisionEvent; time: number; index: number }>();
  events.forEach((event, index) => {
    const time = Date.parse(event.decidedAt);
    const current = latest.get(event.videoId);
    if (!current || time > current.time || (time === current.time && index > current.index)) {
      latest.set(event.videoId, { event, time, index });
    }
  });
  return [...latest.values()]
    .map(({ event }) => event)
    .filter((event): event is DecisionEvent & { decision: "include" | "exclude" } => event.decision !== "clear")
    .sort((a, b) => a.videoId.localeCompare(b.videoId))
    .map(({ videoId, decision, reason, ruleVersion, decidedAt }) => ({
      videoId,
      decision,
      reason,
      ruleVersion,
      decidedAt,
    }));
};

export const hasActiveDecision = (events: readonly DecisionEvent[], videoId: string): boolean =>
  effectiveDecisions(events).some((decision) => decision.videoId === videoId);
