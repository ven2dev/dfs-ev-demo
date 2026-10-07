import type { CreatorManifest } from "../../src/lib/creatorCorpusManifest.ts";
import type { VideoRecord } from "../../src/lib/creatorVideoRule.ts";
import { isCreatorKey } from "../../src/lib/creatorDecisions.ts";
import type { CreatorDiscovery } from "./commands.ts";
import { InputError, parseRegistration, type Registration } from "./creatorInputs.ts";
import { isVideoId } from "./youtubeApi.ts";

// The discovery output of `creators discover` (and of `rebuild`). Later tools
// read it back, so it is validated rather than trusted.
export type DiscoveryFile = {
  formatVersion: 1;
  discoveredAt: string;
  rebuiltAt?: string;
  registration: Registration;
  quota: unknown;
  creators: CreatorDiscovery[];
};

const fail = (): never => {
  throw new InputError("invalid-discovery-file");
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value));

const checkVideo = (value: unknown): VideoRecord => {
  if (!isRecord(value)) return fail();
  const { videoId, title, description, publishedAt, durationSeconds, liveBroadcastContent, apiFetchedAt } = value;
  if (
    typeof videoId !== "string" ||
    !isVideoId(videoId) ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    typeof publishedAt !== "string" ||
    !(durationSeconds === null || typeof durationSeconds === "number") ||
    !(liveBroadcastContent === "none" || liveBroadcastContent === "upcoming" || liveBroadcastContent === "live") ||
    typeof apiFetchedAt !== "string"
  ) {
    return fail();
  }
  return { videoId, title, description, publishedAt, durationSeconds, liveBroadcastContent, apiFetchedAt };
};

export const parseDiscoveryFile = (input: unknown): DiscoveryFile => {
  if (!isRecord(input) || input.formatVersion !== 1 || !isInstant(input.discoveredAt) || !Array.isArray(input.creators)) {
    return fail();
  }
  if (input.rebuiltAt !== undefined && !isInstant(input.rebuiltAt)) return fail();
  const registration = parseRegistration(input.registration);
  const keys = new Set<string>();
  const creators = input.creators.map((entry: unknown): CreatorDiscovery => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isCreatorKey(entry.key) || keys.has(entry.key)) {
      return fail();
    }
    keys.add(entry.key);
    const manifest = entry.manifest as CreatorManifest | undefined;
    if (
      !isRecord(manifest) ||
      manifest.creatorKey !== entry.key ||
      !Array.isArray(manifest.videos) ||
      !Array.isArray(manifest.slots) ||
      !Array.isArray(entry.videos) ||
      !Array.isArray(entry.unavailableVideoIds)
    ) {
      return fail();
    }
    return { ...(entry as unknown as CreatorDiscovery), videos: entry.videos.map(checkVideo) };
  });
  return { ...(input as unknown as DiscoveryFile), registration, creators };
};
