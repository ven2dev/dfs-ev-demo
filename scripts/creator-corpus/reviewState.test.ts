// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DecisionEvent } from "../../src/lib/creatorDecisions.ts";
import { DESCRIPTION_SNIPPET_LENGTH, REASON_LABELS, buildReviewState } from "./reviewState.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

const event = (overrides: Partial<DecisionEvent> = {}): DecisionEvent => ({
  videoId: vid(1),
  decision: "include",
  reason: "props throughout",
  ruleVersion: "v1",
  decidedAt: "2026-10-07T13:00:00.000Z",
  ...overrides,
});
const build = (decisions: Record<string, DecisionEvent[]> = {}, discovery = discoveryFor([record(1), record(2, { title: "NFL Week 6 recap" })])) =>
  buildReviewState({ discovery, decisions, now: NOW });

describe("REASON_LABELS", () => {
  it("gives every reason code a readable sentence", () => {
    for (const [code, label] of Object.entries(REASON_LABELS)) {
      expect(label, code).toMatch(/^[A-Z].*\.$/);
    }
    expect(Object.keys(REASON_LABELS)).toHaveLength(18);
  });
});

describe("buildReviewState", () => {
  it("lists each video with its week, classification, labelled reasons and current status", () => {
    const [creatorA] = build().creators;
    expect(creatorA.videos.find((video) => video.videoId === vid(2))).toMatchObject({
      season: 2025,
      week: 6,
      classification: "excluded",
      status: "excluded",
      reasons: [{ code: "no-prop-signal", label: REASON_LABELS["no-prop-signal"] }],
      decision: null,
      events: [],
    });
  });

  it("applies the active decision and keeps the full event history for that video only", () => {
    const events = [
      event(),
      event({ decision: "clear", reason: "unsure", decidedAt: "2026-10-07T14:00:00.000Z" }),
      event({ videoId: vid(2), decision: "include", reason: "title misleading", decidedAt: "2026-10-07T15:00:00.000Z" }),
    ];
    const [creatorA] = build({ "creator-a": events }).creators;
    const first = creatorA.videos.find((video) => video.videoId === vid(1))!;
    const second = creatorA.videos.find((video) => video.videoId === vid(2))!;
    expect(first).toMatchObject({ status: "needs-review", decision: null });
    expect(first.events.map((entry) => entry.decision)).toEqual(["include", "clear"]);
    expect(second).toMatchObject({
      status: "present",
      decision: { decision: "include", reason: "title misleading", ruleVersion: "v1", decidedAt: "2026-10-07T15:00:00.000Z" },
    });
    expect(second.events).toHaveLength(1);
  });

  it("keeps one creator's decisions out of another's state", () => {
    const state = build({ "creator-b": [event({ videoId: vid(900) })] });
    expect(state.creators[0].videos.every((video) => video.decision === null)).toBe(true);
    expect(state.creators[1].videos[0].decision).toMatchObject({ decision: "include" });
  });

  it("shortens long descriptions to a single-spaced snippet and leaves short ones alone", () => {
    const long = "word ".repeat(400);
    const state = build({}, discoveryFor([record(1, { description: long }), record(2, { description: "  short\n\n text  " })]));
    const [one, two] = ["1", "2"].map((n) => state.creators[0].videos.find((video) => video.videoId === vid(Number(n)))!);
    expect(one.description.length).toBe(DESCRIPTION_SNIPPET_LENGTH + 1);
    expect(one.description.endsWith("…")).toBe(true);
    expect(two.description).toBe("short text");
  });

  it("reports slots, summary and the registered window the page needs", () => {
    const state = build();
    expect(state.ruleVersion).toBe("v1");
    expect(state.window).toEqual({ endSeason: 2026, endWeek: 4 });
    expect(state.creators[0].slots).toHaveLength(40);
    expect(state.creators[0].summary.videos).toEqual({ present: 0, "needs-review": 1, excluded: 1 });
    expect(state.generatedAt).toBe(NOW.toISOString());
  });

  it("marks stale data as blocking and counts the stale videos across creators", () => {
    expect(build().stale).toEqual({ blocked: false, staleVideos: 0, maxAgeDays: 30, oldestFetchedAt: NOW.toISOString() });
    const stale = discoveryFor([record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })], [record(900, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    expect(build({}, stale).stale).toEqual({ blocked: true, staleVideos: 2, maxAgeDays: 30, oldestFetchedAt: "2026-08-01T00:00:00.000Z" });
  });
});
