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
import { CommandError } from "./commands.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";
import { appendPrivateLine, readPrivateTextOptional, withPrivateFileLock } from "./privateOutput.ts";

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
}: {
  path: string;
  discovery: DiscoveryFile;
  now: () => Date;
  lock?: { timeoutMs?: number; staleMs?: number };
}) => {
  let queue: Promise<unknown> = Promise.resolve();

  const apply = async (request: CaptureRequest): Promise<CaptureEvent> => {
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
    append: (request: CaptureRequest): Promise<CaptureEvent> => {
      const run = queue.then(() => apply(request));
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
