import { expect, it } from "vitest";
import { selectSourceFact, sourceFactHeadsAt, sourceFactRequest, SOURCE_FACT_BOUNDS } from "../../src/lib/predictive/sourceFacts.ts";
import { SOURCE_LINEAGE_VERSION, type SourceBindingEvent } from "../../src/lib/predictive/sourceLineage.ts";
import { planSourceStatsNormalization, type SourceNormalizationPlan } from "../../src/lib/predictive/sourceNormalization.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { gameId } from "./fixtures/passingYards.ts";
import { normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "./fixtures/sourceNormalization.ts";

const A = "2026-10-10T12:00:00.000Z";
const B = "2026-10-10T13:00:00.000Z";
const C = "2026-10-10T14:00:00.000Z";
const keyA = "player-game-stats:" + NORMALIZATION_GAME + ":00-0000001";
const keyB = "player-game-stats:" + NORMALIZATION_GAME + ":00-0000002";
const rawKey = digest(canonical(["2026_06_CAR_PHI", "PHI", "00-0000001"]));
const planAt = async (cutoff = A, change: { player?: string; game?: string; missing?: boolean } = {}) => {
  const { source, context, bridgeRows } = await normalizationFixture();
  source.evidence.request.cutoff = cutoff; source.evidence.captures[0].ingestedAt = cutoff;
  if (change.missing) { source.status = "unavailable-source-claim"; source.reason = "source-row-missing"; source.evidence.rows = []; }
  source.inputDigest = digest(canonical(source.evidence));
  if (change.player) bridgeRows.find((row) => row.kind === "player-bridge")!.data.playerId = change.player;
  if (change.game) for (const row of bridgeRows) if (row.kind === "game-bridge" || row.kind === "schedule") row.data.gameId = change.game;
  rewriteNormalizationRows(context, bridgeRows);
  return planSourceStatsNormalization(source, context, "2026-10-11T12:00:00.000Z");
};
// Explicit hand-authored lineage links and IDs, independent of the selector.
const event = (id: string, plan: SourceNormalizationPlan, parent: string | null = null): SourceBindingEvent => ({
  version: SOURCE_LINEAGE_VERSION, id, predecessorId: parent, recordedAt: plan.binding.cutoff, plan,
  revision: plan.candidate ? { id: "revision-" + id, sourceRecordId: rawKey, predecessorId: null, correctionReason: null, ...structuredClone(plan.candidate) } : null,
});
const request = (plan: SourceNormalizationPlan, cutoff: string, entityKeys = [keyA]) => ({ profileIds: [plan.binding.sourceProfileId], entityKeys, cutoff });

it.each(["player", "game"])("canonical facts follow the entire raw lineage before filtering a corrected %s", async (kind) => {
  const a = event("A", await planAt());
  const plan = await planAt(B, kind === "player" ? { player: "00-0000002" } : { game: gameId(67) });
  const b = event("B", plan, a.id);
  const destination = kind === "player" ? keyB : "player-game-stats:" + gameId(67) + ":00-0000001";
  const before = sourceFactHeadsAt([b, a], [a.plan], request(a.plan, A));
  expect(selectSourceFact(before, keyA)).toMatchObject({ state: "selected", head: { head: { id: "A", revision: { data: { passingYards: 80 } } } } });
  const old = sourceFactHeadsAt([b, a], [plan], request(plan, B));
  expect(selectSourceFact(old, keyA)).toMatchObject({ state: "missing", head: null });
  expect(old.heads).toEqual([]); expect(old.withheld).toEqual([]);
  expect(selectSourceFact(sourceFactHeadsAt([b, a], [plan], request(plan, B, [destination])), destination))
    .toMatchObject({ state: "selected", head: { head: { id: "B", revision: { id: "revision-B" } } } });
  expect(sourceFactHeadsAt([a, b], [a.plan], request(a.plan, A))).toEqual(before);
});

it("unrecorded identity changes withhold both the old and newly mapped destinations without returning stale values", async () => {
  const a = event("A", await planAt()); const unrecorded = await planAt(B, { player: "00-0000002" });
  for (const key of [keyA, keyB]) {
    const snapshot = sourceFactHeadsAt([a], [unrecorded], request(unrecorded, B, [key]));
    expect(snapshot.heads).toEqual([]);
    expect(snapshot.withheld).toEqual([{ lineageKey: expect.any(String), profileId: a.plan.binding.sourceProfileId,
      bindingId: "A", reason: "source-binding-stale", routing: "known-destinations", entityKeys: [key] }]);
    expect(selectSourceFact(snapshot, key)).toMatchObject({ state: "withheld", head: null });
    expect(JSON.stringify(snapshot)).not.toContain("passingYards");
  }
});

it("recorded missing rows withhold history and reappearance reuses its revision with a new binding token", async () => {
  const a = event("A", await planAt()); const b = event("B", await planAt(B, { missing: true }), "A");
  const missing = sourceFactHeadsAt([b, a], [b.plan], request(b.plan, B));
  expect(selectSourceFact(missing, keyA)).toMatchObject({ state: "withheld", head: null, withheld: [{ reason: "source-row-missing" }] });
  expect(missing.heads).toEqual([]);
  const otherDestination = sourceFactHeadsAt([b, a], [b.plan], request(b.plan, B, [keyB]));
  expect(selectSourceFact(otherDestination, keyB)).toMatchObject({ state: "withheld", head: null,
    withheld: [{ reason: "source-row-missing", routing: "unresolved", entityKeys: [] }] });
  const c = event("C", await planAt(C), "B"); c.revision = structuredClone(a.revision);
  const recovered = selectSourceFact(sourceFactHeadsAt([c, a, b], [c.plan], request(c.plan, C)), keyA).head!;
  const original = selectSourceFact(sourceFactHeadsAt([a], [a.plan], request(a.plan, A)), keyA).head!;
  expect(recovered.head.revision).toEqual(original.head.revision);
  expect(recovered.revisionKnownAt).toBe(A); expect(recovered.head.recordedAt).toBe(C);
  expect(recovered.headToken).not.toBe(original.headToken);
  expect(recovered.headToken).toBe(digest(canonical({ bindingId: "C", revisionId: "revision-A", planDigest: c.plan.planDigest })));
});

it("unchanged recaptures and equal recorder times use predecessor order, while late recording cannot backdate revision knowledge", async () => {
  const a = event("z", await planAt()); a.recordedAt = B;
  expect(sourceFactHeadsAt([a], [a.plan], request(a.plan, A)).heads).toEqual([]);
  const current = await planAt(B);
  // The original plan's capture visibility must be reproduced, not replaced by
  // a later synthetic ingestion time merely to simulate an unchanged query.
  const copy = structuredClone(a.plan); copy.binding.cutoff = B; copy.binding.sourceRequest.cutoff = B;
  copy.planDigest = digest(canonical({ reason: copy.reason, candidate: copy.candidate, binding: copy.binding }));
  const b = event("a", copy, "z"); b.recordedAt = B; b.revision = structuredClone(a.revision);
  const snapshot = sourceFactHeadsAt([b, a], [copy], request(current, B));
  expect(snapshot.heads[0]).toMatchObject({ revisionKnownAt: B, head: { id: "a", recordedAt: B } });
});

it("canonical fact snapshots distinguish several observed provider heads from a single observed head", async () => {
  const a = event("A", await planAt()); const secondPlan = structuredClone(a.plan);
  secondPlan.binding.sourceProfileId = "other-player-profile"; secondPlan.binding.sourceRequest.profileId = "other-player-profile";
  secondPlan.planDigest = digest(canonical({ reason: secondPlan.reason, candidate: secondPlan.candidate, binding: secondPlan.binding }));
  const b = event("B", secondPlan);
  const scope = { profileIds: [secondPlan.binding.sourceProfileId, a.plan.binding.sourceProfileId], entityKeys: [keyA, keyA], cutoff: A };
  const snapshot = sourceFactHeadsAt([b, a], [secondPlan, a.plan], scope);
  expect(selectSourceFact(snapshot, keyA)).toMatchObject({ state: "ambiguous", head: null });
  expect(snapshot.heads).toHaveLength(2);
  expect(sourceFactHeadsAt([a, b], [a.plan, secondPlan], { ...scope, profileIds: [...scope.profileIds].reverse() })).toEqual(snapshot);
});

it("a withheld expected provider stays explicit alongside another observed provider", async () => {
  const a = event("A", await planAt()); const missingPlan = await planAt(B, { missing: true });
  const missing = event("missing", missingPlan, "A");
  const otherPlan = structuredClone(await planAt(B));
  otherPlan.binding.sourceProfileId = "other-player-profile"; otherPlan.binding.sourceRequest.profileId = "other-player-profile";
  otherPlan.planDigest = digest(canonical({ reason: otherPlan.reason, candidate: otherPlan.candidate, binding: otherPlan.binding }));
  const other = event("other", otherPlan);
  const snapshot = sourceFactHeadsAt([missing, other, a], [otherPlan, missingPlan],
    { profileIds: [a.plan.binding.sourceProfileId, otherPlan.binding.sourceProfileId], entityKeys: [keyA], cutoff: B });
  expect(selectSourceFact(snapshot, keyA)).toMatchObject({ state: "withheld", head: null });
  expect(snapshot.heads).toHaveLength(1); expect(snapshot.withheld[0].reason).toBe("source-row-missing");
});

it("no bound contribution, even with a usable plan, remains missing-binding rather than usable statistics", async () => {
  const plan = await planAt(); const snapshot = sourceFactHeadsAt([], [plan], request(plan, A));
  expect(snapshot.heads).toEqual([]); expect(snapshot.withheld[0].reason).toBe("source-binding-missing");
  expect(snapshot.coverage).toBe("recorded-lineages-only");
  expect(snapshot).toMatchObject({ observationsPublished: false, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" });
});

it("the current plan must be present exactly once at the requested cutoff and retain its valid witness digest", async () => {
  const a = event("A", await planAt()); const scope = request(a.plan, A);
  expect(() => sourceFactHeadsAt([a], [], scope)).toThrow("source-fact-plan-missing");
  expect(() => sourceFactHeadsAt([a], [a.plan, a.plan], scope)).toThrow("source-fact-plan-duplicate");
  expect(() => sourceFactHeadsAt([a], [a.plan], { ...scope, cutoff: B })).toThrow("source-fact-plan-scope-refused");
  const forged = structuredClone(a.plan); forged.candidate!.data.passingYards = 999;
  expect(() => sourceFactHeadsAt([a], [forged], scope)).toThrow("source-lineage-plan-refused");
});

it("equivalent rights renewal preserves the selected binding and its evidence digest", async () => {
  const a = event("A", await planAt()); const scope = request(a.plan, A);
  const original = sourceFactHeadsAt([a], [a.plan], scope);
  // Rights are verified by the persisted reader. The pure freshness rule must
  // not confuse a newly authorized decision ID with changed source evidence.
  const renewed = structuredClone(a.plan); renewed.binding.rightsDecisionIds = ["renewed-internal-research-rights"];
  renewed.planDigest = digest(canonical({ reason: renewed.reason, candidate: renewed.candidate, binding: renewed.binding }));
  expect(sourceFactHeadsAt([a], [renewed], scope)).toEqual(original);
});

it("unresolved routing stays explicit for any canonical filter instead of being assumed unrelated", async () => {
  const missing = event("missing", await planAt(A, { missing: true }));
  for (const entityKeys of [[keyA], [keyB], []]) {
    const snapshot = sourceFactHeadsAt([missing], [missing.plan], request(missing.plan, A, entityKeys));
    expect(snapshot.heads).toEqual([]);
    expect(snapshot.withheld).toEqual([{ lineageKey: expect.any(String), profileId: missing.plan.binding.sourceProfileId,
      bindingId: "missing", reason: "source-row-missing", routing: "unresolved", entityKeys: [] }]);
    expect(selectSourceFact(snapshot, entityKeys[0] ?? keyB)).toMatchObject({ state: "withheld", head: null });
  }
});

it("canonical scope and operation bounds refuse invalid, unrelated and oversized inputs without truncating them", async () => {
  const plan = await planAt(); const scope = request(plan, A);
  for (const entityKeys of [["schedule:" + NORMALIZATION_GAME], ["player-game-stats:bad:00-0000001"], ["team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:LAR"]])
    expect(() => sourceFactRequest({ ...scope, entityKeys })).toThrow("source-fact-request-refused");
  expect(() => sourceFactRequest({ ...scope, profileIds: [] })).toThrow("source-fact-request-refused");
  expect(() => sourceFactRequest({ ...scope, profileIds: Array(SOURCE_FACT_BOUNDS.profiles + 1).fill("profile") })).toThrow("source-fact-request-refused");
  expect(() => sourceFactHeadsAt([], Array(SOURCE_FACT_BOUNDS.lineages + 1).fill(plan), scope)).toThrow("source-fact-bounds-refused");
  expect(() => sourceFactHeadsAt([], [plan], { ...scope, profileIds: ["unrelated-profile"] })).toThrow("source-fact-plan-scope-refused");
  const snapshot = sourceFactHeadsAt([], [], scope);
  expect(() => selectSourceFact(snapshot, keyB)).toThrow("source-fact-selection-scope-refused");
});
