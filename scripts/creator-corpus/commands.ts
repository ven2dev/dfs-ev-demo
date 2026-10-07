import {
  buildCreatorManifest,
  getStaleVideoIds,
  type CreatorManifest,
  type ReviewDecision,
} from "../../src/lib/creatorCorpusManifest.ts";
import { effectiveDecisions, eventsFor, type DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import type { RegisteredWindow, VideoRecord } from "../../src/lib/creatorVideoRule.ts";
import { windowEnd, windowStart, type CreatorInput } from "./creatorInputs.ts";
import type { DecisionNotApplied, DiscoveryFile } from "./discoveryFile.ts";
import {
  MAX_VIDEOS_PER_REQUEST,
  YoutubeApiError,
  listUploads,
  type ApiErrorCode,
  type ApiVideo,
  type YoutubeClient,
} from "./youtubeApi.ts";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export type TitleMatch = "exact" | "normalized" | "partial" | "mismatch";

export type RegistryEntry = CreatorInput & {
  channelId: string;
  channelTitle: string;
  uploadsPlaylistId: string;
  titleMatch: TitleMatch;
  confirmed: boolean;
  apiFetchedAt: string;
};

export type ResolveFailureCode = ApiErrorCode | "seed-video-not-found" | "duplicate-channel";

export type CreatorRegistry = {
  formatVersion: 1;
  resolvedAt: string;
  creators: RegistryEntry[];
  failures: { key: string; code: ResolveFailureCode }[];
};

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const compareChannelTitle = (storedName: string, channelTitle: string): TitleMatch => {
  if (storedName.trim().toLowerCase() === channelTitle.trim().toLowerCase()) return "exact";
  const stored = squash(storedName);
  const resolved = squash(channelTitle);
  if (!stored || !resolved) return "mismatch";
  if (stored === resolved) return "normalized";
  return stored.includes(resolved) || resolved.includes(stored) ? "partial" : "mismatch";
};

// One videos.list call per creator turns the owner's seed video into a channel
// identity. Every entry starts unconfirmed: the owner compares the stored name
// with the resolved channel title before any discovery runs against it.
export const resolveCreators = async (
  client: YoutubeClient,
  creators: readonly CreatorInput[],
  now: Date
): Promise<CreatorRegistry> => {
  const entries: RegistryEntry[] = [];
  const failures: CreatorRegistry["failures"] = [];
  for (const creator of creators) {
    let videos: ApiVideo[];
    try {
      videos = await client.getVideos([creator.seedVideoId]);
    } catch (error) {
      if (error instanceof YoutubeApiError) {
        // A spent quota or a refused key stops the whole run, not one creator.
        if (["quota-limit-reached", "quota-exceeded", "forbidden", "api-key-missing"].includes(error.code)) {
          throw error;
        }
        failures.push({ key: creator.key, code: error.code });
        continue;
      }
      throw error;
    }
    const seed = videos.find((video) => video.videoId === creator.seedVideoId);
    if (!seed) {
      failures.push({ key: creator.key, code: "seed-video-not-found" });
      continue;
    }
    if (!CHANNEL_ID.test(seed.channelId)) {
      failures.push({ key: creator.key, code: "invalid-response" });
      continue;
    }
    if (entries.some((entry) => entry.channelId === seed.channelId)) {
      failures.push({ key: creator.key, code: "duplicate-channel" });
      continue;
    }
    entries.push({
      ...creator,
      channelId: seed.channelId,
      channelTitle: seed.channelTitle,
      // The uploads playlist ID is the channel ID with its UC prefix swapped for UU.
      uploadsPlaylistId: "UU" + seed.channelId.slice(2),
      titleMatch: compareChannelTitle(creator.name, seed.channelTitle),
      confirmed: false,
      apiFetchedAt: now.toISOString(),
    });
  }
  return { formatVersion: 1, resolvedAt: now.toISOString(), creators: entries, failures };
};

export class CommandError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// Confirmation is explicit and per creator. A creator whose stored name does
// not even partially match the resolved channel cannot be confirmed: fix the
// creators file and resolve again instead of overriding the comparison.
export const confirmCreators = (registry: CreatorRegistry, keys: readonly string[]): CreatorRegistry => {
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new CommandError("invalid-confirm-keys");
  const byKey = new Map(registry.creators.map((entry) => [entry.key, entry]));
  for (const key of keys) {
    const entry = byKey.get(key);
    if (!entry) throw new CommandError("unknown-creator-key");
    if (entry.titleMatch === "mismatch") throw new CommandError("title-mismatch-cannot-confirm");
  }
  return {
    ...registry,
    creators: registry.creators.map((entry) => (keys.includes(entry.key) ? { ...entry, confirmed: true } : entry)),
  };
};

export const parseRegistry = (input: unknown): CreatorRegistry => {
  const value = input as Partial<CreatorRegistry> | null;
  if (
    !value ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.creators) ||
    !Array.isArray(value.failures) ||
    typeof value.resolvedAt !== "string" ||
    !value.creators.every(
      (entry) =>
        entry &&
        typeof entry.key === "string" &&
        typeof entry.confirmed === "boolean" &&
        typeof entry.channelId === "string" &&
        CHANNEL_ID.test(entry.channelId) &&
        entry.uploadsPlaylistId === "UU" + entry.channelId.slice(2)
    )
  ) {
    throw new CommandError("invalid-registry");
  }
  return value as CreatorRegistry;
};

