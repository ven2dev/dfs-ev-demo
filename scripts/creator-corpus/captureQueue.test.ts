// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCaptureEvent, type CaptureEvent, type CaptureRequest } from "../../src/lib/creatorCaptures.ts";
import type { DecisionEvent } from "../../src/lib/creatorDecisions.ts";
import { PREVIEW_LENGTH, buildCaptureQueue, type QueueScope } from "./captureQueue.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

const SENTINEL = "SENTINEL-TRANSCRIPT-WORDS";
const TEXT = `0:00\n${SENTINEL} welcome to the show.\n`.repeat(20);
const captureEvent = (n: number, overrides: Partial<CaptureRequest> = {}, creatorKey = "creator-a"): CaptureEvent =>
  buildCaptureEvent(
    { creatorKey, videoId: vid(n), action: "capture", text: TEXT, publishedDate: "2025-10-09", ...overrides },
    NOW
  );
const decision = (n: number, kind: "include" | "exclude", at = "2026-10-07T13:00:00.000Z"): DecisionEvent => ({
  videoId: vid(n),
  decision: kind,
  reason: "r",
  ruleVersion: "v1",
  decidedAt: at,
});

// 1: included by rule, 2: flagged, 3: excluded by rule, 4: included, later in time.
const discovery = () =>
  discoveryFor([
    record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
    record(2, { title: "Week 6 NFL best bets and picks", publishedAt: "2025-10-08T15:00:00Z" }),
    record(3, { title: "NFL Week 6 reaction and recap", publishedAt: "2025-10-10T15:00:00Z" }),
    record(4, { title: "NFL Week 7 Player Props", publishedAt: "2025-10-16T15:00:00Z" }),
  ]);
const build = (options: { decisions?: Record<string, DecisionEvent[]>; captures?: CaptureEvent[]; scope?: QueueScope; discovery?: ReturnType<typeof discoveryFor>; hintTimeZone?: string } = {}) =>
  buildCaptureQueue({
    discovery: options.discovery ?? discovery(),
    decisions: options.decisions ?? {},
    captures: options.captures ?? [],
    scope: options.scope,
    hintTimeZone: options.hintTimeZone,
    now: NOW,
  });
const creatorA = (state: ReturnType<typeof build>) => state.creators.find((creator) => creator.key === "creator-a")!;
const ids = (state: ReturnType<typeof build>) => creatorA(state).items.map((item) => item.videoId);

describe("scope", () => {
  it("queues only videos that count as included, oldest first", () => {
    expect(ids(build())).toEqual([vid(1), vid(4)]);
  });

  it("adds flagged videos when asked, and never excluded ones", () => {
    expect(ids(build({ scope: "included-and-flagged" }))).toEqual([vid(2), vid(1), vid(4)]);
  });

  it("follows the owner's decisions in both directions", () => {
    const decisions = { "creator-a": [decision(2, "include"), decision(1, "exclude"), decision(3, "include")] };
    expect(ids(build({ decisions }))).toEqual([vid(2), vid(3), vid(4)]);
  });

  it("reports which scope it was built for", () => {
    expect(build().scope).toBe("included");
    expect(build({ scope: "included-and-flagged" }).scope).toBe("included-and-flagged");
  });
});

