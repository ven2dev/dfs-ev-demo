import { describe, expect, it } from "vitest";
import {
  API_DATA_MAX_AGE_DAYS,
  buildCreatorManifest,
  getStaleVideoIds,
  isApiDataStale,
  type ReviewDecision,
} from "./creatorCorpusManifest.ts";
import type { RegisteredWindow, VideoRecord } from "./creatorVideoRule.ts";

const WINDOW: RegisteredWindow = { endSeason: 2024, endWeek: 3 };
// 2024 Week 1 is Tue 2024-09-03..Mon 2024-09-09; Week 2 starts 2024-09-10; Week 3 starts 2024-09-17.
const video = (id: string, overrides: Partial<VideoRecord> = {}): VideoRecord => ({
  videoId: id,
  title: "NFL Week 1 Player Props",
  description: "",
  publishedAt: "2024-09-05T15:00:00Z",
  durationSeconds: 1800,
  liveBroadcastContent: "none",
  apiFetchedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});
const week2 = (id: string, overrides: Partial<VideoRecord> = {}) =>
  video(id, { title: "NFL Week 2 Player Props", publishedAt: "2024-09-12T15:00:00Z", ...overrides });
const build = (videos: VideoRecord[], decisions: ReviewDecision[] = []) =>
  buildCreatorManifest({ creatorKey: "creator-a", videos, decisions, window: WINDOW });

describe("buildCreatorManifest slots", () => {
  it("expects one slot per window week and marks weeks with no qualifying video missing", () => {
    const manifest = build([video("a1")]);
    expect(manifest.slots.map(({ season, week, status }) => `${season}-${week}:${status}`)).toEqual([
      "2024-1:present",
      "2024-2:missing",
      "2024-3:missing",
    ]);
    expect(manifest.summary.slots).toEqual({ present: 1, "needs-review": 0, missing: 2 });
  });

  it("keeps several qualifying videos in one week and records review-pending ones separately", () => {
    const manifest = build([
      video("a1"),
      video("a2", { publishedAt: "2024-09-07T15:00:00Z" }),
      video("a3", { title: "NFL Week 1 best bets" }),
    ]);
    expect(manifest.slots[0]).toMatchObject({
      status: "present",
      videoIds: ["a1", "a2"],
      reviewVideoIds: ["a3"],
    });
  });

  it("marks a week needs-review when only flagged videos exist for it", () => {
    const manifest = build([week2("b1", { title: "NFL Week 3 Player Props" })]);
    expect(manifest.slots[1]).toMatchObject({ status: "needs-review", videoIds: [], reviewVideoIds: ["b1"] });
  });

  it("never fills a missing week from another week's video or from excluded videos", () => {
    const manifest = build([
      video("a1"),
      week2("b1", { title: "NFL Week 2 recap" }),
      video("late", { publishedAt: "2024-10-01T15:00:00Z" }),
    ]);
    expect(manifest.slots[1]).toMatchObject({ status: "missing", videoIds: [], reviewVideoIds: [] });
    expect(manifest.videos.find((entry) => entry.videoId === "late")?.status).toBe("excluded");
  });
});

describe("buildCreatorManifest videos", () => {
  it("records the rule version, placement, classification and API fetch time for every video", () => {
    const [entry] = build([video("a1")]).videos;
    expect(entry).toMatchObject({
      videoId: "a1",
      season: 2024,
      week: 1,
      apiFetchedAt: "2026-10-01T00:00:00Z",
      status: "present",
      decision: null,
      classification: { status: "candidate", ruleVersion: "v1" },
    });
  });

  it("orders output deterministically and drops repeated video IDs while reporting them", () => {
    const first = build([week2("b1"), video("a1"), video("a1", { title: "different copy" })]);
    const second = build([video("a1"), week2("b1")]);
    expect(first.videos.map((entry) => entry.videoId)).toEqual(["a1", "b1"]);
    expect(first.duplicateVideoIds).toEqual(["a1"]);
    expect(first.videos[0].classification).toEqual(second.videos[0].classification);
    expect(second.duplicateVideoIds).toEqual([]);
  });

  it("counts videos by final status", () => {
    const manifest = build([video("a1"), video("a2", { title: "NFL Week 1 best bets" }), video("a3", { title: "NBA props" })]);
    expect(manifest.summary.videos).toEqual({ present: 1, "needs-review": 1, excluded: 1 });
  });
});