// Builds a creator's manifest from the owner's active decisions. A decision
// that cannot be applied (the video is gone, was never listed, or is outside
// the registered window) is skipped and reported with the reason: it stays in
// the append-only log, but it never changes coverage unnoticed and never
// blocks the workflow.
export const applyDecisions = ({
  creatorKey,
  videos,
  unavailableVideoIds,
  window,
  active,
}: {
  creatorKey: string;
  videos: readonly VideoRecord[];
  unavailableVideoIds: readonly string[];
  window: RegisteredWindow;
  active: readonly ReviewDecision[];
}): { manifest: CreatorManifest; notApplied: DecisionNotApplied[] } => {
  const first = buildCreatorManifest({ creatorKey, videos, decisions: active, window });
  const unavailable = new Set(unavailableVideoIds);
  const skipped = new Map<string, DecisionNotApplied["why"]>();
  for (const invalid of first.invalidDecisions) {
    if (invalid.reason === "unknown-video") {
      skipped.set(invalid.videoId, unavailable.has(invalid.videoId) ? "video-unavailable" : "video-not-in-discovery");
    } else if (invalid.reason === "outside-window") {
      skipped.set(invalid.videoId, "video-outside-window");
    } else {
      // A duplicate or reason-less decision means the log itself is damaged.
      throw new CommandError("invalid-decisions-present");
    }
  }
  const notApplied = [...skipped].map(([videoId, why]): DecisionNotApplied => ({ creatorKey, videoId, why }));
  if (skipped.size === 0) return { manifest: first, notApplied };
  const applicable = active.filter((decision) => !skipped.has(decision.videoId));
  return { manifest: buildCreatorManifest({ creatorKey, videos, decisions: applicable, window }), notApplied };
};

