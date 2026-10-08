import {
  checkDecisionEvent,
  eventsFor,
  hasActiveDecision,
  parseDecisionsFile,
  type DecisionEvent,
  type DecisionKind,
  type DecisionsFile,
} from "../../src/lib/creatorDecisions.ts";
import { getStaleVideoIds } from "../../src/lib/creatorCorpusManifest.ts";
import { CommandError } from "./commands.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";
import { readPrivateJsonOptional, replacePrivateJson, withPrivateFileLock } from "./privateOutput.ts";

export type DecisionRequest = {
  creatorKey: string;
  videoId: string;
  decision: DecisionKind;
  reason: string;
};

export const readDecisionsFile = async (path: string): Promise<DecisionsFile> => {
  const content = await readPrivateJsonOptional(path);
  if (content === undefined) return {};
  try {
    return parseDecisionsFile(content);
  } catch {
    throw new CommandError("invalid-decisions-file");
  }
};

// Appends owner decisions to the private decisions log. Every append goes
// through one in-process queue and a file lock and re-reads the file inside
// them, so overlapping requests (in this process or another review process on
// the same log) can never overwrite each other's event, and a failed request
// does not block the ones after it. The rule version comes from the
// discovery data the owner was looking at and the time from the server clock,
// never from the caller.
export const createDecisionStore = ({
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

  const apply = async (request: DecisionRequest): Promise<DecisionEvent> => {
    const instant = now();
    // Decisions about stale API data are refused: refresh through `discover`.
    const stale = discovery.creators.flatMap((creator) => getStaleVideoIds(creator.videos, instant));
    if (stale.length > 0) throw new CommandError("stale-discovery-data");

    const creator = discovery.creators.find((entry) => entry.key === request.creatorKey);
    if (!creator) throw new CommandError("unknown-creator-key");
    const video = creator.manifest.videos.find((entry) => entry.videoId === request.videoId);
    if (!video) throw new CommandError("unknown-video");
    if (video.season === null || video.classification.reasons.includes("after-registered-end-week")) {
      throw new CommandError("video-outside-window");
    }

    const event: DecisionEvent = {
      videoId: request.videoId,
      decision: request.decision,
      reason: typeof request.reason === "string" ? request.reason.trim() : request.reason,
      ruleVersion: creator.manifest.ruleVersion,
      decidedAt: instant.toISOString(),
    };
    const problem = checkDecisionEvent(event);
    if (problem) throw new CommandError(problem);

    // The queue orders requests within this process; the file lock orders them
    // against another review process using the same log, so the read, the
    // checks and the replace happen as one step and no event is lost.
    return withPrivateFileLock(
      path,
      async () => {
        const file = await readDecisionsFile(path);
        const events = eventsFor(file, request.creatorKey);
        if (event.decision === "clear" && !hasActiveDecision(events, event.videoId)) {
          throw new CommandError("nothing-to-clear");
        }
        await replacePrivateJson(path, { ...file, [request.creatorKey]: [...events, event] });
        return event;
      },
      lock
    );
  };

  return {
    append: (request: DecisionRequest): Promise<DecisionEvent> => {
      const run = queue.then(() => apply(request));
      queue = run.catch(() => undefined);
      return run;
    },
    read: (): Promise<DecisionsFile> => {
      const run = queue.then(() => readDecisionsFile(path));
      queue = run.catch(() => undefined);
      return run;
    },
  };
};
