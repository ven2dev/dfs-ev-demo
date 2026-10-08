import { buildCreatorManifest } from "../../src/lib/creatorCorpusManifest.ts";
import type { VideoRecord } from "../../src/lib/creatorVideoRule.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";

// Shared synthetic data for the creator-corpus tests. Nothing here is real
// creator or API data.
export const NOW = new Date("2026-10-07T12:00:00.000Z");
export const WINDOW = { endSeason: 2026, endWeek: 4 };
export const vid = (n: number) => "vid" + String(n).padStart(8, "0");

export const record = (n: number, overrides: Partial<VideoRecord> = {}): VideoRecord => ({
  videoId: vid(n),
  title: "NFL Week 6 best bets",
  description: "",
  publishedAt: "2025-10-09T15:00:00Z",
  durationSeconds: 1800,
  liveBroadcastContent: "none",
  apiFetchedAt: NOW.toISOString(),
  ...overrides,
});

export const discoveryFor = (videos: VideoRecord[], otherVideos: VideoRecord[] = [record(900)]): DiscoveryFile => {
  const creator = (key: string, list: VideoRecord[]) => ({
    key,
    videos: list,
    manifest: buildCreatorManifest({ creatorKey: key, videos: list, window: WINDOW }),
    unavailableVideoIds: [],
    uploadPages: 1,
    stoppedEarly: false,
    enrichedVideos: list.length,
    decisionsNotApplied: [],
  });
  return {
    formatVersion: 1,
    discoveredAt: NOW.toISOString(),
    registration: { formatVersion: 1, ruleVersion: "v1", window: WINDOW, registeredAt: "2026-10-06T00:00:00Z" },
    quota: {},
    creators: [creator("creator-a", videos), creator("creator-b", otherVideos)],
  };
};
