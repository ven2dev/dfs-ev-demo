import { describe, expect, it } from "vitest";
import { buildPassingYardsBundle } from "../../src/lib/predictive/passingYards.ts";
import { sourceConsumerExecutionDigest, sourceConsumerInputDigest, type SourceConsumerBody, type SourceConsumerRecord } from "../../src/lib/predictive/sourceConsumers.ts";
import { fittingRunRequestDigest, normalizeFittingRunRequest, normalizeTrainingSelection, selectTrainingRows,
  TRAINING_HISTORY_POLICY, TRAINING_HISTORY_SHA256, trainingHistoryDefinition, type FittingRunRequest, type TrainingSlot } from "../../src/lib/predictive/training.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { checkTrainingMetadataSelection } from "../../src/lib/predictive/trainingSql.ts";
import { CUTOFF_A, gameId, passingYardsFixture, PLAYER, PROFILE, request, TARGET } from "./fixtures/passingYards.ts";

const SNAPSHOT = "2026-10-20T00:00:00.000Z";
const slot = (overrides: Partial<TrainingSlot> = {}): TrainingSlot => ({
  datasetId: "evaluation-shard", partition: "evaluation", playerId: PLAYER, gameId: TARGET,
  season: 2026, seasonType: "REG", kickoff: "2026-10-11T17:00:00.000Z", kickoffObservationId: "schedule-synthetic-game-10",
  featureCutoff: CUTOFF_A, labelsAsOf: SNAPSHOT, featureRef: null, labelRef: null, ...overrides,
});
const trainingSlot = (overrides: Partial<TrainingSlot> = {}) => slot({ datasetId: "training-shard", partition: "training",
  gameId: gameId(5), kickoffObservationId: "schedule-synthetic-game-5", kickoff: "2026-10-04T17:00:00.000Z",
  featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: "2026-10-07T00:00:00.000Z", ...overrides });
const runRequest = (slots = [slot()]): FittingRunRequest => ({
  version: "qb-training-read-v1", fittingRunId: "run-1", evaluationPlanId: "plan-1", foldId: "fold-1",
  fitCutoff: "2026-10-08T00:00:00.000Z",
  selection: { market: "player_pass_yds", stat: "passing_yards", candidate: "player-opponent-v1:player_pass_yds",
    featureVersion: "passing-yards-source-v1", labelVersion: "source-final-label-v1", historyPolicy: TRAINING_HISTORY_POLICY,
    historyPolicySha256: TRAINING_HISTORY_SHA256, profileIds: [PROFILE] },
  modelIdentity: { modelVersion: "projection-baseline-v1", codeCommit: "a".repeat(40), configurationSha256: "b".repeat(64) },
  splitPolicy: { version: "target-event-disjoint-v1", evaluationMode: "walk-forward", aggregationPolicyId: "unique-target-events-v1", aggregationPolicySha256: "c".repeat(64) },
  population: { status: "unqualified", enumerationOrigin: "synthetic-explicit-inventory", enumerationSha256: "d".repeat(64) }, slots,
});

// These fixtures exercise selection, not source authorization. Numerical data
// comes from the separately tested passing-yards fixture; SQL/byte verification
// is the database adapter's responsibility before calling selectTrainingRows.
const consumer = (id: string, body: SourceConsumerBody, recordedAt: string, predecessorId: string | null = null): SourceConsumerRecord => {
  body.inputDigest = sourceConsumerInputDigest(body);
  if (body.kind === "feature") body.bundle.inputDigest = body.inputDigest;
  const bodySha256 = digest(canonical(body));
  return { id, kind: body.kind, body, recordedAt, predecessorId, bodySha256, mode: "synthetic-proof", rightsDecisions: [],
    executionDigest: sourceConsumerExecutionDigest(bodySha256, [], recordedAt) };
};
const feature = (id = "feature-A", recordedAt = "2026-10-09T00:00:00.000Z", usable = true) => {
  const bundle = buildPassingYardsBundle(passingYardsFixture(false), request());
  if (!usable) { bundle.status = "unavailable-inputs"; bundle.reasons = ["player-history-incomplete"]; }
  return consumer(id, { kind: "feature", bundle: { ...bundle, featureVersion: "passing-yards-source-v1", usage: "internal-research" },
    manifest: { version: "source-consumer-v1", use: "model-input", cutoff: CUTOFF_A, profileIds: [PROFILE], sources: [], observations: [], decisions: [] }, inputDigest: "" }, recordedAt);
};
const label = (id = "label-A", recordedAt = "2026-10-15T00:00:00.000Z", value = 200, predecessorId: string | null = null) =>
  consumer(id, { kind: "label", version: "source-final-label-v1", playerId: PLAYER, gameId: TARGET, seasonType: "REG",
    stat: "passing_yards", value, completionDecisionId: "completion-target", eligibleFinalAt: "2026-10-14T20:00:00.000Z",
    postWindowCaptureId: "post-window-capture", playerBridgeObservationId: "player-bridge",
    manifest: { version: "source-consumer-v1", use: "outcome-label", cutoff: recordedAt, profileIds: [PROFILE], sources: [], observations: [], decisions: [] }, inputDigest: "" }, recordedAt, predecessorId);

