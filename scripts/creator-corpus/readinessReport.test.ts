// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CorpusApiVideoProjection, CorpusGateProjection } from "./importPlanner.ts";
import {
  GATE_SCOPE_NOTICE,
  PICK_METRICS_PENDING,
  buildCorpusReadinessReport,
  type CorpusReadinessSource,
} from "./readinessReport.ts";
import { NOW, vid } from "./testSupport.ts";

const gate: CorpusGateProjection = {
  commitmentDigest: "a".repeat(64),
  commitmentAlgorithm: "sha256",
  commitmentVersion: 1,
  eligibleCreatorCount: 2,
  minimumReviewedGradablePicksOverall: 500,
  minimumReviewedGradablePicksPerCreator: 100,
  maximumFeatureCount: 10,
  startSeason: 2024,
  startWeek: 1,
  endSeason: 2026,
  endWeek: 4,
  collectionSeasonType: "regular",
  ruleVersion: "v1",
  registeredAt: "2026-10-06T01:00:00.000Z",
};

const video = (
  creatorKey: string,
  number: number,
  overrides: Partial<CorpusApiVideoProjection> = {}
): CorpusApiVideoProjection => ({
  creatorKey,
  videoId: vid(number),
  publishedAt: "2025-10-09T15:00:00.000Z",
  durationSeconds: 1800,
  liveBroadcastContent: "none",
  apiFetchedAt: "2026-10-07T12:00:00.000Z",
  season: 2025,
  week: 6,
  seasonWeekProvenance: "youtube-api-published-at.nfl-calendar-v1",
  classificationStatus: "candidate",
  classificationReasons: ["prop-and-nfl-signal-in-title"],
  classificationRuleVersion: "v1",
  reviewStatus: "present",
  ...overrides,
});

const source = (overrides: Partial<CorpusReadinessSource> = {}): CorpusReadinessSource => ({
  gate,
  apiVideos: [],
  captureEvents: [],
  decisionEvents: [],
  latestImport: { importId: "7", importedAt: "2026-10-07T12:00:00.000Z", apiVideoCount: 0 },
  eligibleCreatorKeys: ["creator-a", "creator-b"],
  now: NOW,
  ...overrides,
});

describe("buildCorpusReadinessReport", () => {
  it("keeps inclusion, active capture state, API freshness and public clearance separate for every video and slot", () => {
    const report = buildCorpusReadinessReport(source({
      apiVideos: [
        video("creator-a", 1),
        video("creator-a", 2, { reviewStatus: "needs-review", classificationStatus: "needs-review",
          classificationReasons: ["duration-unknown"], apiFetchedAt: "2026-08-01T00:00:00.000Z" }),
        video("creator-a", 3, { reviewStatus: "excluded", classificationStatus: "excluded",
          classificationReasons: ["short-form"] }),
        video("creator-a", 4, { season: null, week: null, reviewStatus: "excluded", classificationStatus: "excluded",
          classificationReasons: ["outside-registered-regular-season"] }),
        video("creator-b", 5),
      ],
      captureEvents: [
        { creatorKey: "creator-a", logPosition: 1, videoId: vid(1), eventKind: "captured",
          usageStatus: "internal-research-only" },
        { creatorKey: "creator-a", logPosition: 2, videoId: vid(1), eventKind: "replaced",
          usageStatus: "internal-research-only" },
        { creatorKey: "creator-a", logPosition: 3, videoId: vid(2), eventKind: "unavailable",
          usageStatus: "internal-research-only" },
      ],
      decisionEvents: [
        { creatorKey: "creator-a", filePosition: 1, videoId: vid(4), decisionKind: "include",
          decidedAt: "2026-10-07T10:00:00.000Z" },
        { creatorKey: "creator-a", filePosition: 2, videoId: vid(99), decisionKind: "include",
          decidedAt: "2026-10-07T10:00:00.000Z" },
        { creatorKey: "creator-a", filePosition: 3, videoId: vid(98), decisionKind: "include",
          decidedAt: "2026-10-07T11:00:00.000Z" },
        { creatorKey: "creator-a", filePosition: 4, videoId: vid(98), decisionKind: "clear",
          decidedAt: "2026-10-07T11:00:00.000Z" },
      ],
      latestImport: { importId: "7", importedAt: "2026-10-07T12:00:00.000Z", apiVideoCount: 5 },
    }));

    expect(report.corpus).toMatchObject({
      registeredCreatorCount: 2,
      identifiedCreatorCount: 2,
      creatorCoverage: "complete",
      videos: { total: 6, included: 2, needsReview: 1, excluded: 2, unknown: 1 },
      slots: { total: 80, present: 2, needsReview: 0, missing: 78 },
      captureRate: { capturedIncludedVideos: 1, includedVideos: 2, percentage: 50 },
      publicUseClearance: { status: "not-cleared", clearedVideos: 0, corpusVideos: 6, percentage: 0 },
    });
    expect(report.creators[0].videos).toEqual(expect.arrayContaining([
      expect.objectContaining({ videoId: vid(1), inclusion: "present", captureAvailability: "replaced",
        apiFreshness: "fresh", publicUseClearance: "not-cleared" }),
      expect.objectContaining({ videoId: vid(2), inclusion: "needs-review", captureAvailability: "unavailable",
        apiFreshness: "stale", publicUseClearance: "not-cleared" }),
      expect.objectContaining({ videoId: vid(3), inclusion: "excluded", captureAvailability: "missing" }),
      expect.objectContaining({ videoId: vid(99), inclusion: "unknown", captureAvailability: "missing",
        apiFreshness: "unknown" }),
    ]));
    expect(report.creators[0].slots.find((slot) => slot.season === 2025 && slot.week === 6)).toMatchObject({
      status: "present", apiFreshness: "mixed", videoIds: [vid(1)], reviewVideoIds: [vid(2)],
    });
    expect(report.unappliedDecisions).toEqual([
      { creatorKey: "creator-a", videoId: vid(4), why: "video-outside-registered-window" },
      { creatorKey: "creator-a", videoId: vid(99), why: "video-not-in-current-api-evidence" },
    ]);
  });

  it("uses the private registered creator set to show every empty slot and keeps pick metrics unavailable rather than zero", () => {
    const report = buildCorpusReadinessReport(source());
    expect(report.corpus).toMatchObject({
      registeredCreatorCount: 2,
      identifiedCreatorCount: 2,
      unidentifiedCreatorCount: 0,
      creatorCoverage: "complete",
      videos: { total: 0 },
      slots: { total: 80, present: 0, needsReview: 0, missing: 80 },
      captureRate: { capturedIncludedVideos: 0, includedVideos: 0, percentage: null },
      publicUseClearance: { status: "unavailable", percentage: null },
    });
    expect(Object.values(report.pickLevelMetrics)).toEqual(Array(4).fill(PICK_METRICS_PENDING));
    expect(report.gate).toMatchObject({
      reviewedGradablePicksOverall: { required: 500, observed: null, status: "not-available" },
      reviewedGradablePicksPerCreator: { required: 100, observed: null, status: "not-available" },
      nextEvaluationPermitted: false,
      status: "blocked",
      notice: GATE_SCOPE_NOTICE,
    });
    expect(report.downstream).toEqual({ extraction: "blocked", grading: "blocked", modelReadiness: "blocked" });
  });

  it("refuses an invalid report time", () => {
    expect(() => buildCorpusReadinessReport(source({ now: new Date("invalid") })))
      .toThrow(expect.objectContaining({ code: "invalid-readiness-time" }));
  });
});
