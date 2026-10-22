import { createHash } from "node:crypto";

// Owner-captured transcripts for the creator corpus (#89). The capture log is
// an append-only sequence of events, one JSON object per line. Nothing is
// edited or deleted: a correction is a new `replaced` event that carries a
// reason, and the latest event for a video is its active state. Every event
// stores a hash and length of its text, and the whole log is re-verified when
// read, so a damaged or hand-edited file is refused rather than trusted.
export const CAPTURE_FORMAT_VERSION = 1;
export const CAPTURE_SOURCE = "manual-owner-paste";
export const CAPTURE_USAGE_STATUS = "internal-research-only";
export const MAX_TRANSCRIPT_BYTES = 512_000;
// Anything shorter is probably a partial copy and needs an explicit confirmation.
export const SHORT_TRANSCRIPT_CHARACTERS = 200;
export const NOTE_MAX_LENGTH = 500;
export const EARLIEST_PUBLISHED_DATE = "2005-04-23";
export const CAPTION_KINDS = ["unknown", "auto-generated", "uploaded"] as const;

export type CaptionKind = (typeof CAPTION_KINDS)[number];
export type CaptureEventType = "captured" | "replaced" | "unavailable";
export type CaptureAction = "capture" | "replace" | "unavailable";

export type CaptureEvent = {
  formatVersion: typeof CAPTURE_FORMAT_VERSION;
  creatorKey: string;
  videoId: string;
  event: CaptureEventType;
  capturedAt: string;
  source: typeof CAPTURE_SOURCE;
  usageStatus: typeof CAPTURE_USAGE_STATUS;
  // The date the owner confirmed from the video page (YYYY-MM-DD). Day
  // precision only: the page shows no time. Every event carries one.
  publishedDate: string;
  captionKind: CaptionKind | null;
  text: string | null;
  sha256: string | null;
  characters: number | null;
  reason: string | null;
  note: string | null;
};

export type CaptureRequest = {
  creatorKey: string;
  videoId: string;
  action: CaptureAction;
  text?: string;
  publishedDate?: string;
  captionKind?: string;
  note?: string;
  reason?: string;
  confirmShort?: boolean;
};

export class CaptureError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class CaptureLogError extends Error {
  code = "invalid-captures-file";
  line: number;
  constructor(line: number) {
    super("invalid-captures-file");
    this.line = line;
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CREATOR_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Control characters other than tab and newline never belong in a transcript.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EVENT_KEYS = [
  "capturedAt",
  "captionKind",
  "characters",
  "creatorKey",
  "event",
  "formatVersion",
  "note",
  "publishedDate",
  "reason",
  "sha256",
  "source",
  "text",
  "usageStatus",
  "videoId",
];

// Stored exactly as pasted except for line endings, so every character,
// timestamp and wording survives untouched for later extraction, and the hash
// describes exactly the text that was pasted.
export const normalizeTranscript = (raw: string): string => raw.replace(/\r\n?/g, "\n");

export const hashTranscript = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const checkTranscript = (text: string, { confirmShort = false }: { confirmShort?: boolean } = {}): string | null => {
  if (FORBIDDEN_CONTROL.test(text)) return "transcript-invalid-characters";
  if (!text.trim()) return "transcript-empty";
  if (Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES) return "transcript-too-large";
  if (text.length < SHORT_TRANSCRIPT_CHARACTERS && !confirmShort) return "transcript-too-short";
  return null;
};

const dateString = (value: Date): string => value.toISOString().slice(0, 10);

// A real calendar date, not before YouTube existed and not more than a day
// ahead of the capture time (allowing for time zones).
export const checkPublishedDate = (value: unknown, now: Date): string | null => {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return "invalid-published-date";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateString(parsed) !== value) return "invalid-published-date";
  if (value < EARLIEST_PUBLISHED_DATE) return "invalid-published-date";
  if (value > dateString(new Date(now.getTime() + 24 * 60 * 60 * 1000))) return "invalid-published-date";
  return null;
};

const trimmedOrNull = (value: unknown, tooLong: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CaptureError(tooLong);
  const trimmed = value.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) throw new CaptureError(tooLong);
  return trimmed === "" ? null : trimmed;
};