describe("states and progress", () => {
  it("marks every queued video as needing capture when the log is empty", () => {
    const creator = creatorA(build());
    expect(creator.items.map((item) => item.state)).toEqual(["needs-capture", "needs-capture"]);
    expect(creator.counts).toEqual({ needsCapture: 2, captured: 0, unavailable: 0, total: 2 });
    expect(creator.nextVideoId).toBe(vid(1));
    expect(creator.items[0].capture).toBeNull();
  });

  it("counts captured and unavailable videos and moves the next pointer to the oldest still needing one", () => {
    const captures = [captureEvent(1), buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(4), action: "unavailable", publishedDate: "2025-10-09", reason: "disabled" }, NOW)];
    const creator = creatorA(build({ captures }));
    expect(creator.items.map((item) => item.state)).toEqual(["captured", "unavailable"]);
    expect(creator.counts).toEqual({ needsCapture: 0, captured: 1, unavailable: 1, total: 2 });
    expect(creator.nextVideoId).toBeNull();
    const halfway = creatorA(build({ captures: [captureEvent(1)] }));
    expect(halfway.nextVideoId).toBe(vid(4));
  });

  it("counts progress per week, including weeks with no queued video", () => {
    const creator = creatorA(build({ captures: [captureEvent(1)] }));
    const week = (season: number, number: number) => creator.weeks.find((entry) => entry.season === season && entry.week === number)!;
    expect(week(2025, 6)).toEqual({ season: 2025, week: 6, needsCapture: 0, captured: 1, unavailable: 0 });
    expect(week(2025, 7)).toEqual({ season: 2025, week: 7, needsCapture: 1, captured: 0, unavailable: 0 });
    expect(week(2025, 8)).toEqual({ season: 2025, week: 8, needsCapture: 0, captured: 0, unavailable: 0 });
    expect(creator.weeks).toHaveLength(40);
  });

  it("counts an unavailable video under its own week column, not as captured", () => {
    const captures = [buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable", publishedDate: "2025-10-09" }, NOW), captureEvent(4)];
    const creator = creatorA(build({ captures }));
    const week = (number: number) => creator.weeks.find((entry) => entry.season === 2025 && entry.week === number)!;
    expect(week(6)).toMatchObject({ needsCapture: 0, captured: 0, unavailable: 1 });
    expect(week(7)).toMatchObject({ needsCapture: 0, captured: 1, unavailable: 0 });
  });

  it("matches a capture to its own creator even when two creators list the same video id", () => {
    const d = discoveryFor(
      [record(1, { title: "NFL Week 6 Player Props" })],
      [record(1, { title: "NFL Week 6 Player Props" })]
    );
    const state = build({ discovery: d, captures: [captureEvent(1)] });
    expect(creatorA(state).items[0].state).toBe("captured");
    expect(state.creators.find((creator) => creator.key === "creator-b")!.items[0].state).toBe("needs-capture");
  });

  it("treats a replaced capture as captured and counts its events", () => {
    const captures = [captureEvent(1), captureEvent(1, { action: "replace", reason: "fix", text: TEXT + "tail\n" })];
    const [first] = creatorA(build({ captures })).items;
    expect(first.state).toBe("captured");
    expect(first.capture).toMatchObject({ event: "replaced", events: 2, reason: "fix" });
  });

  it("lets a video marked unavailable be captured later", () => {
    const captures = [
      buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable", publishedDate: "2025-10-09" }, NOW),
      captureEvent(1),
    ];
    expect(creatorA(build({ captures })).items[0]).toMatchObject({ state: "captured", capture: { events: 2 } });
  });

  it("keeps each creator's captures separate", () => {
    const state = build({ captures: [captureEvent(900, {}, "creator-b")] });
    expect(creatorA(state).counts.captured).toBe(0);
    expect(state.creators.find((creator) => creator.key === "creator-b")!.counts).toMatchObject({ captured: 0, needsCapture: 0 });
    const own = build({ captures: [captureEvent(900, {}, "creator-b")], scope: "included-and-flagged" });
    expect(own.creators.find((creator) => creator.key === "creator-b")!.counts.captured).toBe(1);
  });
});