describe("owner review decisions", () => {
  const reviewed = [video("a1"), video("a2", { title: "NFL Week 1 best bets" }), video("a3", { title: "Week 1 recap" })];

  it("lets the owner include a flagged video or one the rule excluded", () => {
    const manifest = build(reviewed, [
      { videoId: "a2", decision: "include", reason: "discusses props throughout" },
      { videoId: "a3", decision: "include", reason: "title is misleading" },
    ]);
    expect(manifest.videos.map((entry) => entry.status)).toEqual(["present", "present", "present"]);
    expect(manifest.videos[1].decision).toEqual({
      videoId: "a2",
      decision: "include",
      reason: "discusses props throughout",
    });
    // The original classification stays on record next to the decision.
    expect(manifest.videos[1].classification.status).toBe("needs-review");
    expect(manifest.slots[0].reviewVideoIds).toEqual([]);
  });

  it("lets the owner exclude an accepted video, which can leave the week missing", () => {
    const manifest = build([video("a1")], [{ videoId: "a1", decision: "exclude", reason: "recap only" }]);
    expect(manifest.videos[0].status).toBe("excluded");
    expect(manifest.slots[0].status).toBe("missing");
  });

  it("reports and ignores decisions that name an unknown video or an outside-window video", () => {
    const manifest = build(
      [video("a1"), video("late", { publishedAt: "2024-10-01T15:00:00Z" }), video("old", { publishedAt: "2024-02-01T15:00:00Z" })],
      [
        { videoId: "ghost", decision: "include", reason: "n/a" },
        { videoId: "late", decision: "include", reason: "wanted" },
        { videoId: "old", decision: "include", reason: "wanted" },
      ]
    );
    expect(manifest.invalidDecisions).toEqual([
      { videoId: "ghost", reason: "unknown-video" },
      { videoId: "late", reason: "outside-window" },
      { videoId: "old", reason: "outside-window" },
    ]);
    expect(manifest.videos.every((entry) => entry.decision === null)).toBe(true);
  });

  it("ignores every copy of a duplicated decision and requires a stated reason", () => {
    const manifest = build(reviewed, [
      { videoId: "a2", decision: "include", reason: "yes" },
      { videoId: "a2", decision: "exclude", reason: "no" },
      { videoId: "a3", decision: "include", reason: "   " },
    ]);
    expect(manifest.invalidDecisions).toEqual([
      { videoId: "a2", reason: "duplicate-decision" },
      { videoId: "a3", reason: "missing-reason" },
    ]);
    expect(manifest.videos.map((entry) => entry.status)).toEqual(["present", "needs-review", "excluded"]);
  });
});

describe("API data staleness", () => {
  const now = new Date("2026-10-31T00:00:00Z");

  it("treats data older than the retention limit, unparseable or future timestamps as stale", () => {
    expect(API_DATA_MAX_AGE_DAYS).toBe(30);
    expect(isApiDataStale("2026-10-01T00:00:00Z", now)).toBe(false);
    expect(isApiDataStale("2026-09-30T23:59:59Z", now)).toBe(true);
    expect(isApiDataStale("not a date", now)).toBe(true);
    expect(isApiDataStale("2026-11-01T00:00:00Z", now)).toBe(true);
  });

  it("lists the stale video IDs so the tool can refuse to use them", () => {
    expect(
      getStaleVideoIds(
        [
          { videoId: "fresh", apiFetchedAt: "2026-10-20T00:00:00Z" },
          { videoId: "old", apiFetchedAt: "2026-08-01T00:00:00Z" },
        ],
        now
      )
    ).toEqual(["old"]);
  });
});
