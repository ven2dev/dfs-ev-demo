import { activeCaptures, captureKey, type CaptionKind, type CaptureEvent } from "../../src/lib/creatorCaptures.ts";
import type { DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";
import { buildReviewState, type ReviewVideo } from "./reviewState.ts";

// What the capture page shows: which videos still need a transcript, which
// have one, which have none, and progress per creator and week. Built from the
// saved discovery data, the owner's decisions and the capture log, and never
// containing a transcript: a saved capture is summarised by its length, a short
// hash and a brief preview.
export const PREVIEW_LENGTH = 160;
export const DEFAULT_HINT_TIME_ZONE = "America/Los_Angeles";

export type QueueScope = "included" | "included-and-flagged";
export type QueueState = "needs-capture" | "captured" | "unavailable";

export type CaptureSummary = {
  event: "captured" | "replaced" | "unavailable";
  capturedAt: string;
  characters: number | null;
  hash: string | null;
  publishedDate: string | null;
  captionKind: CaptionKind | null;
  reason: string | null;
  note: string | null;
  preview: string | null;
  events: number;
};

export type QueueItem = {
  creatorKey: string;
  videoId: string;
  title: string;
  season: number;
  week: number;
  durationSeconds: number | null;
  reviewStatus: ReviewVideo["status"];
  // The API's publish instant, and the calendar date it falls on for the owner.
  // Hints only: the date stored with a capture is the one the owner confirms.
  publishedAt: string;
  publishedDateHint: string;
  state: QueueState;
  capture: CaptureSummary | null;
};

export type QueueCounts = { needsCapture: number | null; captured: number; unavailable: number; total: number | null };

export type QueueWeek = { season: number; week: number; needsCapture: number; captured: number; unavailable: number };

export type QueueCreator = {
  key: string;
  counts: QueueCounts;
  weeks: QueueWeek[];
  // The oldest video still needing a transcript, so the page can open on it.
  nextVideoId: string | null;
  items: QueueItem[];
};

export type CaptureQueueState = {
  generatedAt: string;
  scope: QueueScope;
  hintTimeZone: string;
  // While true the video list is withheld (API data past its limit) and only
  // the counts that come from the owner's own capture log are given.
  stale: { blocked: boolean; staleVideos: number; maxAgeDays: number; oldestFetchedAt: string | null };
  creators: QueueCreator[];
  // Captures in the log whose video is not in the queue right now (removed from
  // the data, out of scope, or excluded after capture). They stay in the log.
  capturesNotListed: number;
};

const calendarDate = (instant: string, timeZone: string): string => {
  const time = new Date(instant);
  if (Number.isNaN(time.getTime())) return "";
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
};

const preview = (text: string | null): string | null => {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? flat.slice(0, PREVIEW_LENGTH) + "…" : flat;
};

const summarise = (latest: CaptureEvent, events: number): CaptureSummary => ({
  event: latest.event,
  capturedAt: latest.capturedAt,
  characters: latest.characters,
  hash: latest.sha256 === null ? null : latest.sha256.slice(0, 12),
  publishedDate: latest.publishedDate,
  captionKind: latest.captionKind,
  reason: latest.reason,
  note: latest.note,
  preview: preview(latest.text),
  events,
});

export const buildCaptureQueue = ({
  discovery,
  decisions,
  captures,
  scope = "included",
  now,
  hintTimeZone = DEFAULT_HINT_TIME_ZONE,
}: {
  discovery: DiscoveryFile;
  decisions: DecisionsFile;
  captures: readonly CaptureEvent[];
  scope?: QueueScope;
  now: Date;
  hintTimeZone?: string;
}): CaptureQueueState => {
  const review = buildReviewState({ discovery, decisions, now });
  const active = activeCaptures(captures);
  const eventCounts = new Map<string, number>();
  for (const event of captures) {
    const key = captureKey(event.creatorKey, event.videoId);
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const blocked = review.stale.blocked;
  const listed = new Set<string>();

  const creators = review.creators.map((creator): QueueCreator => {
    const ownCaptured = [...active].filter(([key, value]) => key.startsWith(`${creator.key}:`) && value.state === "captured").length;
    const ownUnavailable = [...active].filter(([key, value]) => key.startsWith(`${creator.key}:`) && value.state === "unavailable").length;
    if (blocked) {
      return {
        key: creator.key,
        counts: { needsCapture: null, captured: ownCaptured, unavailable: ownUnavailable, total: null },
        weeks: [],
        nextVideoId: null,
        items: [],
      };
    }

    const items = creator.videos
      .filter((video) => video.season !== null && video.week !== null)
      .filter((video) => video.status === "present" || (scope === "included-and-flagged" && video.status === "needs-review"))
      .map((video): QueueItem => {
        const key = captureKey(creator.key, video.videoId);
        const current = active.get(key);
        listed.add(key);
        return {
          creatorKey: creator.key,
          videoId: video.videoId,
          title: video.title,
          season: video.season as number,
          week: video.week as number,
          durationSeconds: video.durationSeconds,
          reviewStatus: video.status,
          publishedAt: video.publishedAt,
          publishedDateHint: calendarDate(video.publishedAt, hintTimeZone),
          state: current ? current.state : "needs-capture",
          capture: current ? summarise(current.event, eventCounts.get(key) ?? 1) : null,
        };
      })
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.videoId.localeCompare(b.videoId));

    const weeks = new Map<string, QueueWeek>();
    for (const slot of creator.slots) {
      weeks.set(`${slot.season}-${slot.week}`, { season: slot.season, week: slot.week, needsCapture: 0, captured: 0, unavailable: 0 });
    }
    for (const item of items) {
      const week = weeks.get(`${item.season}-${item.week}`);
      if (!week) continue;
      if (item.state === "needs-capture") week.needsCapture += 1;
      else if (item.state === "captured") week.captured += 1;
      else week.unavailable += 1;
    }
    const needsCapture = items.filter((item) => item.state === "needs-capture");
    return {
      key: creator.key,
      counts: {
        needsCapture: needsCapture.length,
        captured: items.filter((item) => item.state === "captured").length,
        unavailable: items.filter((item) => item.state === "unavailable").length,
        total: items.length,
      },
      weeks: [...weeks.values()],
      nextVideoId: needsCapture[0]?.videoId ?? null,
      items,
    };
  });

  const capturesNotListed = blocked ? 0 : [...active.keys()].filter((key) => !listed.has(key)).length;

  return {
    generatedAt: now.toISOString(),
    scope,
    hintTimeZone,
    stale: review.stale,
    creators,
    capturesNotListed,
  };
};
