import { describe, expect, it } from "vitest";
import {
  DECISION_REASON_MAX_LENGTH,
  checkDecisionEvent,
  effectiveDecisions,
  hasActiveDecision,
  parseDecisionsFile,
  type DecisionEvent,
} from "./creatorDecisions.ts";

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const event = (overrides: Partial<DecisionEvent> = {}): DecisionEvent => ({
  videoId: A,
  decision: "include",
  reason: "props throughout",
  ruleVersion: "v1",
  decidedAt: "2026-10-07T12:00:00.000Z",
  ...overrides,
});

describe("checkDecisionEvent", () => {
  it("accepts a complete event with every provenance field", () => {
    expect(checkDecisionEvent(event())).toBeNull();
    for (const decision of ["include", "exclude", "clear"] as const) {
      expect(checkDecisionEvent(event({ decision }))).toBeNull();
    }
    expect(checkDecisionEvent(event({ decidedAt: "2026-10-07T12:00:00Z" }))).toBeNull();
  });

  it.each([
    ["not an object", null, "invalid-event"],
    ["an array", [], "invalid-event"],
    ["a missing field", (({ ruleVersion: _unused, ...rest }) => rest)(event()), "invalid-event"],
    ["an extra field", { ...event(), extra: 1 }, "invalid-event"],
    ["a short video id", event({ videoId: "short" }), "invalid-video-id"],
    ["an id with a slash", event({ videoId: "aaaaaaaaaa/" }), "invalid-video-id"],
    ["an unknown decision", event({ decision: "maybe" as never }), "invalid-decision"],
    ["a blank reason", event({ reason: "   " }), "reason-required"],
    ["a missing reason", event({ reason: undefined as never }), "reason-required"],
    ["a reason over the limit", event({ reason: "x".repeat(DECISION_REASON_MAX_LENGTH + 1) }), "reason-too-long"],
    ["a malformed rule version", event({ ruleVersion: "1" }), "invalid-rule-version"],
    ["a non-ISO date", event({ decidedAt: "10/07/2026" }), "invalid-decided-at"],
    ["a date without a timezone", event({ decidedAt: "2026-10-07T12:00:00" }), "invalid-decided-at"],
    ["an impossible date", event({ decidedAt: "2026-13-45T12:00:00Z" }), "invalid-decided-at"],
  ])("rejects %s", (_name, value, problem) => expect(checkDecisionEvent(value)).toBe(problem));

  it("accepts a reason exactly at the limit", () => {
    expect(checkDecisionEvent(event({ reason: "x".repeat(DECISION_REASON_MAX_LENGTH) }))).toBeNull();
  });
});

describe("parseDecisionsFile", () => {
  it("accepts per-creator event lists", () => {
    const file = { "creator-a": [event(), event({ decision: "clear", reason: "reconsidering" })] };
    expect(parseDecisionsFile(file)).toEqual(file);
    expect(parseDecisionsFile({})).toEqual({});
  });

  it("rejects the whole file if any entry is malformed, so no decision is silently dropped", () => {
    for (const bad of [
      [],
      "x",
      { "Bad Key": [] },
      { "creator-a": "x" },
      { "creator-a": [event(), { ...event(), reason: "" }] },
      { "creator-a": [{ videoId: A, decision: "include", reason: "old format without provenance" }] },
    ]) {
      expect(() => parseDecisionsFile(bad)).toThrow(expect.objectContaining({ code: "invalid-decisions-file" }));
    }
  });
});

describe("effectiveDecisions", () => {
  it("makes the latest event for each video the active decision and carries its provenance", () => {
    const result = effectiveDecisions([
      event({ decision: "include", reason: "first", decidedAt: "2026-10-07T10:00:00.000Z" }),
      event({ decision: "exclude", reason: "second", decidedAt: "2026-10-07T11:00:00.000Z" }),
      event({ videoId: B, decision: "include", reason: "other video", decidedAt: "2026-10-07T09:00:00.000Z" }),
    ]);
    expect(result).toEqual([
      { videoId: A, decision: "exclude", reason: "second", ruleVersion: "v1", decidedAt: "2026-10-07T11:00:00.000Z" },
      { videoId: B, decision: "include", reason: "other video", ruleVersion: "v1", decidedAt: "2026-10-07T09:00:00.000Z" },
    ]);
  });

  it("orders by decision time, not file position", () => {
    const result = effectiveDecisions([
      event({ decision: "exclude", reason: "later", decidedAt: "2026-10-07T12:00:00.000Z" }),
      event({ decision: "include", reason: "earlier", decidedAt: "2026-10-07T08:00:00.000Z" }),
    ]);
    expect(result).toMatchObject([{ decision: "exclude", reason: "later" }]);
  });

  it("breaks a tie on decision time by file order", () => {
    const at = "2026-10-07T12:00:00.000Z";
    const result = effectiveDecisions([
      event({ decision: "include", reason: "first", decidedAt: at }),
      event({ decision: "exclude", reason: "second", decidedAt: at }),
    ]);
    expect(result).toMatchObject([{ decision: "exclude", reason: "second" }]);
  });

  it("treats a final clear as no active override while the log keeps the earlier events", () => {
    const events = [
      event({ decision: "include", decidedAt: "2026-10-07T10:00:00.000Z" }),
      event({ decision: "clear", reason: "reconsidering after the full video", decidedAt: "2026-10-07T11:00:00.000Z" }),
    ];
    expect(effectiveDecisions(events)).toEqual([]);
    expect(events).toHaveLength(2);
    expect(hasActiveDecision(events, A)).toBe(false);
  });

  it("lets a decision made after a clear take effect again", () => {
    const result = effectiveDecisions([
      event({ decision: "include", decidedAt: "2026-10-07T10:00:00.000Z" }),
      event({ decision: "clear", reason: "unsure", decidedAt: "2026-10-07T11:00:00.000Z" }),
      event({ decision: "exclude", reason: "recap only", decidedAt: "2026-10-07T12:00:00.000Z" }),
    ]);
    expect(result).toMatchObject([{ decision: "exclude", reason: "recap only" }]);
  });

  it("returns an empty list for an empty log and never mutates its input", () => {
    expect(effectiveDecisions([])).toEqual([]);
    const events = [event({ decision: "exclude", decidedAt: "2026-10-07T12:00:00.000Z" }), event({ decidedAt: "2026-10-07T08:00:00.000Z" })];
    const copy = structuredClone(events);
    effectiveDecisions(events);
    expect(events).toEqual(copy);
  });

  it("reports whether a video has an active decision", () => {
    const events = [event()];
    expect(hasActiveDecision(events, A)).toBe(true);
    expect(hasActiveDecision(events, B)).toBe(false);
  });
});