describe("training request history and event separation", () => {
  it("names the existing target-relative three-season coverage and 4/8/16 slot contract", () => {
    expect(trainingHistoryDefinition()).toMatchObject({ scheduleCoverage: { fromTargetSeasonOffset: -2, throughTargetSeasonOffset: 0 },
      numericalHistory: { maximumSlots: 16, windows: [4, 8, 16], seasonType: "match-target" }, absence: "keep-slot-no-numeric-zero" });
    const copy = trainingHistoryDefinition(); Object.assign(copy.numericalHistory.windows, { 0: 8 });
    expect(trainingHistoryDefinition().numericalHistory.windows).toEqual([4, 8, 16]);
    expect(TRAINING_HISTORY_SHA256).toBe(digest(canonical(trainingHistoryDefinition())));
  });
  it.each(["stats-v1:player_pass_yds", "player-opponent-v1:player_pass_yds"] as const)("accepts the exact existing combination for %s", (candidate) => {
    const input = runRequest(); input.selection.candidate = candidate;
    expect(normalizeFittingRunRequest(input, SNAPSHOT).selection.candidate).toBe(candidate);
  });
  it.each([
    ["candidate", "player-opponent-2026-v1:player_pass_yds"], ["featureVersion", "passing-yards-source-2026-v1"],
    ["historyPolicy", "qb-passing-history-2026-v1"], ["historyPolicySha256", "0".repeat(64)],
    ["labelVersion", "source-final-label-v2"], ["market", "player_rush_yds"],
  ])("refuses unknown/withdrawn %s before considering record availability", (key, value) => {
    const input = runRequest(); Object.assign(input.selection, { [key]: value });
    expect(() => selectTrainingRows(input, SNAPSHOT, [])).toThrow("training-version-refused");
  });
  it("normalizes ASCII profile order and detaches the immutable request from the caller", () => {
    const input = runRequest(); input.selection.profileIds = ["z", "A"];
    const normalized = normalizeFittingRunRequest(input, SNAPSHOT);
    expect(normalized.selection.profileIds).toEqual(["A", "z"]);
    input.slots[0].datasetId = "changed"; input.modelIdentity.modelVersion = "changed";
    expect(normalized.slots[0].datasetId).toBe("evaluation-shard");
    expect(normalized.modelIdentity.modelVersion).toBe("projection-baseline-v1");
  });
  it("rejects non-ASCII profile IDs and repeated profiles", () => {
    const selection = runRequest().selection;
    expect(() => normalizeTrainingSelection({ ...selection, profileIds: ["é"] })).toThrow("training-identity-refused");
    expect(() => normalizeTrainingSelection({ ...selection, profileIds: [PROFILE, PROFILE] })).toThrow("training-duplicate-profile");
  });
  it("rejects target-event overlap even with different players, times and shards and no records", () => {
    // Deliberately inconsistent kickoff claims cannot bypass the game-ID check.
    const train = trainingSlot({ gameId: TARGET });
    const evaluation = slot({ playerId: "00-0000002", datasetId: "other-shard" });
    expect(() => selectTrainingRows(runRequest([train, evaluation]), SNAPSHOT, [])).toThrow("training-evaluation-event-overlap");
  });
  it("rejects duplicate player/game targets across shards and prediction cutoffs", () => {
    expect(() => normalizeFittingRunRequest(runRequest([slot(), slot({ datasetId: "other", featureCutoff: "2026-10-09T12:00:00.000Z" })]), SNAPSHOT))
      .toThrow("training-duplicate-target");
  });
  it("allows different players in the same event and partition", () => {
    expect(normalizeFittingRunRequest(runRequest([slot(), slot({ playerId: "00-0000002" })]), SNAPSHOT).slots).toHaveLength(2);
  });
  it("allows an earlier evaluation event as training only in a later distinct fitting run", () => {
    const first = normalizeFittingRunRequest(runRequest(), SNAPSHOT);
    const later = runRequest([slot({ partition: "training", labelsAsOf: "2026-10-15T00:00:00.000Z" })]);
    later.fittingRunId = "run-2"; later.foldId = "fold-2"; later.fitCutoff = "2026-10-19T00:00:00.000Z";
    expect(normalizeFittingRunRequest(later, SNAPSHOT).slots[0].gameId).toBe(first.slots[0].gameId);
    // Durable run-ID reuse refusal and cross-run accounting belong to SQL sealing.
    expect(fittingRunRequestDigest(first, SNAPSHOT)).not.toBe(fittingRunRequestDigest(later, SNAPSHOT));
  });
  it.each([
    ["featureCutoff", "2026-10-11T17:00:00.000Z", "training-feature-not-pregame"],
    ["featureCutoff", "2026-10-07T12:00:00.000Z", "training-evaluation-before-fit"],
    ["labelsAsOf", "2026-10-21T00:00:00.000Z", "training-future-cutoff"],
  ])("rejects invalid %s clock %s", (key, value, reason) => {
    expect(() => normalizeFittingRunRequest(runRequest([slot({ [key]: value })]), SNAPSHOT)).toThrow(reason);
  });
  it("keeps inclusive fit and scoring boundaries, but excludes training labels learned after fitting", () => {
    const input = runRequest([trainingSlot({ labelsAsOf: "2026-10-08T00:00:00.000Z" }), slot({ featureCutoff: "2026-10-08T00:00:00.000Z" })]);
    expect(normalizeFittingRunRequest(input, SNAPSHOT).slots).toHaveLength(2);
    input.slots[0].labelsAsOf = "2026-10-08T00:00:00.001Z";
    expect(() => normalizeFittingRunRequest(input, SNAPSHOT)).toThrow("training-label-after-fit");
  });
  it("rejects oversized shards and does not silently truncate an inventory", () => {
    const input = runRequest(Array.from({ length: 257 }, (_, i) => slot({ playerId: "00-" + String(i).padStart(7, "0") })));
    expect(() => normalizeFittingRunRequest(input, SNAPSHOT)).toThrow("training-dataset-bounds-refused");
  });
  it("makes enumeration order irrelevant, while binding policy/model/fold/clocks to identity", () => {
    const input = runRequest([slot(), trainingSlot()]); const original = fittingRunRequestDigest(input, SNAPSHOT);
    expect(fittingRunRequestDigest({ ...input, slots: [...input.slots].reverse() }, SNAPSHOT)).toBe(original);
    for (const changed of [ { ...input, foldId: "fold-2" }, { ...input, fitCutoff: "2026-10-07T23:59:59.999Z" },
      { ...input, modelIdentity: { ...input.modelIdentity, configurationSha256: "0".repeat(64) } } ]) {
      expect(fittingRunRequestDigest(changed, SNAPSHOT)).not.toBe(original);
    }
  });
});

