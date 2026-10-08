import { getStaleVideoIds } from "../../src/lib/creatorCorpusManifest.ts";
import {
  CaptureError,
  CaptureLogError,
  activeCaptures,
  buildCaptureEvent,
  captureKey,
  parseCaptureLog,
  transitionProblem,
  type CaptureEvent,
  type CaptureRequest,
} from "../../src/lib/creatorCaptures.ts";
import type { DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import { CommandError } from "./commands.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";
import { appendPrivateLine, readPrivateTextOptional, withPrivateFileLock } from "./privateOutput.ts";
import { buildReviewState } from "./reviewState.ts";

export type CaptureScope = "included" | "included-and-flagged";

// A log that cannot be read is refused, never repaired or overwritten.
export const readCapturesFile = async (path: string): Promise<CaptureEvent[]> => {
  const content = await readPrivateTextOptional(path);
  if (content === undefined) return [];
  try {
    return parseCaptureLog(content);
  } catch (error) {
    if (error instanceof CaptureLogError) throw new CommandError("invalid-captures-file");
    throw error;
  }
};

// Appends owner-captured transcripts to the private capture log. Like the
// decision store, every append goes through an in-process queue and an
// exclusive file lock and re-reads the whole log inside them, so overlapping
// requests, in this process or another review process on the same log, cannot
// interleave or lose an event. The time, source, hash and length come from the
// server, never from the caller. Errors are fixed codes; a transcript is never
// part of an error.
export const createCaptureStore = ({
  path,
  discovery,
  now,
  lock,
  decisions = async () => ({}),
}: {
  path: string;
  discovery: DiscoveryFile;
  now: () => Date;
  lock?: { timeoutMs?: number; staleMs?: number };
  // The owner's current decisions, read at the moment of each save. A video
  // is captured only if it is in the queue the owner is working from.
  decisions?: () => Promise<DecisionsFile>;
}) => {
  let queue: Promise<unknown> = Promise.resolve();

  const apply = async (request: CaptureRequest, scope: CaptureScope): Promise<CaptureEvent> => {
    const instant = now();
    const stale = discovery.creators.flatMap((creator) => getStaleVideoIds(creator.videos, instant));
    if (stale.length > 0) throw new CommandError("stale-discovery-data");

    const creator = discovery.creators.find((entry) => entry.key === request.creatorKey);
    if (!creator) throw new CommandError("unknown-creator-key");
    const video = creator.manifest.videos.find((entry) => entry.videoId === request.videoId);
    if (!video) throw new CommandError("unknown-video");
    if (video.season === null || video.classification.reasons.includes("after-registered-end-week")) {
      throw new CommandError("video-outside-window");
    }

    // The queue is the authority on what may be captured, not the page. A
    // video the owner excluded, or one still flagged for review while the
    // narrower scope is chosen, is refused here even from a stale tab or a
    // direct request. A decision made just after a capture leaves the capture
    // in the log; the queue simply stops listing it.
    const status = buildReviewState({ discovery, decisions: await decisions(), now: instant }).creators
      .find((entry) => entry.key === request.creatorKey)
      ?.videos.find((entry) => entry.videoId === request.videoId)?.status;
    if (status !== "present" && !(status === "needs-review" && scope === "included-and-flagged")) {
      throw new CommandError("video-not-in-queue");
    }

    let event: CaptureEvent;
    try {
      event = buildCaptureEvent(request, instant);
    } catch (error) {
      if (error instanceof CaptureError) throw new CommandError(error.code);
      throw error;
    }

    return withPrivateFileLock(
      path,
      async () => {
        const events = await readCapturesFile(path);
        const state = activeCaptures(events).get(captureKey(event.creatorKey, event.videoId))?.state;
        const problem = transitionProblem(state, event.event);
        if (problem) throw new CommandError(problem);
        await appendPrivateLine(path, JSON.stringify(event));
        return event;
      },
      lock
    );
  };

  return {
    append: (request: CaptureRequest, scope: CaptureScope = "included"): Promise<CaptureEvent> => {
      const run = queue.then(() => apply(request, scope));
      queue = run.catch(() => undefined);
      return run;
    },
    read: (): Promise<CaptureEvent[]> => {
      const run = queue.then(() => readCapturesFile(path));
      queue = run.catch(() => undefined);
      return run;
    },
  };
};
