import { expect, it } from "vitest";
import { sourceFactHeadsAt, sourceFactSnapshot, type SourceFactSnapshot } from "../../src/lib/predictive/sourceFacts.ts";
import { SOURCE_LINEAGE_VERSION, sourceStatsRawKey, type SourceBindingEvent } from "../../src/lib/predictive/sourceLineage.ts";
import { planSourceStatsNormalization, type SourceNormalizationPlan } from "../../src/lib/predictive/sourceNormalization.ts";
import { checkSourceWitness, sourceFactWitness, sourcePostWindowCapture, sourceReconciliationEvidence, sourceUsageEvidence } from "../../src/lib/predictive/sourceWitness.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "./fixtures/sourceNormalization.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
import { sourceDecisionBasis, sourceDecisionPlan, sourceDecisionRequest } from "../../src/lib/predictive/sourceDecisions.ts";
import { addCapture, profile, revision, rights } from "./fixtures/passingYards.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import type { Dataset } from "../../src/lib/predictive/types.ts";

const A = "2026-10-10T12:00:00.000Z";
const B = "2026-10-10T13:00:00.000Z";
const C = "2026-10-10T14:00:00.000Z";
const key = (player = "00-0000001") => "player-game-stats:" + NORMALIZATION_GAME + ":" + player;
const hashPlan = (plan: SourceNormalizationPlan) => {
  plan.planDigest = digest(canonical({ reason: plan.reason, candidate: plan.candidate, binding: plan.binding })); return plan;
};
const planAt = async (cutoff = A, change: { capturedAt?: string; captureId?: string; player?: string; rawPlayer?: string;
  missing?: boolean; profileId?: string; values?: Record<string, string> } = {}) => {
  const rawPlayer = change.rawPlayer ?? "00-0000001";
  const fixture = await normalizationFixture("player", sourceCsv("player", [{ ...sourceSamples().player[0], player_id: rawPlayer, ...change.values }]));
  const { source, context, bridgeRows } = fixture;
  if (change.profileId) {
    const prior = source.evidence.request.profileId;
    source.evidence.request.profileId = change.profileId;
    context.profiles.find((profile) => profile.id === prior)!.id = change.profileId;
    context.rightsDecisions.find((decision) => decision.profileId === prior)!.profileId = change.profileId;
    for (const link of context.identityLinks) if (link.statsProfileId === prior) link.statsProfileId = change.profileId;
  }
  source.evidence.request.cutoff = cutoff; source.evidence.request.rawPlayerId = rawPlayer;
  const capture = source.evidence.captures[0]; capture.ingestedAt = cutoff;
  if (change.captureId) {
    capture.id = change.captureId;
    for (const row of source.evidence.rows) row.id = "source-row:" + digest(canonical([capture.id, row.rowOrdinal]));
  }
  if (change.capturedAt) capture.capturedAt = capture.availableAt = change.capturedAt;
  if (change.missing) { source.status = "unavailable-source-claim"; source.reason = "source-row-missing"; source.evidence.rows = []; }
  for (const row of bridgeRows) if (row.kind === "player-bridge") {
    row.data.rawPlayerId = rawPlayer; row.data.playerId = change.player ?? rawPlayer;
  }
  rewriteNormalizationRows(context, bridgeRows); source.inputDigest = digest(canonical(source.evidence));
  return planSourceStatsNormalization(source, context, "2026-10-11T12:00:00.000Z");
};
// Deliberately hand-authored IDs, predecessors and reused revisions; neither
// the witness builder nor transition planner supplies the expected references.
const event = (id: string, plan: SourceNormalizationPlan, predecessorId: string | null = null): SourceBindingEvent => ({
  version: SOURCE_LINEAGE_VERSION, id, predecessorId, recordedAt: plan.binding.cutoff, plan,
  revision: plan.candidate ? { id: "revision-" + id, sourceRecordId: sourceStatsRawKey(plan.binding.sourceRequest),
    predecessorId: null, correctionReason: null, ...structuredClone(plan.candidate) } : null,
});
const queryAt = (plan: SourceNormalizationPlan, cutoff: string) => {
  const copy = structuredClone(plan); copy.binding.cutoff = copy.binding.sourceRequest.cutoff = cutoff; return hashPlan(copy);
};
const facts = (events: SourceBindingEvent[], plans: SourceNormalizationPlan[], cutoff = A, entityKeys = [key()]) =>
  sourceFactHeadsAt(events, plans, { profileIds: [...new Set(plans.map((plan) => plan.binding.sourceProfileId))], entityKeys, cutoff });
