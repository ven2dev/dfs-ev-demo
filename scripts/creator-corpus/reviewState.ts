import {
  API_DATA_MAX_AGE_DAYS,
  buildCreatorManifest,
  getStaleVideoIds,
  type ManifestSlot,
  type CreatorManifest,
} from "../../src/lib/creatorCorpusManifest.ts";
import { effectiveDecisions, eventsFor, type DecisionEvent, type DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import type { ReasonCode, RegisteredWindow } from "../../src/lib/creatorVideoRule.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";

// Plain-language explanation of every reason the rule can give. Typed as a
// full record so adding a reason code without a label fails the type check.
export const REASON_LABELS: Record<ReasonCode, string> = {
  "prop-and-nfl-signal-in-title": "Title mentions props (or DFS) and football.",
  "invalid-published-at": "The published date could not be read.",
  "outside-registered-regular-season": "Published outside the registered NFL regular-season weeks.",
  "after-registered-end-week": "Published after the registered end week.",
  "not-yet-vod": "Live or upcoming broadcast, not a finished video yet.",
  "short-form": "Under two minutes, treated as short-form.",
  "other-league-in-title": "Title names another league and not the NFL.",
  "fantasy-in-title": "Title says fantasy without props, so it is fantasy-football content.",
  "no-prop-signal": "Title has no props or DFS wording.",
  "no-nfl-signal": "Title has props wording but nothing marking it as football.",
  "duration-unknown": "The video length is unknown.",
  "mixed-league-title": "Title names the NFL and another league.",
  "title-week-mismatch": "Title names a different week than the publish date falls in.",
  "multiple-week-references": "Title names more than one week.",
  "nfl-signal-team-name-only": "Only a team name suggests football, which can be another league.",
  "nfl-signal-description-only": "Football is mentioned only in the description.",
  "picks-without-prop-signal": "Title says picks or best bets but never props.",
  "prop-signal-description-only": "Props are mentioned only in the description.",
};

export const DESCRIPTION_SNIPPET_LENGTH = 500;

export type ReviewVideo = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number | null;
  season: number | null;
  week: number | null;
  classification: "candidate" | "needs-review" | "excluded";
  reasons: { code: ReasonCode; label: string }[];
  status: "present" | "needs-review" | "excluded";
  decision: { decision: "include" | "exclude"; reason: string; decidedAt: string; ruleVersion: string } | null;
  events: DecisionEvent[];
};

export type ReviewCreator = {
  key: string;
  summary: CreatorManifest["summary"];
  slots: ManifestSlot[];
  videos: ReviewVideo[];
  unavailableVideoIds: string[];
};

export type ReviewState = {
  generatedAt: string;
  ruleVersion: string;
  window: RegisteredWindow;
  stale: { blocked: boolean; staleVideos: number; maxAgeDays: number; oldestFetchedAt: string | null };
  creators: ReviewCreator[];
};

const snippet = (description: string): string => {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_SNIPPET_LENGTH ? flat.slice(0, DESCRIPTION_SNIPPET_LENGTH) + "…" : flat;
};

// Everything the review page shows, recomputed from the saved videos and the
// current decision log with the same manifest code the command line uses.
export const buildReviewState = ({
  discovery,
  decisions,
  now,
}: {
  discovery: DiscoveryFile;
  decisions: DecisionsFile;
  now: Date;
}): ReviewState => {
  const staleVideos = discovery.creators.reduce((total, creator) => total + getStaleVideoIds(creator.videos, now).length, 0);
  const fetchTimes = discovery.creators.flatMap((creator) => creator.videos.map((video) => Date.parse(video.apiFetchedAt)));
  const oldest = fetchTimes.filter((time) => !Number.isNaN(time));
  const oldestFetchedAt = oldest.length ? new Date(Math.min(...oldest)).toISOString() : null;
  const creators = discovery.creators.map((creator): ReviewCreator => {
    const events = eventsFor(decisions, creator.key);
    const manifest = buildCreatorManifest({
      creatorKey: creator.key,
      videos: creator.videos,
      decisions: effectiveDecisions(events),
      window: discovery.registration.window,
    });
    const byId = new Map(creator.videos.map((video) => [video.videoId, video]));
    const videos = manifest.videos.map((entry): ReviewVideo => {
      const source = byId.get(entry.videoId);
      return {
        videoId: entry.videoId,
        title: source?.title ?? "",
        description: snippet(source?.description ?? ""),
        publishedAt: entry.publishedAt,
        durationSeconds: source?.durationSeconds ?? null,
        season: entry.season,
        week: entry.week,
        classification: entry.classification.status,
        reasons: entry.classification.reasons.map((code) => ({ code, label: REASON_LABELS[code] })),
        status: entry.status,
        decision: entry.decision
          ? {
              decision: entry.decision.decision,
              reason: entry.decision.reason,
              decidedAt: entry.decision.decidedAt ?? "",
              ruleVersion: entry.decision.ruleVersion ?? "",
            }
          : null,
        events: events.filter((event) => event.videoId === entry.videoId),
      };
    });
    return {
      key: creator.key,
      summary: manifest.summary,
      slots: manifest.slots,
      videos,
      unavailableVideoIds: creator.unavailableVideoIds,
    };
  });
  return {
    generatedAt: now.toISOString(),
    ruleVersion: discovery.registration.ruleVersion,
    window: discovery.registration.window,
    stale: { blocked: staleVideos > 0, staleVideos, maxAgeDays: API_DATA_MAX_AGE_DAYS, oldestFetchedAt },
    creators,
  };
};