describe("deterministic training selection over verified records", () => {
  it("refuses missing or repeated metadata ordinals instead of collapsing ambiguous heads", () => {
    const item = { ordinal: 0, featureId: null, labelId: null, labelSupersededAsOf: false, labelSupersededAtSnapshot: false };
    expect(checkTrainingMetadataSelection([item], 1)).toEqual([item]);
    expect(() => checkTrainingMetadataSelection([], 1)).toThrow("training-selection-inventory-mismatch");
    expect(() => checkTrainingMetadataSelection([item, item], 2)).toThrow("training-selection-inventory-mismatch");
    expect(() => checkTrainingMetadataSelection([], 0)).toThrow("training-selection-inventory-mismatch");
  });
  it("retains every requested slot and computes target-relative coverage without fabricating labels", () => {
    const rows = selectTrainingRows(runRequest([slot(), trainingSlot({ season: 2024 })]), SNAPSHOT, []);
    expect(rows.map((row) => [row.ordinal, row.slot.partition, row.feature.state, row.label.state])).toEqual([
      [0, "training", "missing", "missing"], [1, "evaluation", "missing", "missing"],
    ]);
    expect(rows.map((row) => [row.history.fromSeason, row.history.throughSeason])).toEqual([[2022, 2024], [2024, 2026]]);
    expect(rows.every((row) => row.feature.record === null && row.label.record === null)).toBe(true);
  });
  it("selects the latest unavailable feature rather than falling back to a usable predecessor", () => {
    const a = feature(); const b = feature("feature-B", "2026-10-10T00:00:00.000Z", false);
    const row = selectTrainingRows(runRequest(), SNAPSHOT, [a, b])[0];
    expect(row.feature).toMatchObject({ state: "unavailable", reasons: ["player-history-incomplete"], reference: { id: "feature-B" }, record: null });
  });
  it("uses explicit C ordering for equal-time records", () => {
    const row = selectTrainingRows(runRequest(), SNAPSHOT, [feature("z"), feature("Z")])[0];
    expect(row.feature.reference?.id).toBe("z");
    // UTF-16 ordering differs from PostgreSQL C/UTF-8 for these two valid IDs.
    const unicode = selectTrainingRows(runRequest(), SNAPSHOT, [feature("\ue000"), feature("\u{10000}")])[0];
    expect(unicode.feature.reference?.id).toBe("\u{10000}");
    expect(selectTrainingRows(runRequest([slot({ featureRef: "\u{10000}" })]), SNAPSHOT, [feature("\u{10000}")])[0].feature.state).toBe("usable");
  });
  it("binds exact IDs to player, event, cutoff, profile and supported feature version", () => {
    const selected = feature();
    for (const changed of [slot({ playerId: "00-0000002" }), slot({ gameId: gameId(50) }),
      slot({ featureCutoff: "2026-10-09T12:00:00.000Z" })]) {
      expect(() => selectTrainingRows(runRequest([{ ...changed, featureRef: selected.id }]), SNAPSHOT, [selected]))
        .toThrow("training-feature-reference-mismatch");
    }
    expect(selectTrainingRows(runRequest([slot({ featureRef: "missing-exact-id" })]), SNAPSHOT, [selected])[0].feature.state).toBe("missing");
  });
  it("never selects a record published after the common snapshot", () => {
    const later = feature("later", "2026-10-21T00:00:00.000Z");
    expect(selectTrainingRows(runRequest(), SNAPSHOT, [later])[0].feature.state).toBe("missing");
  });
  it("keeps labels separate and preserves an affirmative zero outcome", () => {
    const row = selectTrainingRows(runRequest(), SNAPSHOT, [feature(), label("zero", undefined, 0)])[0];
    expect(row.feature.state).toBe("usable"); expect(row.label.state).toBe("usable");
    expect(row.label.record?.body).toMatchObject({ kind: "label", value: 0 });
    expect(row.feature.record?.body).not.toHaveProperty("value");
  });
  it("does not expose a future correction value at an earlier label clock", () => {
    const a = label(); const b = label("label-B", "2026-10-19T00:00:00.000Z", 250, a.id);
    const rows = selectTrainingRows(runRequest([slot({ labelsAsOf: "2026-10-16T00:00:00.000Z" })]), SNAPSHOT, [a, b]);
    expect(rows[0].label).toMatchObject({ reference: { id: a.id }, supersededAsOf: false, supersededNow: true });
    expect(rows[0].label.record?.body).toMatchObject({ value: 200 });
    expect(canonical(rows)).not.toContain('"value":250');
  });
  it("supports an exact older label with explicit as-of and current supersession", () => {
    const a = label(); const b = label("label-B", "2026-10-19T00:00:00.000Z", 250, a.id);
    const row = selectTrainingRows(runRequest([slot({ labelRef: a.id })]), SNAPSHOT, [a, b])[0];
    expect(row.label).toMatchObject({ reference: { id: a.id }, supersededAsOf: true, supersededNow: true });
  });
  it("does not revive an earlier label if the current head uses another profile", () => {
    const a = label(); const b = label("label-B", "2026-10-19T00:00:00.000Z", 250, a.id);
    b.body.manifest.profileIds = ["other-profile"];
    const row = selectTrainingRows(runRequest(), SNAPSHOT, [a, b])[0];
    expect(row.label).toMatchObject({ state: "missing", reason: "label-profile-mismatch", reference: null, record: null });
  });
  it("rejects ambiguous label heads instead of choosing by value or record time", () => {
    expect(() => selectTrainingRows(runRequest(), SNAPSHOT, [label(), label("rival")])).toThrow("training-label-lineage-ambiguous");
  });
  it("expires at exactly day 90 and permits only an already active valid pin to preserve eligibility", () => {
    const record = feature(); const expiry = "2027-01-07T00:00:00.000Z";
    expect(selectTrainingRows(runRequest(), "2027-01-06T23:59:59.999Z", [record])[0].feature.state).toBe("usable");
    expect(selectTrainingRows(runRequest(), expiry, [record])[0].feature).toMatchObject({ state: "expired", record: null });
    expect(selectTrainingRows(runRequest(), expiry, [record], new Set([record.id]))[0].feature.state).toBe("usable");
    // SQL will supply this set only after current rights/deletion/pin validation.
  });
});
