// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCaptureEvent, type CaptureEvent } from "../../src/lib/creatorCaptures.ts";
import type { DecisionEvent, DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import { buildReadinessGate } from "./readinessGate.ts";
import {
  planCorpusImport,
  type CorpusImportPlan,
  type CorpusInputFingerprints,
  type CorpusStoredState,
} from "./importPlanner.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

const fingerprints = (letter = "a"): CorpusInputFingerprints => ({
  registration: letter.repeat(64),
  gate: "b".repeat(64),
  captures: "c".repeat(64),
  decisions: "d".repeat(64),
  discovery: "e".repeat(64),
});

const capture = (n: number, text = `transcript ${n} `.repeat(30), action: "capture" | "replace" = "capture"): CaptureEvent =>
  buildCaptureEvent({
    creatorKey: "creator-a",
    videoId: vid(n),
    action,
    text,
    publishedDate: "2025-10-09",
    captionKind: "uploaded",
    ...(action === "replace" ? { reason: "Corrected owner paste" } : {}),
  }, NOW);

const decision = (n: number, overrides: Partial<DecisionEvent> = {}): DecisionEvent => ({
  videoId: vid(n),
  decision: "include",
  reason: "Owner confirmed the whole video is in scope",
  ruleVersion: "v1",
  decidedAt: "2026-10-07T11:00:00.000Z",
  ...overrides,
});

const emptyStored = (): CorpusStoredState => ({
  captureEvents: [],
  decisionEvents: [],
  gateRegistrations: [],
  apiVideos: [],
  imports: [],
});

const inputs = (overrides: {
  captures?: CaptureEvent[];
  decisions?: DecisionsFile;
  discovery?: ReturnType<typeof discoveryFor>;
  fingerprints?: CorpusInputFingerprints;
  stored?: CorpusStoredState;
} = {}) => {
  const discovery = overrides.discovery ?? discoveryFor([record(1), record(2)]);
  return {
    captures: overrides.captures ?? [capture(1)],
    decisions: overrides.decisions ?? { "creator-a": [decision(1), decision(77)] },
    discovery,
    registration: discovery.registration,
    gate: buildReadinessGate({
      keys: discovery.creators.map((creator) => creator.key),
      saltHex: "f".repeat(64),
      registeredAt: "2026-10-06T01:00:00.000Z",
      endSeason: discovery.registration.window.endSeason,
      endWeek: discovery.registration.window.endWeek,
      ruleVersion: discovery.registration.ruleVersion,
    }),
    fingerprints: overrides.fingerprints ?? fingerprints(),
    stored: overrides.stored ?? emptyStored(),
    now: NOW,
  };
};

const appendPlan = (overrides: Parameters<typeof inputs>[0] = {}) => {
  const plan = planCorpusImport(inputs(overrides));
  expect(plan.outcome).toBe("append");
  return plan as Extract<CorpusImportPlan, { outcome: "append" }>;
};

const storedFrom = (plan: Extract<CorpusImportPlan, { outcome: "append" }>): CorpusStoredState => ({
  captureEvents: plan.captureEvents.map(({ creatorKey, logPosition, eventFingerprint }) => ({ creatorKey, logPosition, eventFingerprint })),
  decisionEvents: plan.decisionEvents.map(({ creatorKey, filePosition, eventFingerprint }) => ({ creatorKey, filePosition, eventFingerprint })),
  gateRegistrations: plan.gateRegistration ? [plan.gateRegistration] : [],
  apiVideos: plan.apiSnapshots.flatMap((snapshot) => snapshot.rows),
  imports: [{ importId: "41", ...plan.audit }],
});

describe("planCorpusImport", () => {
  it("plans a first append without retaining private transcript or YouTube text and reports unapplied decisions", () => {
    const source = inputs();
    const before = JSON.stringify(source);
    const plan = planCorpusImport(source);
    expect(plan.outcome).toBe("append");
    if (plan.outcome !== "append") throw new Error("expected append plan");
    expect(plan.captureEvents).toHaveLength(1);
    expect(plan.captureEvents[0]).toMatchObject({
      creatorKey: "creator-a",
      logPosition: 1,
      videoId: vid(1),
      eventKind: "captured",
      transcriptCharacters: source.captures[0].characters,
    });
    expect(plan.decisionEvents).toHaveLength(2);
    expect(plan.gateRegistration).toMatchObject({ eligibleCreatorCount: 2, startSeason: 2024, endWeek: 4 });
    expect(plan.apiSnapshots.map(({ creatorKey, action }) => [creatorKey, action])).toEqual([
      ["creator-a", "replace"],
      ["creator-b", "replace"],
    ]);
    expect(plan.decisionsNotApplied).toEqual([
      { creatorKey: "creator-a", videoId: vid(77), why: "video-not-in-discovery" },
    ]);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(source.captures[0].text);
    expect(serialized).not.toContain("NFL Week 6 best bets");
    expect(serialized).not.toContain('"description"');
    expect(JSON.stringify(source)).toBe(before);
  });

  it("returns a true no-op only when the exact import and all projections still match", () => {
    const first = appendPlan();
    const plan = planCorpusImport(inputs({ stored: storedFrom(first) }));
    expect(plan).toEqual({
      outcome: "no-op",
      existingImportId: "41",
      decisionsNotApplied: [{ creatorKey: "creator-a", videoId: vid(77), why: "video-not-in-discovery" }],
    });
  });

  it("appends only new owner-event tails and can audit a changed source snapshot without rewriting identical API rows", () => {
    const baseCaptures = [capture(1)];
    const baseDecisions = { "creator-a": [decision(1)] };
    const first = appendPlan({ captures: baseCaptures, decisions: baseDecisions });
    const stored = storedFrom(first);
    stored.imports = [];
    const plan = appendPlan({
      captures: [...baseCaptures, capture(1, "corrected transcript ".repeat(20), "replace")],
      decisions: { "creator-a": [decision(1), decision(77, { decision: "exclude", decidedAt: "2026-10-07T11:30:00.000Z" })] },
      fingerprints: { ...fingerprints(), captures: "1".repeat(64), decisions: "2".repeat(64), discovery: "3".repeat(64) },
      stored,
    });
    expect(plan.captureEvents.map((row) => row.logPosition)).toEqual([2]);
    expect(plan.decisionEvents.map((row) => row.filePosition)).toEqual([2]);
    expect(plan.gateRegistration).toBeNull();
    expect(plan.apiSnapshots.every((snapshot) => snapshot.action === "no-op")).toBe(true);
  });

  it("refuses changed, truncated and structurally invalid stored owner history", () => {
    const twoCaptures = [capture(1), capture(1, "replacement transcript ".repeat(20), "replace")];
    const twoDecisions = { "creator-a": [decision(1), decision(2)] };
    const first = appendPlan({ captures: twoCaptures, decisions: twoDecisions });
    const stored = storedFrom(first);
    stored.imports = [];

    const truncated = planCorpusImport(inputs({ captures: [twoCaptures[0]], decisions: { "creator-a": [decision(1)] }, stored }));
    expect(truncated).toMatchObject({
      outcome: "refuse",
      refusals: expect.arrayContaining([
        { stream: "captures", code: "history-truncated", creatorKey: "creator-a", position: 2 },
        { stream: "decisions", code: "history-truncated", creatorKey: "creator-a", position: 2 },
      ]),
    });

    const changed = planCorpusImport(inputs({
      captures: [capture(1, "different valid transcript ".repeat(20)), twoCaptures[1]],
      decisions: { "creator-a": [decision(1, { reason: "Edited old reason" }), decision(2)] },
      stored,
    }));
    expect(changed).toMatchObject({
      outcome: "refuse",
      refusals: expect.arrayContaining([
        { stream: "captures", code: "history-changed", creatorKey: "creator-a", position: 1 },
        { stream: "decisions", code: "history-changed", creatorKey: "creator-a", position: 1 },
      ]),
    });

    const malformed = structuredClone(stored);
    malformed.captureEvents[1].logPosition = 3;
    expect(planCorpusImport(inputs({ captures: twoCaptures, decisions: twoDecisions, stored: malformed }))).toMatchObject({
      outcome: "refuse",
      refusals: expect.arrayContaining([{ stream: "captures", code: "stored-history-invalid", creatorKey: "creator-a" }]),
    });
  });

  it("refuses an exact-import projection drift instead of silently repairing or spending another import identity", () => {
    const first = appendPlan();
    const stored = storedFrom(first);
    stored.apiVideos = stored.apiVideos.slice(1);
    expect(planCorpusImport(inputs({ stored }))).toMatchObject({
      outcome: "refuse",
      refusals: expect.arrayContaining([{ stream: "projection", code: "import-projection-drift" }]),
    });
  });

  it("refuses incoherent gate, registration and creator-count inputs before planning", () => {
    const source = inputs();
    expect(() => planCorpusImport({ ...source, gate: { ...source.gate, ruleVersion: "v2" } })).toThrow(
      expect.objectContaining({ code: "registration-gate-mismatch" })
    );
    expect(() => planCorpusImport({
      ...source,
      discovery: { ...source.discovery, registration: { ...source.registration, registeredAt: "2026-10-06T00:00:01Z" } },
    })).toThrow(expect.objectContaining({ code: "registration-discovery-mismatch" }));
    expect(() => planCorpusImport({ ...source, gate: { ...source.gate, eligibleCreatorCount: 1 } })).toThrow(
      expect.objectContaining({ code: "eligible-creator-count-mismatch" })
    );
    expect(() => planCorpusImport({
      ...source,
      captures: [{ ...source.captures[0], creatorKey: "creator-z" }],
    })).toThrow(expect.objectContaining({ code: "unknown-capture-creator" }));
    const invalidDiscovery = structuredClone(source.discovery);
    invalidDiscovery.creators[0].videos[0].durationSeconds = -1;
    expect(() => planCorpusImport({ ...source, discovery: invalidDiscovery })).toThrow(
      expect.objectContaining({ code: "invalid-api-video-projection" })
    );
  });

  it("refuses stale discovery even when new owner history would otherwise append", () => {
    const first = appendPlan();
    const staleDiscovery = discoveryFor([
      record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" }),
      record(2, { apiFetchedAt: "2026-08-01T00:00:00.000Z" }),
    ], [record(900, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);

    expect(() => planCorpusImport(inputs({
      captures: [capture(1), capture(1, "new owner correction ".repeat(20), "replace")],
      discovery: staleDiscovery,
      fingerprints: { ...fingerprints(), captures: "1".repeat(64), discovery: "2".repeat(64) },
      stored: storedFrom(first),
    }))).toThrow(expect.objectContaining({ code: "stale-discovery-data" }));
  });
});