describe("what the state may contain", () => {
  it("never holds a transcript: only a length, a short hash and a brief preview", () => {
    const state = build({ captures: [captureEvent(1)] });
    expect(JSON.stringify(state)).not.toContain(TEXT);
    const { capture } = creatorA(state).items[0];
    expect(capture).toMatchObject({ characters: TEXT.length, publishedDate: "2025-10-09", captionKind: "unknown" });
    expect(capture!.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(capture!.preview).toBe((TEXT.replace(/\s+/g, " ").trim()).slice(0, PREVIEW_LENGTH) + "…");
    expect(capture!.preview!.length).toBe(PREVIEW_LENGTH + 1);
    expect(JSON.stringify(state).split(SENTINEL).length - 1).toBeLessThanOrEqual(PREVIEW_LENGTH / SENTINEL.length + 1);
  });

  it("gives an unavailable capture no text, hash or preview", () => {
    const captures = [buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable", publishedDate: "2025-10-09", note: "private video" }, NOW)];
    expect(creatorA(build({ captures })).items[0].capture).toMatchObject({
      event: "unavailable",
      characters: null,
      hash: null,
      preview: null,
      note: "private video",
    });
  });
});

describe("publish date hint", () => {
  it("is the calendar date in the owner's time zone, not in UTC", () => {
    const d = discoveryFor([record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-10T02:30:00Z" })]);
    expect(creatorA(build({ discovery: d })).items[0]).toMatchObject({ publishedAt: "2025-10-10T02:30:00Z", publishedDateHint: "2025-10-09" });
    expect(creatorA(build({ discovery: d, hintTimeZone: "UTC" })).items[0].publishedDateHint).toBe("2025-10-10");
    expect(creatorA(build({ discovery: d, hintTimeZone: "America/New_York" })).items[0].publishedDateHint).toBe("2025-10-09");
  });

  it("follows the daylight-saving change", () => {
    const d = discoveryFor([record(1, { title: "NFL Week 10 Player Props", publishedAt: "2024-11-06T07:30:00Z" })]);
    expect(creatorA(build({ discovery: d })).items[0].publishedDateHint).toBe("2024-11-05");
  });
});

describe("stale data", () => {
  const stale = () =>
    discoveryFor([record(1, { title: "NFL Week 6 Player Props", apiFetchedAt: "2026-08-01T00:00:00.000Z" }), record(2, { title: "NFL Week 6 Player Props", apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);

  it("withholds the video list but still reports what the owner's own log shows", () => {
    const state = build({ discovery: stale(), captures: [captureEvent(1)] });
    expect(state.stale).toEqual({ blocked: true, staleVideos: 2, maxAgeDays: 30, oldestFetchedAt: "2026-08-01T00:00:00.000Z" });
    const creator = creatorA(state);
    expect(creator.items).toEqual([]);
    expect(creator.weeks).toEqual([]);
    expect(creator.nextVideoId).toBeNull();
    expect(creator.counts).toEqual({ needsCapture: null, captured: 1, unavailable: 0, total: null });
    expect(JSON.stringify(state)).not.toContain("Player Props");
    expect(state.capturesNotListed).toBe(0);
  });
});

describe("creator keys that start with another creator's key", () => {
  it("do not share capture counts while the video list is withheld", () => {
    const d = discoveryFor(
      [record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })],
      [record(2, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]
    );
    d.creators[0].key = "creator";
    d.creators[0].manifest.creatorKey = "creator";
    d.creators[1].key = "creator-a";
    d.creators[1].manifest.creatorKey = "creator-a";
    const unavailable = buildCaptureEvent({ creatorKey: "creator-a", videoId: vid(5), action: "unavailable", publishedDate: "2025-10-09" }, NOW);
    const state = build({ discovery: d, captures: [captureEvent(2, {}, "creator-a"), unavailable] });
    expect(state.creators.map((creator) => [creator.key, creator.counts.captured, creator.counts.unavailable])).toEqual([
      ["creator", 0, 0],
      ["creator-a", 1, 1],
    ]);
  });
});

describe("captures that are no longer listed", () => {
  it("are counted but never shown or counted as progress", () => {
    const state = build({ captures: [captureEvent(1), captureEvent(2), captureEvent(60)] });
    expect(state.capturesNotListed).toBe(2);
    expect(creatorA(state).counts).toMatchObject({ captured: 1, total: 2 });
    expect(ids(state)).toEqual([vid(1), vid(4)]);
  });

  it("includes a video excluded after it was captured", () => {
    const state = build({ captures: [captureEvent(1)], decisions: { "creator-a": [decision(1, "exclude")] } });
    expect(state.capturesNotListed).toBe(1);
    expect(ids(state)).toEqual([vid(4)]);
  });
});

describe("edge cases", () => {
  it("handles a creator named like an Object property and a creator with no videos", () => {
    const d = discoveryFor([record(1, { title: "NFL Week 6 Player Props" })], []);
    d.creators[0].key = "constructor";
    d.creators[0].manifest.creatorKey = "constructor";
    const state = build({ discovery: d, captures: [captureEvent(1, {}, "constructor")] });
    expect(state.creators.map((creator) => creator.key)).toEqual(["constructor", "creator-b"]);
    expect(state.creators[0].counts).toMatchObject({ captured: 1, needsCapture: 0 });
    expect(state.creators[1]).toMatchObject({ counts: { needsCapture: 0, captured: 0, unavailable: 0, total: 0 }, items: [], nextVideoId: null });
  });

  it("is deterministic and does not modify its inputs", () => {
    const d = discovery();
    const captures = [captureEvent(1)];
    const before = JSON.stringify([d, captures]);
    expect(JSON.stringify(build({ discovery: d, captures }))).toBe(JSON.stringify(build({ discovery: d, captures })));
    expect(JSON.stringify([d, captures])).toBe(before);
  });

  it("orders videos with the same publish time by id", () => {
    const d = discoveryFor([
      record(2, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
      record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
    ]);
    expect(ids(build({ discovery: d }))).toEqual([vid(1), vid(2)]);
  });
});
