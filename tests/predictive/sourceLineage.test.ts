import { expect, it } from "vitest";
import { planSourceBindingTransition, SOURCE_LINEAGE_VERSION, sourceBindingHeadsAt, sourceStatsLineageKey,
  sourceStatsRawKey, type SourceBindingEvent } from "../../src/lib/predictive/sourceLineage.ts";
import { planSourceStatsNormalization, type SourceNormalizationPlan } from "../../src/lib/predictive/sourceNormalization.ts";
import { canonical, digest, entityKey } from "../../src/lib/predictive/validation.ts";
import { gameId } from "./fixtures/passingYards.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
import { normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "./fixtures/sourceNormalization.ts";

const A = "2026-10-10T12:00:00.000Z";
const B = "2026-10-10T13:00:00.000Z";
const C = "2026-10-10T14:00:00.000Z";
const rawKey = digest(canonical(["2026_06_CAR_PHI", "PHI", "00-0000001"]));
const statsKey = "player-game-stats:" + NORMALIZATION_GAME + ":00-0000001";
const planAt = async (cutoff = A, options: { yards?: string; player?: string; game?: string; unavailable?: boolean } = {}) => {
  const { source, context, bridgeRows } = await normalizationFixture("player", sourceCsv("player", [
    { ...sourceSamples().player[0], passing_yards: options.yards ?? "80" },
  ]));
  source.evidence.request.cutoff = cutoff; source.evidence.captures[0].ingestedAt = cutoff;
  if (options.unavailable) { source.status = "unavailable-source-claim"; source.reason = "source-row-missing"; source.evidence.rows = []; }
  source.inputDigest = digest(canonical(source.evidence));
  if (options.player) {
    const bridge = bridgeRows.find((row) => row.kind === "player-bridge")!; bridge.data.playerId = options.player;
  }
  if (options.game) for (const row of bridgeRows) if (row.kind === "game-bridge" || row.kind === "schedule") row.data.gameId = options.game;
  rewriteNormalizationRows(context, bridgeRows);
  return planSourceStatsNormalization(source, context, "2026-10-11T12:00:00.000Z");
};
// Hand-authored ledger fixtures: they do not call the transition planner to
// derive expected predecessor links, observation IDs, or raw identity hashes.
const event = (id: string, plan: SourceNormalizationPlan, predecessorId: string | null = null,
  canonicalPredecessorId: string | null = null, revisionId = "stats-" + id): SourceBindingEvent => ({
  version: SOURCE_LINEAGE_VERSION, id, predecessorId, recordedAt: plan.binding.cutoff, plan,
  revision: plan.candidate ? { id: revisionId, sourceRecordId: rawKey, predecessorId: canonicalPredecessorId,
    correctionReason: canonicalPredecessorId ? "source or normalization correction" : null, ...structuredClone(plan.candidate) } : null,
});
const attach = (id: string, plan: SourceNormalizationPlan, parent: SourceBindingEvent, prior: SourceBindingEvent): SourceBindingEvent =>
  ({ ...event(id, plan, parent.id), revision: structuredClone(prior.revision) });
const resign = (plan: SourceNormalizationPlan) => {
  plan.dataDigest = plan.candidate ? digest(canonical(plan.candidate)) : null;
  plan.planDigest = digest(canonical({ reason: plan.reason, candidate: plan.candidate, binding: plan.binding }));
};

it("keys normalization lineage by profile and raw identities, independently of canonical routing and cutoff", async () => {
  const first = await planAt(); const later = await planAt(B, { player: "00-0000002", game: gameId(67) });
  expect(sourceStatsRawKey(first.binding.sourceRequest)).toBe(rawKey);
  expect(sourceStatsLineageKey(later.binding.sourceRequest)).toBe(sourceStatsLineageKey(first.binding.sourceRequest));
  expect(sourceStatsLineageKey({ ...first.binding.sourceRequest, profileId: "other-provider-profile" })).not.toBe(sourceStatsLineageKey(first.binding.sourceRequest));
  expect(sourceStatsRawKey({ ...first.binding.sourceRequest, rawPlayerId: null })).toBe(digest(canonical(["2026_06_CAR_PHI", "PHI"])));
});
it("proposes the first observation without minting its observation ID or a cross-entity predecessor", async () => {
  const plan = await planAt();
  expect(planSourceBindingTransition(plan, [], A)).toMatchObject({ action: "append", expectedHeadId: null,
    sourceRecordId: rawKey, entityKey: statsKey, canonicalPredecessorId: null, existingObservationId: null });
  expect(planSourceBindingTransition(plan, [], A)).not.toHaveProperty("observationId");
});
it("appends a numeric correction to the same canonical source chain", async () => {
  const first = event("A", await planAt()); const next = await planAt(B, { yards: "81" });
  expect(planSourceBindingTransition(next, [first], B)).toMatchObject({ action: "append", expectedHeadId: "A",
    canonicalPredecessorId: "stats-A", previousSelectedObservationId: "stats-A", entityKey: statsKey });
  const second = event("B", next, "A", "stats-A");
  expect(sourceBindingHeadsAt([second, first], B)[0].revision?.data.passingYards).toBe(81);
  expect(sourceBindingHeadsAt([second, first], A)).toEqual([first]);
});
it("records new raw provenance without inventing a numeric correction for identical recaptures", async () => {
  const first = event("A", await planAt()); const plan = await planAt(B);
  expect(plan.binding.sourceCaptures[0].sha256).toBe(first.plan.binding.sourceCaptures[0].sha256);
  expect(plan.planDigest).not.toBe(first.plan.planDigest);
  expect(planSourceBindingTransition(plan, [first], B)).toMatchObject({ action: "attach", expectedHeadId: "A",
    existingObservationId: "stats-A", canonicalPredecessorId: null });
  const second = attach("B", plan, first, first);
  expect(sourceBindingHeadsAt([first, second], B)).toEqual([second]);
  expect(sourceBindingHeadsAt([first, second], A)).toEqual([first]);
});
it.each(["player", "game"])("selects the raw lineage head before routing a corrected %s identity", async (change) => {
  const first = event("A", await planAt());
  const plan = await planAt(B, change === "player" ? { player: "00-0000002" } : { game: gameId(67) });
  expect(plan.binding.sourceCaptures[0].sha256).toBe(first.plan.binding.sourceCaptures[0].sha256);
  expect(planSourceBindingTransition(plan, [first], B)).toMatchObject({ action: "append", expectedHeadId: "A", canonicalPredecessorId: null });
  const second = event("B", plan, "A");
  const atA = sourceBindingHeadsAt([second, first], A); const atB = sourceBindingHeadsAt([second, first], B);
  expect(atA.filter((row) => row.revision && entityKey(row.revision) === statsKey)).toEqual([first]);
  expect(atB.filter((row) => row.revision && entityKey(row.revision) === statsKey)).toEqual([]);
  expect(atB).toEqual([second]);
});
it("returns to the destination's previous canonical chain after A to B to A rerouting", async () => {
  const first = event("A", await planAt()); const second = event("B", await planAt(B, { player: "00-0000002" }), "A");
  const next = await planAt(C, { yards: "82" });
  expect(planSourceBindingTransition(next, [second, first], C)).toMatchObject({ action: "append", expectedHeadId: "B",
    previousSelectedObservationId: "stats-B", canonicalPredecessorId: "stats-A", entityKey: statsKey });
  const third = event("C", next, "B", "stats-A");
  expect(sourceBindingHeadsAt([third, second, first], C)).toEqual([third]);
});
it("reattaches the destination's unchanged head after identity rerouting", async () => {
  const first = event("A", await planAt()); const second = event("B", await planAt(B, { player: "00-0000002" }), "A");
  const next = await planAt(C);
  expect(planSourceBindingTransition(next, [second, first], C)).toMatchObject({ action: "attach", expectedHeadId: "B", existingObservationId: "stats-A" });
  const third = attach("C", next, second, first);
  expect(sourceBindingHeadsAt([third, second, first], C)).toEqual([third]);
});
it("withholds a disappeared raw row without resurrecting old statistics or publishing an absence or zero", async () => {
  const first = event("A", await planAt()); const missing = await planAt(B, { unavailable: true });
  expect(missing.binding.rawSourceKey).toBeNull();
  expect(planSourceBindingTransition(missing, [first], B)).toMatchObject({ action: "withhold", expectedHeadId: "A",
    sourceRecordId: rawKey, canonicalPredecessorId: null, candidate: null });
  const second = event("B", missing, "A");
  expect(sourceBindingHeadsAt([first, second], B)).toEqual([second]); expect(second.revision).toBeNull();
  expect(sourceBindingHeadsAt([first, second], A)).toEqual([first]);
});
it.each(["same", "changed"])("reappearance after withholding preserves the previous entity chain (%s values)", async (mode) => {
  const first = event("A", await planAt()); const second = event("B", await planAt(B, { unavailable: true }), "A");
  const plan = await planAt(C, { yards: mode === "same" ? "80" : "82" });
  expect(planSourceBindingTransition(plan, [second, first], C)).toMatchObject({ expectedHeadId: "B",
    action: mode === "same" ? "attach" : "append", canonicalPredecessorId: mode === "same" ? null : "stats-A",
    existingObservationId: mode === "same" ? "stats-A" : null });
});
it("uses explicit predecessors for equal-clock bindings and includes equality at the replay cutoff", async () => {
  const first = event("z", await planAt()); const second = attach("a", await planAt(), first, first);
  expect(sourceBindingHeadsAt([second, first], A)).toEqual([second]);
  expect(sourceBindingHeadsAt([second, first], "2026-10-10T11:59:59.999Z")).toEqual([]);
});
it("does not backdate canonical knowledge to an earlier source capture or planning cutoff", async () => {
  const first = event("A", await planAt()); first.recordedAt = B;
  expect(first.plan.binding.sourceCaptures[0].capturedAt).toBe("2026-10-09T12:00:00.000Z");
  expect(sourceBindingHeadsAt([first], A)).toEqual([]);
  expect(sourceBindingHeadsAt([first], B)).toEqual([first]);
});
it("maintains independent team-statistics lineage without requiring a player identity", async () => {
  const { source, context, bridgeRows } = await normalizationFixture("team");
  context.identityLinks = []; rewriteNormalizationRows(context, bridgeRows.filter((row) => row.kind !== "player-bridge"));
  const plan = planSourceStatsNormalization(source, context, "2026-10-11T12:00:00.000Z");
  const key = digest(canonical(["2026_06_CAR_PHI", "PHI"]));
  const first = event("team-A", plan); first.revision!.sourceRecordId = key;
  expect(planSourceBindingTransition(plan, [], A)).toMatchObject({ action: "append", sourceRecordId: key,
    entityKey: "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI" });
  expect(sourceBindingHeadsAt([first], A)).toEqual([first]);
});
it.each(["root", "successor"])("refuses divergent raw binding heads (%s branch)", async (mode) => {
  const first = event("A", await planAt()); const second = attach("B", await planAt(B), first, first);
  const third = mode === "root" ? event("C", await planAt(C)) : attach("C", await planAt(C), first, first);
  expect(() => sourceBindingHeadsAt([first, second, third], C)).toThrow("source-lineage-branch-refused");
});
it.each(["missing", "other-profile", "cycle"])("refuses broken raw lineage (%s)", async (mode) => {
  const first = event("A", await planAt()); const second = attach("B", await planAt(B), first, first);
  if (mode === "missing") second.predecessorId = "missing";
  if (mode === "other-profile") {
    second.plan.binding.sourceProfileId = "other-profile"; second.plan.binding.sourceRequest.profileId = "other-profile"; resign(second.plan);
  }
  if (mode === "cycle") { first.predecessorId = "B"; }
  expect(() => sourceBindingHeadsAt([first, second], C)).toThrow(mode === "cycle" ? "source-lineage-cycle-refused" : "source-lineage-predecessor-refused");
});
it.each(["cross-entity", "unlinked-root", "fake-attachment", "data", "raw-key", "withheld-revision"])("refuses an invalid canonical revision binding (%s)", async (mode) => {
  const first = event("A", await planAt());
  const second = mode === "withheld-revision" ? event("B", await planAt(B, { unavailable: true }), "A")
    : mode === "fake-attachment" ? event("B", await planAt(B), "A")
      : event("B", await planAt(B, { yards: "81", ...(mode === "cross-entity" ? { player: "00-0000002" } : {}) }), "A", "stats-A");
  if (mode === "unlinked-root") { second.revision!.predecessorId = null; second.revision!.correctionReason = null; }
  if (mode === "data") second.revision!.data.passingYards = 999;
  if (mode === "raw-key") second.revision!.sourceRecordId = "0".repeat(64);
  if (mode === "withheld-revision") second.revision = structuredClone(first.revision);
  expect(() => sourceBindingHeadsAt([first, second], B)).toThrow("source-lineage-revision-refused");
});
it("ignores malformed future bindings at earlier cutoffs, while refusing unreadable recorder timestamps", async () => {
  const first = event("A", await planAt()); const second = event("B", await planAt(B, { yards: "81" }), "A", "stats-A");
  second.revision!.data.passingYards = 999;
  expect(sourceBindingHeadsAt([first, second], A)).toEqual([first]);
  expect(() => sourceBindingHeadsAt([first, second], B)).toThrow("source-lineage-revision-refused");
  second.recordedAt = "not-an-instant";
  expect(() => sourceBindingHeadsAt([first, second], A)).toThrow("invalid-utc-instant");
});
it.each(["recorded-before-plan", "older-cutoff", "backdated-successor"])("refuses knowledge-time regression (%s)", async (mode) => {
  const first = event("A", await planAt(B)); const plan = await planAt(mode === "older-cutoff" ? A : C);
  if (mode === "recorded-before-plan") expect(() => planSourceBindingTransition(plan, [first], B)).toThrow("source-lineage-plan-refused");
  if (mode === "older-cutoff") expect(() => planSourceBindingTransition(plan, [first], C)).toThrow("source-lineage-time-refused");
  if (mode === "backdated-successor") {
    first.recordedAt = C; const second = attach("B", await planAt(B), first, first);
    expect(() => sourceBindingHeadsAt([first, second], C)).toThrow("source-lineage-time-refused");
  }
});
it.each(["hash", "raw-identity", "data-digest", "parser-version", "projection-version", "future-bridge", "future-capture"])("refuses plan integrity or knowledge-time drift (%s)", async (mode) => {
  const plan = await planAt();
  if (mode === "hash") plan.planDigest = "0".repeat(64);
  if (mode === "raw-identity") { plan.binding.sourceRequest.rawPlayerId = "00-0000002"; resign(plan); }
  if (mode === "data-digest") plan.dataDigest = "0".repeat(64);
  if (mode === "parser-version") { plan.binding.parserVersion = "unsupported-parser"; resign(plan); }
  if (mode === "projection-version") { plan.binding.projectionVersion = "unsupported-projection"; resign(plan); }
  if (mode === "future-bridge") { plan.binding.dependencies[0].ingestedAt = B; resign(plan); }
  if (mode === "future-capture") { plan.binding.sourceCaptures[0].ingestedAt = B; resign(plan); }
  expect(() => planSourceBindingTransition(plan, [], A)).toThrow(mode.startsWith("future") ? "source-lineage-plan-time-refused" : "source-lineage-plan-refused");
});
it("refuses oversized histories before allocating a lineage graph", async () => {
  const first = event("A", await planAt());
  expect(() => planSourceBindingTransition(first.plan, Array(8193).fill(first), A)).toThrow("source-lineage-bounds-refused");
});
it("rejects canonical revision reuse across raw source profiles", async () => {
  const first = event("A", await planAt()); const second = event("B", await planAt(B));
  second.plan.binding.sourceProfileId = "other-profile"; second.plan.binding.sourceRequest.profileId = "other-profile"; resign(second.plan);
  second.revision!.id = first.revision!.id;
  expect(() => sourceBindingHeadsAt([first, second], B)).toThrow("source-lineage-revision-refused");
});
it.each(["raw-player", "raw-team", "week", "profile"])("refuses malformed stable raw identities (%s)", async (mode) => {
  const { binding } = await planAt(); const request = { ...binding.sourceRequest };
  if (mode === "raw-player") request.rawPlayerId = "made-up";
  if (mode === "raw-team") request.rawTeam = "LA";
  if (mode === "week") request.rawGameId = "2026_00_CAR_PHI";
  if (mode === "profile") request.profileId = "profile|alias";
  expect(() => sourceStatsRawKey(request)).toThrow(mode === "raw-player" ? "invalid-player-identity" : "source-lineage-identity-refused");
});