export type CreatorDiscovery = {
  key: string;
  manifest: CreatorManifest;
  videos: VideoRecord[];
  unavailableVideoIds: string[];
  uploadPages: number;
  stoppedEarly: boolean;
  enrichedVideos: number;
  decisionsNotApplied: DecisionNotApplied[];
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Lists every upload, keeps only videos published inside the registered window
// (with a day of margin so a boundary video is still fetched and classified),
// enriches them in batches, and builds the creator's manifest. Videos the API
// no longer returns (removed or private) are reported, never replaced.
export const discoverCreator = async ({
  client,
  entry,
  window,
  decisions = [],
  now,
}: {
  client: YoutubeClient;
  entry: RegistryEntry;
  window: RegisteredWindow;
  decisions?: readonly ReviewDecision[];
  now: Date;
}): Promise<CreatorDiscovery> => {
  if (!entry.confirmed) throw new CommandError("creator-not-confirmed");
  const start = windowStart().getTime() - ONE_DAY_MS;
  const end = windowEnd(window).getTime() + ONE_DAY_MS;

  const listing = await listUploads(client, entry.uploadsPlaylistId, { notBefore: new Date(start) });
  const ids = [
    ...new Set(
      listing.items
        .filter((item) => {
          if (item.publishedAt === null) return true;
          const time = Date.parse(item.publishedAt);
          return Number.isNaN(time) || (time >= start && time < end);
        })
        .map((item) => item.videoId)
    ),
  ];

  const fetched: VideoRecord[] = [];
  for (let index = 0; index < ids.length; index += MAX_VIDEOS_PER_REQUEST) {
    const batch = ids.slice(index, index + MAX_VIDEOS_PER_REQUEST);
    for (const video of await client.getVideos(batch)) {
      if (video.channelId !== entry.channelId) throw new CommandError("video-from-other-channel");
      fetched.push({
        videoId: video.videoId,
        title: video.title,
        description: video.description,
        publishedAt: video.publishedAt,
        durationSeconds: video.durationSeconds,
        liveBroadcastContent: video.liveBroadcastContent,
        apiFetchedAt: now.toISOString(),
      });
    }
  }
  const returned = new Set(fetched.map((video) => video.videoId));
  const unavailableVideoIds = ids.filter((id) => !returned.has(id));
  const { manifest, notApplied } = applyDecisions({
    creatorKey: entry.key,
    videos: fetched,
    unavailableVideoIds,
    window,
    active: decisions,
  });
  return {
    key: entry.key,
    manifest,
    videos: fetched,
    unavailableVideoIds,
    uploadPages: listing.pages,
    stoppedEarly: listing.stoppedEarly,
    enrichedVideos: fetched.length,
    decisionsNotApplied: notApplied,
  };
};

export type ScreenRow = {
  key: string;
  weeks: number;
  present: number;
  needsReview: number;
  missing: number;
  presentShare: number;
  videosPresent: number;
  videosNeedingReview: number;
  videosExcluded: number;
  bySeason: { season: number; present: number; needsReview: number; missing: number }[];
};

// Weekly coverage per creator. No outcomes are involved: this is metadata
// only, so it can safely inform which creators to select before any analysis.
export const screenManifests = (manifests: readonly CreatorManifest[]): ScreenRow[] =>
  manifests.map((manifest) => {
    const seasons = [...new Set(manifest.slots.map((slot) => slot.season))];
    const count = (season: number | null, status: string) =>
      manifest.slots.filter((slot) => (season === null || slot.season === season) && slot.status === status).length;
    const weeks = manifest.slots.length;
    return {
      key: manifest.creatorKey,
      weeks,
      present: count(null, "present"),
      needsReview: count(null, "needs-review"),
      missing: count(null, "missing"),
      presentShare: weeks === 0 ? 0 : Math.round((count(null, "present") / weeks) * 1000) / 1000,
      videosPresent: manifest.summary.videos.present,
      videosNeedingReview: manifest.summary.videos["needs-review"],
      videosExcluded: manifest.summary.videos.excluded,
      bySeason: seasons.map((season) => ({
        season,
        present: count(season, "present"),
        needsReview: count(season, "needs-review"),
        missing: count(season, "missing"),
      })),
    };
  });

export const formatScreenReport = (rows: readonly ScreenRow[]): string => {
  const header = ["creator", "weeks", "present", "review", "missing", "share", "videos(p/r/x)"];
  const lines = rows.map((row) => [
    row.key,
    String(row.weeks),
    String(row.present),
    String(row.needsReview),
    String(row.missing),
    row.presentShare.toFixed(3),
    `${row.videosPresent}/${row.videosNeedingReview}/${row.videosExcluded}`,
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map((line) => line[column].length)));
  const format = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  return [format(header), ...lines.map(format)].join("\n") + "\n";
};

// Rebuilds every creator's manifest from the videos already saved in a
// discovery file plus the owner's decisions, with no API call. Stale API data
// and decisions for creators this file does not know are refused. Any decision
// that cannot be applied is skipped and reported, never dropped silently.
export const rebuildDiscovery = ({
  discovery,
  decisions,
  now,
}: {
  discovery: DiscoveryFile;
  decisions: DecisionsFile;
  now: Date;
}): DiscoveryFile => {
  if (discovery.creators.some((creator) => getStaleVideoIds(creator.videos, now).length > 0)) {
    throw new CommandError("stale-discovery-data");
  }
  const known = new Set(discovery.creators.map((creator) => creator.key));
  if (Object.keys(decisions).some((key) => !known.has(key))) throw new CommandError("unknown-creator-in-decisions");
  const decisionsNotApplied: DecisionNotApplied[] = [];
  const creators = discovery.creators.map((creator) => {
    const { manifest, notApplied } = applyDecisions({
      creatorKey: creator.key,
      videos: creator.videos,
      unavailableVideoIds: creator.unavailableVideoIds,
      window: discovery.registration.window,
      active: effectiveDecisions(eventsFor(decisions, creator.key)),
    });
    decisionsNotApplied.push(...notApplied);
    return { ...creator, manifest, decisionsNotApplied: notApplied };
  });
  return { ...discovery, rebuiltAt: now.toISOString(), creators, decisionsNotApplied };
};