// Builds the event the store will append. The server, not the caller, supplies
// the time, source, usage status, hash and length. Throws CaptureError with a
// fixed code on any problem.
export const buildCaptureEvent = (request: CaptureRequest, now: Date): CaptureEvent => {
  const { creatorKey, videoId, action } = request;
  if (typeof creatorKey !== "string" || !CREATOR_KEY.test(creatorKey)) throw new CaptureError("invalid-creator-key");
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) throw new CaptureError("invalid-video-id");
  if (action !== "capture" && action !== "replace" && action !== "unavailable") throw new CaptureError("invalid-capture-action");

  const note = trimmedOrNull(request.note, "note-too-long");
  const reason = trimmedOrNull(request.reason, "reason-too-long");
  const base = {
    formatVersion: CAPTURE_FORMAT_VERSION,
    creatorKey,
    videoId,
    capturedAt: now.toISOString(),
    source: CAPTURE_SOURCE,
    usageStatus: CAPTURE_USAGE_STATUS,
    note,
  } as const;

  if (action === "unavailable") {
    const unavailableDateProblem = checkPublishedDate(request.publishedDate, now);
    if (unavailableDateProblem) throw new CaptureError(unavailableDateProblem);
    return {
      ...base,
      event: "unavailable",
      publishedDate: request.publishedDate as string,
      captionKind: null,
      text: null,
      sha256: null,
      characters: null,
      reason,
    };
  }

  if (action === "replace" && reason === null) throw new CaptureError("reason-required");
  if (typeof request.text !== "string") throw new CaptureError("transcript-empty");
  const text = normalizeTranscript(request.text);
  const problem = checkTranscript(text, { confirmShort: request.confirmShort === true });
  if (problem) throw new CaptureError(problem);
  const dateProblem = checkPublishedDate(request.publishedDate, now);
  if (dateProblem) throw new CaptureError(dateProblem);
  const captionKind = request.captionKind ?? "unknown";
  if (!(CAPTION_KINDS as readonly string[]).includes(captionKind)) throw new CaptureError("invalid-caption-kind");

  return {
    ...base,
    event: action === "capture" ? "captured" : "replaced",
    publishedDate: request.publishedDate as string,
    captionKind: captionKind as CaptionKind,
    text,
    sha256: hashTranscript(text),
    characters: text.length,
    reason: action === "replace" ? reason : null,
  };
};

export type CaptureState = "captured" | "unavailable";

// What a new event may follow. A captured video changes only by an explicit
// replace; an unavailable video can later be captured.
export const transitionProblem = (state: CaptureState | undefined, next: CaptureEventType): string | null => {
  if (state === undefined) return next === "replaced" ? "nothing-to-replace" : null;
  if (state === "captured") return next === "replaced" ? null : "already-captured";
  if (next === "captured") return null;
  return next === "unavailable" ? "already-unavailable" : "nothing-to-replace";
};

const stateAfter = (event: CaptureEvent): CaptureState => (event.event === "unavailable" ? "unavailable" : "captured");

// Structural check of one event as read back from the log. Hash and length
// are recomputed, so edited text or a damaged line is detected.
export const checkCaptureEvent = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== [...EVENT_KEYS].sort().join(",")) return false;
  const event = value as Record<string, unknown>;
  if (event.formatVersion !== CAPTURE_FORMAT_VERSION) return false;
  if (typeof event.creatorKey !== "string" || !CREATOR_KEY.test(event.creatorKey)) return false;
  if (typeof event.videoId !== "string" || !VIDEO_ID.test(event.videoId)) return false;
  if (typeof event.capturedAt !== "string" || !ISO_INSTANT.test(event.capturedAt) || Number.isNaN(Date.parse(event.capturedAt))) return false;
  if (event.source !== CAPTURE_SOURCE || event.usageStatus !== CAPTURE_USAGE_STATUS) return false;
  for (const field of ["note", "reason"] as const) {
    const text = event[field];
    if (text !== null && (typeof text !== "string" || text.length > NOTE_MAX_LENGTH || text.trim() !== text || text === "")) return false;
  }
  if (event.event === "unavailable") {
    return (
      checkPublishedDate(event.publishedDate, new Date(event.capturedAt)) === null &&
      event.captionKind === null && event.text === null && event.sha256 === null && event.characters === null
    );
  }
  if (event.event !== "captured" && event.event !== "replaced") return false;
  if (typeof event.text !== "string" || checkTranscript(event.text, { confirmShort: true }) !== null) return false;
  if (event.text !== normalizeTranscript(event.text)) return false;
  if (typeof event.sha256 !== "string" || !SHA256.test(event.sha256) || event.sha256 !== hashTranscript(event.text)) return false;
  if (event.characters !== event.text.length) return false;
  // A real calendar date, judged against the time it was captured.
  if (checkPublishedDate(event.publishedDate, new Date(event.capturedAt)) !== null) return false;
  if (!(CAPTION_KINDS as readonly string[]).includes(event.captionKind as string)) return false;
  return event.event === "replaced" ? event.reason !== null : event.reason === null;
};

const keyOf = (creatorKey: string, videoId: string) => `${creatorKey}:${videoId}`;

// Parses a whole log. Every line must be a valid event, every event must be
// legal after the ones before it, and the file must end with a newline (a
// missing one means the last write was cut short). Any failure refuses the
// whole file, and reports only the line number, never any content.
export const parseCaptureLog = (content: string): CaptureEvent[] => {
  if (content === "") return [];
  if (!content.endsWith("\n")) throw new CaptureLogError(content.split("\n").length);
  const lines = content.slice(0, -1).split("\n");
  const events: CaptureEvent[] = [];
  const states = new Map<string, CaptureState>();
  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CaptureLogError(index + 1);
    }
    if (!checkCaptureEvent(value)) throw new CaptureLogError(index + 1);
    const event = value as CaptureEvent;
    const key = keyOf(event.creatorKey, event.videoId);
    if (transitionProblem(states.get(key), event.event) !== null) throw new CaptureLogError(index + 1);
    states.set(key, stateAfter(event));
    events.push(event);
  });
  return events;
};

// The active state of every video that has any event.
export const activeCaptures = (events: readonly CaptureEvent[]): Map<string, { state: CaptureState; event: CaptureEvent }> => {
  const active = new Map<string, { state: CaptureState; event: CaptureEvent }>();
  for (const event of events) active.set(keyOf(event.creatorKey, event.videoId), { state: stateAfter(event), event });
  return active;
};

export const captureKey = keyOf;
