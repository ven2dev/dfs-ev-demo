import {
  INCLUSION_RULE_VERSION,
  classifyVideo,
  listWindowWeeks,
  type RegisteredWindow,
  type VideoClassification,
  type VideoRecord,
} from "./creatorVideoRule.ts";

// YouTube API data is refreshed rather than kept indefinitely. This is a
// conservative stand-in until the retention rule is confirmed from the
// current API policy text (#88); a longer value needs that confirmation.
export const API_DATA_MAX_AGE_DAYS = 30;

export type ReviewDecision = {
  videoId: string;
  decision: "include" | "exclude";
  reason: string;
  // Provenance carried from the owner's decision event (see creatorDecisions.ts).
  ruleVersion?: string;
  decidedAt?: string;
};

export type ManifestVideoStatus = "present" | "needs-review" | "excluded";
export type ManifestSlotStatus = "present" | "needs-review" | "missing";

export type ManifestVideo = {
  videoId: string;
  publishedAt: string;
  apiFetchedAt: string;
  season: number | null;
  week: number | null;
  classification: VideoClassification;
  decision: ReviewDecision | null;
  status: ManifestVideoStatus;
};

// One expected week for one creator. `present` means at least one included
// video; reviewVideoIds lists videos still awaiting the owner's decision.
export type ManifestSlot = {
  season: number;
  week: number;
  status: ManifestSlotStatus;
  videoIds: string[];
  reviewVideoIds: string[];
};

export type InvalidDecisionReason =
  | "unknown-video"
  | "outside-window"
  | "duplicate-decision"
  | "missing-reason";

export type CreatorManifest = {
  creatorKey: string;
  ruleVersion: typeof INCLUSION_RULE_VERSION;
  window: RegisteredWindow;
  videos: ManifestVideo[];
  slots: ManifestSlot[];
  duplicateVideoIds: string[];
  invalidDecisions: { videoId: string; reason: InvalidDecisionReason }[];
  summary: {
    videos: Record<ManifestVideoStatus, number>;
    slots: Record<ManifestSlotStatus, number>;
  };
};

export const isApiDataStale = (
  apiFetchedAt: string,
  now: Date,
  maxAgeDays: number = API_DATA_MAX_AGE_DAYS
): boolean => {
  const fetched = Date.parse(apiFetchedAt);
  // An unparseable or future timestamp cannot be trusted as fresh.
  if (Number.isNaN(fetched) || fetched > now.getTime()) return true;
  return now.getTime() - fetched > maxAgeDays * 24 * 60 * 60 * 1000;
};

export const getStaleVideoIds = (
  videos: readonly Pick<VideoRecord, "videoId" | "apiFetchedAt">[],
  now: Date,
  maxAgeDays?: number
): string[] =>
  videos
    .filter((video) => isApiDataStale(video.apiFetchedAt, now, maxAgeDays))
    .map((video) => video.videoId);

// Owner decisions are explicit and auditable. A decision can include a video
// the rule excluded or exclude one it accepted, but only for a video that
// exists and falls inside the registered window.
const resolveDecisions = (
  videos: readonly { videoId: string; week: number | null; inWindow: boolean }[],
  decisions: readonly ReviewDecision[]
) => {
  const byVideo = new Map(videos.map((video) => [video.videoId, video]));
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    counts.set(decision.videoId, (counts.get(decision.videoId) ?? 0) + 1);
  }
  const valid = new Map<string, ReviewDecision>();
  const invalid: CreatorManifest["invalidDecisions"] = [];
  const reported = new Set<string>();
  for (const decision of decisions) {
    const video = byVideo.get(decision.videoId);
    let reason: InvalidDecisionReason | null = null;
    if (!video) reason = "unknown-video";
    else if ((counts.get(decision.videoId) ?? 0) > 1) reason = "duplicate-decision";
    else if (!video.inWindow || video.week === null) reason = "outside-window";
    else if (!decision.reason.trim()) reason = "missing-reason";
    if (reason) {
      // Report a duplicated id once; ignore every copy of it.
      if (!reported.has(`${decision.videoId}:${reason}`)) {
        reported.add(`${decision.videoId}:${reason}`);
        invalid.push({ videoId: decision.videoId, reason });
      }
    } else {
      valid.set(decision.videoId, decision);
    }
  }
  return { valid, invalid };
};

const statusFor = (
  classification: VideoClassification,
  decision: ReviewDecision | null
): ManifestVideoStatus => {
  if (decision) return decision.decision === "include" ? "present" : "excluded";
  if (classification.status === "candidate") return "present";
  return classification.status;
};

export const buildCreatorManifest = ({
  creatorKey,
  videos,
  decisions = [],
  window,
}: {
  creatorKey: string;
  videos: readonly VideoRecord[];
  decisions?: readonly ReviewDecision[];
  window: RegisteredWindow;
}): CreatorManifest => {
  const seen = new Set<string>();
  const duplicateVideoIds: string[] = [];
  const unique: VideoRecord[] = [];
  for (const video of videos) {
    if (seen.has(video.videoId)) {
      if (!duplicateVideoIds.includes(video.videoId)) duplicateVideoIds.push(video.videoId);
      continue;
    }
    seen.add(video.videoId);
    unique.push(video);
  }

  const classified = unique
    .map((video) => ({ video, classification: classifyVideo(video, window) }))
    .sort(
      (a, b) =>
        a.video.publishedAt.localeCompare(b.video.publishedAt) ||
        a.video.videoId.localeCompare(b.video.videoId)
    );

  const { valid, invalid } = resolveDecisions(
    classified.map(({ video, classification }) => ({
      videoId: video.videoId,
      week: classification.week,
      // A video classified outside the window carries no usable week to override.
      inWindow:
        classification.season !== null &&
        !classification.reasons.includes("after-registered-end-week"),
    })),
    decisions
  );

  const manifestVideos: ManifestVideo[] = classified.map(({ video, classification }) => {
    const decision = valid.get(video.videoId) ?? null;
    return {
      videoId: video.videoId,
      publishedAt: video.publishedAt,
      apiFetchedAt: video.apiFetchedAt,
      season: classification.season,
      week: classification.week,
      classification,
      decision,
      status: statusFor(classification, decision),
    };
  });

  const slots: ManifestSlot[] = listWindowWeeks(window).map(({ season, week }) => {
    const inWeek = manifestVideos.filter(
      (video) => video.season === season && video.week === week
    );
    const videoIds = inWeek.filter((video) => video.status === "present").map((v) => v.videoId);
    const reviewVideoIds = inWeek
      .filter((video) => video.status === "needs-review")
      .map((v) => v.videoId);
    return {
      season,
      week,
      videoIds,
      reviewVideoIds,
      status: videoIds.length ? "present" : reviewVideoIds.length ? "needs-review" : "missing",
    };
  });

  const count = <T extends string>(values: T[], keys: readonly T[]) =>
    Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length])) as Record<
      T,
      number
    >;

  return {
    creatorKey,
    ruleVersion: INCLUSION_RULE_VERSION,
    window,
    videos: manifestVideos,
    slots,
    duplicateVideoIds,
    invalidDecisions: invalid,
    summary: {
      videos: count(manifestVideos.map((video) => video.status), [
        "present",
        "needs-review",
        "excluded",
      ] as const),
      slots: count(slots.map((slot) => slot.status), ["present", "needs-review", "missing"] as const),
    },
  };
};