const postRequest = (snapshot: SourceFactSnapshot, eligibleAt = A) => ({ entityKey: key(),
  bindingId: snapshot.heads[0].head.id, captureId: snapshot.heads[0].head.plan.binding.sourceCaptures[0].id, eligibleAt });

const decisionRequest = (snapshot: SourceFactSnapshot, kind: "reconciliation" | "participation" = "reconciliation") => ({
  kind, profileIds: snapshot.request.profileIds, entityKey: key(), cutoff: snapshot.request.cutoff,
});
const nativeInactive = (id = "inactive") => {
  const dataset: Dataset = { formatVersion: 2, profiles: [profile("native-participation")], rightsDecisions: [rights("native-participation")],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  const fact = "participation-evidence:" + NORMALIZATION_GAME + ":00-0000001:official-inactive-list";
  addCapture(dataset, id, [revision(id, "participation-evidence", { gameId: NORMALIZATION_GAME, playerId: "00-0000001",
    rawPlayerId: "00-0000001", playerIdProvider: "gsis", teamId: "nfl:team:PHI", evidenceKind: "official-inactive-list", claim: "inactive-or-dnp" })],
  "2026-10-09T12:00:00.000Z", "native-participation");
  return createReplay(dataset, A, A, "internal-research").heads(fact);
};

it("source decision plans retain exact selection provenance and query time alone does not stale them", async () => {
  const a = event("decision-A", await planAt()); const snapshot = facts([a], [a.plan]);
  const plan = sourceDecisionPlan(snapshot, decisionRequest(snapshot), [], "synthetic-proof");
  expect(plan).toMatchObject({ state: "evaluated", outcome: { result: "selected", selectedObservationId: "revision-decision-A" },
    selected: { bindingId: "decision-A", revisionId: "revision-decision-A" }, nativeInputs: [] });
  const later = facts([a], [queryAt(a.plan, B)], B);
  expect(sourceDecisionBasis(sourceDecisionPlan(later, decisionRequest(later), [], "synthetic-proof"))).toBe(sourceDecisionBasis(plan));
  expect(sourceDecisionPlan(later, decisionRequest(later), [], "synthetic-proof").planDigest).not.toBe(plan.planDigest);
});

it("source participation plans combine explicit evidence with positive usage without turning zero into absence", async () => {
  const positive = event("decision-positive", await planAt()); const snapshot = facts([positive], [positive.plan]);
  expect(sourceDecisionPlan(snapshot, decisionRequest(snapshot, "participation"), [], "synthetic-proof").outcome).toEqual({ state: "offensive-participant" });
  const native = nativeInactive();
  expect(sourceDecisionPlan(snapshot, decisionRequest(snapshot, "participation"), native, "synthetic-proof").outcome).toEqual({ state: "conflicting" });
  const zero = event("decision-zero", await planAt(A, { values: { attempts: "0", carries: "0", targets: "0" } }));
  const zeroFacts = facts([zero], [zero.plan]);
  expect(sourceDecisionPlan(zeroFacts, decisionRequest(zeroFacts, "participation"), [], "synthetic-proof").outcome).toEqual({ state: "unresolved" });
  expect(sourceDecisionPlan(zeroFacts, decisionRequest(zeroFacts, "participation"), native, "synthetic-proof").outcome).toEqual({ state: "inactive-or-dnp" });
});

it("source decisions preserve withheld evidence and native provenance changes invalidate freshness", async () => {
  const a = event("decision-withheld", await planAt(A, { missing: true })); const snapshot = facts([a], [a.plan]);
  for (const kind of ["reconciliation", "participation"] as const)
    expect(sourceDecisionPlan(snapshot, decisionRequest(snapshot, kind), kind === "participation" ? nativeInactive() : [], "synthetic-proof"))
      .toMatchObject({ state: "withheld", outcome: null, selected: null });
  const empty = sourceFactSnapshot(snapshot.request, [], []);
  expect(sourceDecisionPlan(empty, decisionRequest(empty), [], "synthetic-proof").outcome).toMatchObject({ result: "insufficient-sources" });
  const original = sourceDecisionPlan(empty, decisionRequest(empty, "participation"), nativeInactive("original"), "synthetic-proof");
  const changed = sourceDecisionPlan(empty, decisionRequest(empty, "participation"), nativeInactive("recaptured"), "synthetic-proof");
  expect(changed.outcome).toEqual(original.outcome);
  expect(sourceDecisionBasis(changed)).not.toBe(sourceDecisionBasis(original));
});

it("source decision plans refuse future native evidence, duplicate inputs and widened statistics scope", async () => {
  const a = event("decision-scope", await planAt()); const snapshot = facts([a], [a.plan]); const native = nativeInactive();
  const future = structuredClone(native); future[0].capture.ingestedAt = B;
  for (const inputs of [future, [...native, ...native]])
    expect(() => sourceDecisionPlan(snapshot, decisionRequest(snapshot, "participation"), inputs, "synthetic-proof")).toThrow("source-decision-native-scope-refused");
  expect(() => sourceDecisionPlan(snapshot, decisionRequest(snapshot), native, "synthetic-proof")).toThrow("source-decision-native-scope-refused");
  expect(() => sourceDecisionRequest({ ...decisionRequest(snapshot, "participation"), entityKey: "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI" }))
    .toThrow("source-decision-request-refused");
  expect(() => sourceDecisionPlan(snapshot, { ...decisionRequest(snapshot), profileIds: ["unrequested"] }, [], "synthetic-proof")).toThrow("source-decision-scope-refused");
});

it("consumer witnesses pin exact binding and revision references without retaining numeric payloads or query-time freshness", async () => {
  const a = event("A", await planAt()); const snapshot = facts([a], [a.plan]); const witness = sourceFactWitness(snapshot);
  expect(witness.heads).toEqual([{ profileId: "csv-synthetic-player", lineageKey: snapshot.heads[0].lineageKey,
    entityKey: key(), bindingId: "A", revisionId: "revision-A", headToken: snapshot.heads[0].headToken }]);
  expect(witness).toMatchObject({ cutoff: A, missingEntityKeys: [], withheld: [], coverage: "recorded-lineages-only" });
  expect(JSON.stringify(witness)).not.toContain("passingYards");
  const later = facts([a], [queryAt(a.plan, B)], B);
  expect(later.inputDigest).not.toBe(snapshot.inputDigest);
  expect(checkSourceWitness(witness, later)).toMatchObject({ state: "unchanged", current: { cutoff: B, evidenceDigest: witness.evidenceDigest } });
  // Build the missing snapshot through the public constructor, not a forged digest.
  const missing = sourceFactSnapshot(snapshot.request, [], []);
  expect(sourceFactWitness(missing).missingEntityKeys).toEqual([key()]);
  expect(checkSourceWitness(sourceFactWitness(missing), missing).state).toBe("unchanged");
  expect(sourceReconciliationEvidence(missing, key())).toMatchObject({ selected: null, outcome: { result: "insufficient-sources" } });
});

it("an unchanged recapture invalidates consumer witnesses even when its statistical revision ID is reused", async () => {
  const a = event("A", await planAt()); const b = event("B", await planAt(B, { captureId: "recapture-B", capturedAt: B }), "A");
  b.revision = structuredClone(a.revision);
  const before = facts([a, b], [a.plan]); const after = facts([a, b], [b.plan], B);
  expect(after.heads[0].head.revision!.id).toBe("revision-A");
  expect(after.heads[0].revisionKnownAt).toBe(A);
  expect(checkSourceWitness(sourceFactWitness(before), after).state).toBe("changed");
  expect(sourceFactWitness(after).heads[0]).toMatchObject({ bindingId: "B", revisionId: "revision-A" });
  expect(facts([b, a], [a.plan])).toEqual(before);
});

it("canonical rerouting removes the old consumer contribution and unrecorded routing withholds both destinations", async () => {
  const a = event("A", await planAt()); const routed = await planAt(B, { player: "00-0000002" });
  const b = event("B", routed, "A"); const scope = [key(), key("00-0000002")];
  const before = sourceFactWitness(facts([a], [a.plan], A, scope));
  const after = facts([a, b], [b.plan], B, scope);
  expect(checkSourceWitness(before, after).state).toBe("changed");
  expect(sourceFactWitness(after)).toMatchObject({ missingEntityKeys: [key()], heads: [{ entityKey: key("00-0000002"), bindingId: "B" }] });
  const stale = facts([a], [routed], B, scope);
  expect(checkSourceWitness(before, stale)).toMatchObject({ state: "unavailable", reason: "source-evidence-withheld" });
  for (const destination of scope) {
    expect(sourceUsageEvidence(stale, destination).state).toBe("withheld");
    expect(sourceReconciliationEvidence(stale, destination)).toMatchObject({ state: "withheld", selected: null, outcome: null });
  }
});

it("unresolved raw routing cannot be filtered out or rescued by another positive provider", async () => {
  const a = event("A", await planAt()); const missing = event("missing", await planAt(B, { missing: true }), "A");
  const other = event("other", await planAt(B, { profileId: "other-player-profile" }));
  const snapshot = facts([a, missing, other], [missing.plan, other.plan], B, []);
  for (const destination of [key(), key("00-0000002")]) {
    const witness = sourceFactWitness(snapshot, [destination]);
    expect(witness.withheld).toMatchObject([{ bindingId: "missing", routing: "unresolved" }]);
    expect(sourceUsageEvidence(snapshot, destination).state).toBe("withheld");
    expect(sourceReconciliationEvidence(snapshot, destination).outcome).toBeNull();
  }
});

it("every provider binding participates in reconciliation and witness freshness even when providers agree", async () => {
  const a = event("A", await planAt()); const other = event("other", await planAt(A, { profileId: "other-player-profile" }));
  const profiles = [a.plan.binding.sourceProfileId, other.plan.binding.sourceProfileId];
  const before = sourceFactHeadsAt([a], [a.plan], { profileIds: profiles, entityKeys: [key()], cutoff: A });
  const together = facts([other, a], [other.plan, a.plan]); const preview = sourceReconciliationEvidence(together, key());
  expect(preview).toMatchObject({ outcome: { result: "selected", rule: "sources-agree", selectedObservationId: "revision-A" },
    selected: { bindingId: "A", revisionId: "revision-A" } });
  expect(preview.witness.heads.map((head) => head.bindingId).sort()).toEqual(["A", "other"]);
  expect(checkSourceWitness(sourceFactWitness(before), together).state).toBe("changed");
  expect(sourceUsageEvidence(together, key()).state).toBe("positive-usage");
  const conflict = event("conflict", await planAt(A, { profileId: "other-player-profile", values: { passing_yards: "95" } }));
  const disputed = facts([a, conflict], [a.plan, conflict.plan]);
  expect(sourceReconciliationEvidence(disputed, key())).toMatchObject({ selected: null,
    outcome: { result: "conflict", rule: "material-discrepancy" } });
  // Yardage disagreement does not negate agreed evidence of positive usage.
  expect(sourceUsageEvidence(disputed, key()).state).toBe("positive-usage");
});

it("unrelated known destinations do not change a scoped witness but unresolved routing does", async () => {
  const a = event("A", await planAt()); const other = event("unrelated", await planAt(A, { rawPlayer: "00-0000002" }));
  const baseline = facts([a], [a.plan], A, []);
  const both = facts([other, a], [a.plan, other.plan], A, []);
  expect(sourceFactWitness(both, [key()])).toEqual(sourceFactWitness(baseline, [key()]));
  expect(sourceFactWitness(facts([a, other], [other.plan, a.plan], A, []), [key()]))
    .toEqual(sourceFactWitness(both, [key()]));
  const missing = event("unrelated-missing", await planAt(B, { rawPlayer: "00-0000002", missing: true }), "unrelated");
  const current = facts([a, other, missing], [queryAt(a.plan, B), missing.plan], B, []);
  expect(checkSourceWitness(sourceFactWitness(baseline, [key()]), current).state).toBe("unavailable");
});

it.each(["zero", "blank", "missing", "carry", "target"])("usage contribution keeps %s distinct from inferred absence or numeric zero", async (variant) => {
  const values: Record<string, string> = { attempts: "0", completions: "0", passing_yards: "0", passing_tds: "0",
    passing_interceptions: "0", carries: "0", rushing_yards: "0", targets: "0", receptions: "0", receiving_yards: "0" };
  if (variant === "blank") for (const field of Object.keys(values)) values[field] = "";
  if (variant === "carry") values.carries = "1";
  if (variant === "target") values.targets = "1";
  const a = event("A", await planAt(A, { values, missing: variant === "missing" }));
  const preview = sourceUsageEvidence(facts([a], [a.plan]), key());
  expect(preview.state).toBe(variant === "missing" ? "withheld" : ["carry", "target"].includes(variant) ? "positive-usage" : "not-established");
  expect(preview.populationCoverage).toBe("unqualified");
  expect(preview).not.toHaveProperty("participationDecision");
});

it("one positive provider cannot establish usage when another current provider reports zero usage", async () => {
  const a = event("A", await planAt());
  const rival = event("zero-rival", await planAt(A, { profileId: "other-player-profile", values: {
    attempts: "0", completions: "0", passing_yards: "0", passing_tds: "0", passing_interceptions: "0",
    carries: "0", rushing_yards: "0", targets: "0", receptions: "0", receiving_yards: "0",
  } }));
  const snapshot = facts([a, rival], [rival.plan, a.plan]);
  expect(sourceUsageEvidence(snapshot, key())).toMatchObject({ state: "not-established", witness: { heads: [{}, {}] } });
  expect(sourceReconciliationEvidence(snapshot, key())).toMatchObject({ selected: null, outcome: { result: "conflict" } });
});

it("post-window capture accepts the exact boundary and refuses pre-window capture despite late ingestion", async () => {
  const a = event("A", await planAt(A, { capturedAt: A })); const snapshot = facts([a], [a.plan]);
  const request = postRequest(snapshot); const witness = sourceFactWitness(snapshot);
  expect(sourcePostWindowCapture(snapshot, witness, request)).toMatchObject({ state: "confirmed-source-capture", reason: null,
    head: { bindingId: "A", revisionId: "revision-A" }, captureId: request.captureId, labelsFinalized: false });
  const late = event("late", await planAt(B, { capturedAt: "2026-10-10T11:59:59.999Z" }));
  const imported = facts([late], [late.plan], B);
  expect(sourcePostWindowCapture(imported, sourceFactWitness(imported), postRequest(imported)))
    .toMatchObject({ state: "unavailable-source-capture", reason: "source-capture-before-final-window", head: null, captureId: null });
});

it("post-window reconfirmation follows the new binding's capture rather than the reused revision's original capture", async () => {
  const a = event("A", await planAt()); const b = event("B", await planAt(B, { capturedAt: B, captureId: "post-window-B" }), "A");
  b.revision = structuredClone(a.revision);
  const before = facts([a], [a.plan]); const after = facts([a, b], [b.plan], B);
  expect(sourcePostWindowCapture(after, sourceFactWitness(before), postRequest(after))).toMatchObject({ reason: "source-witness-changed" });
  const witness = sourceFactWitness(after); const request = postRequest(after);
  expect(sourcePostWindowCapture(after, witness, request)).toMatchObject({ state: "confirmed-source-capture",
    captureId: "post-window-B", head: { bindingId: "B", revisionId: "revision-A" } });
  expect(sourcePostWindowCapture(after, witness, { ...request, captureId: before.heads[0].head.plan.binding.sourceCaptures[0].id }))
    .toMatchObject({ reason: "source-capture-selection-mismatch" });
  expect(sourcePostWindowCapture(after, witness, { ...request, bindingId: "A" })).toMatchObject({ reason: "source-binding-selection-mismatch" });
});

it("post-window checks require the exact reconciliation selection and refuse conflicting providers", async () => {
  const a = event("A", await planAt(A, { capturedAt: A }));
  const other = event("other", await planAt(A, { capturedAt: A, profileId: "other-player-profile" }));
  const snapshot = facts([a, other], [other.plan, a.plan]); const witness = sourceFactWitness(snapshot);
  const request = { entityKey: key(), bindingId: "A", captureId: a.plan.binding.sourceCaptures[0].id, eligibleAt: A };
  expect(sourcePostWindowCapture(snapshot, witness, request).state).toBe("confirmed-source-capture");
  expect(sourcePostWindowCapture(snapshot, witness, { ...request, bindingId: "other" }).reason).toBe("source-binding-selection-mismatch");
  const rival = event("rival", await planAt(A, { profileId: "other-player-profile", values: { passing_yards: "95" } }));
  const conflict = facts([a, rival], [a.plan, rival.plan]);
  expect(sourcePostWindowCapture(conflict, sourceFactWitness(conflict), request).reason).toBe("source-selection-conflict");
});

it("rights refusal prevents every witness consumer from reusing formerly selected statistics", async () => {
  const a = event("A", await planAt()); const before = facts([a], [a.plan]); const witness = sourceFactWitness(before);
  const denied = sourceFactSnapshot({ ...before.request, cutoff: B }, [], [], "rights-not-in-force");
  expect(checkSourceWitness(witness, denied)).toMatchObject({ state: "unavailable", reason: "rights-not-in-force", current: { heads: [] } });
  expect(sourceUsageEvidence(denied, key()).state).toBe("withheld");
  expect(sourceReconciliationEvidence(denied, key())).toMatchObject({ state: "withheld", selected: null, outcome: null });
  expect(sourcePostWindowCapture(denied, witness, postRequest(before)).reason).toBe("rights-not-in-force");
});

it("consumer scope, knowledge time and witness integrity cannot be widened or silently ignored", async () => {
  const a = event("A", await planAt()); const snapshot = facts([a], [a.plan]); const witness = sourceFactWitness(snapshot);
  expect(() => sourceFactWitness(snapshot, [])).toThrow("source-witness-scope-refused");
  expect(() => sourceFactWitness(snapshot, [key("00-0000002")])).toThrow("source-witness-scope-refused");
  const future = sourceFactWitness(facts([a], [queryAt(a.plan, C)], C));
  expect(() => checkSourceWitness(future, snapshot)).toThrow("source-witness-cutoff-refused");
  const narrowed = sourceFactSnapshot({ ...snapshot.request, profileIds: ["different-profile"] }, [], []);
  expect(() => checkSourceWitness(witness, narrowed)).toThrow("source-witness-scope-refused");
  const forged = structuredClone(witness); forged.heads[0].bindingId = "wrong";
  expect(() => checkSourceWitness(forged, snapshot)).toThrow("source-witness-record-refused");
  const damaged = structuredClone(snapshot); damaged.heads[0].head.revision!.data.passingYards = 999;
  expect(() => sourceFactWitness(damaged)).toThrow("source-witness-snapshot-refused");
  expect(() => sourceUsageEvidence(snapshot, "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI")).toThrow("source-usage-scope-refused");
  expect(() => sourcePostWindowCapture(snapshot, witness, { ...postRequest(snapshot), entityKey: key("00-0000002") }))
    .toThrow("source-witness-scope-refused");
});
