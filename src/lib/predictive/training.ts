import type { Candidate, SeasonType } from "./types.ts";
import type { SourceConsumerRecord } from "./sourceConsumers.ts";
import { canonical, compareText, digest, exact, gameIdentity, instant, playerIdentity, refuse } from "./validation.ts";

export const TRAINING_READ_VERSION = "qb-training-read-v1";
export const TRAINING_HISTORY_POLICY = "qb-passing-history-three-season-v1";
export const TRAINING_BOUNDS = {
  slotsPerDataset: 256, slotsPerRun: 1024, profiles: 16, datasets: 32, pageRows: 64,
  pageBytes: 8_000_000, verifiedBytes: 20_000_000, dependencyLinks: 65_536, consumers: 8192,
} as const;
// This describes the frozen producer, not a new numerical policy. Keep the
// definition private so callers cannot mutate it after its digest is computed.
const historyDefinition = {
  id: TRAINING_HISTORY_POLICY,
  scheduleCoverage: { fromTargetSeasonOffset: -2, throughTargetSeasonOffset: 0, evidence: "independent-expected-games" },
  numericalHistory: { maximumSlots: 16, windows: [4, 8, 16], seasonType: "match-target", ordering: "kickoff-descending",
    eligible: "completed-strictly-before-feature-cutoff", targetExcluded: true, shortHistory: "quality-flag" },
  absence: "keep-slot-no-numeric-zero", unknown: "withhold-not-shift-window",
  opponent: "offenses-facing-opponent", rest: "prior-team-schedule-crosses-season-type",
  completionPolicy: "event-completion-v1", participationPolicy: "participation-v1",
  producerBaseline: "716d7559f6b3d402b098810efa5e6646f99e6709",
} as const;
export const TRAINING_HISTORY_SHA256 = digest(canonical(historyDefinition));
export const trainingHistoryDefinition = () => structuredClone(historyDefinition);

export type TrainingSelection = {
  market: "player_pass_yds"; stat: "passing_yards"; candidate: Candidate;
  featureVersion: "passing-yards-source-v1"; labelVersion: "source-final-label-v1";
  historyPolicy: typeof TRAINING_HISTORY_POLICY; historyPolicySha256: string; profileIds: string[];
};
export type TrainingSlot = {
  datasetId: string; partition: "training" | "evaluation"; playerId: string; gameId: string;
  season: number; seasonType: SeasonType; kickoff: string; kickoffObservationId: string;
  featureCutoff: string; labelsAsOf: string; featureRef: string | null; labelRef: string | null;
};
export type FittingRunRequest = {
  version: typeof TRAINING_READ_VERSION; fittingRunId: string; evaluationPlanId: string; foldId: string; fitCutoff: string;
  selection: TrainingSelection;
  modelIdentity: { modelVersion: string; codeCommit: string; configurationSha256: string };
  splitPolicy: { version: "target-event-disjoint-v1"; evaluationMode: "fixed-holdout" | "walk-forward";
    aggregationPolicyId: string; aggregationPolicySha256: string };
  population: { status: "unqualified"; enumerationOrigin: string; enumerationSha256: string };
  slots: TrainingSlot[];
};
export type ConsumerReference = Pick<SourceConsumerRecord, "id" | "bodySha256" | "executionDigest" | "recordedAt" | "predecessorId"> & {
  inputDigest: string;
};
export type TrainingFeatureSelection = {
  state: "missing" | "expired" | "unavailable" | "usable"; reason: string | null; reference: ConsumerReference | null;
  reasons: string[]; quality: string[];
  // Only an authorized, byte-verified usable component can expose its body.
  record: SourceConsumerRecord | null;
};
export type TrainingLabelSelection = {
  state: "missing" | "usable"; reason: string | null; reference: ConsumerReference | null;
  supersededAsOf: boolean; supersededNow: boolean; record: SourceConsumerRecord | null;
};
export type TrainingSelectedRow = {
  ordinal: number; slot: TrainingSlot;
  history: { policy: typeof TRAINING_HISTORY_POLICY; definitionSha256: string; fromSeason: number; throughSeason: number; windows: number[]; maximumSlots: 16 };
  feature: TrainingFeatureSelection; label: TrainingLabelSelection;
};

const identity = (value: unknown) => {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value) || value.includes("|")) refuse("training-identity-refused");
};
const sha256 = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("training-digest-refused");
};
const evidenceIdentity = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f|]/.test(value)) refuse("training-identity-refused");
};
const optionalIdentity = (value: unknown) => { if (value !== null) evidenceIdentity(value); };
const compareSlots = (a: TrainingSlot, b: TrainingSlot) =>
  // Explicit partition order; locale/string ordering would put evaluation first.
  (a.partition === b.partition ? 0 : a.partition === "training" ? -1 : 1) ||
  compareText(a.featureCutoff, b.featureCutoff) || compareText(a.playerId, b.playerId) || compareText(a.gameId, b.gameId);

export const normalizeTrainingSelection = (input: TrainingSelection): TrainingSelection => {
  exact(input, ["market", "stat", "candidate", "featureVersion", "labelVersion", "historyPolicy", "historyPolicySha256", "profileIds"]);
  if (input.market !== "player_pass_yds" || input.stat !== "passing_yards" || input.featureVersion !== "passing-yards-source-v1" ||
      input.labelVersion !== "source-final-label-v1" || input.historyPolicy !== TRAINING_HISTORY_POLICY ||
      input.historyPolicySha256 !== TRAINING_HISTORY_SHA256 ||
      !["stats-v1:player_pass_yds", "player-opponent-v1:player_pass_yds"].includes(input.candidate)) refuse("training-version-refused");
  if (!Array.isArray(input.profileIds) || !input.profileIds.length || input.profileIds.length > TRAINING_BOUNDS.profiles) refuse("training-profile-bounds-refused");
  input.profileIds.forEach(identity);
  if (new Set(input.profileIds).size !== input.profileIds.length) refuse("training-duplicate-profile");
  return { ...input, profileIds: [...input.profileIds].sort(compareText) };
};

// Structural validation only. The database must independently enforce these
// rules and verify kickoff observations before sealing a run. This does not
// authorize access, qualify population or create a manifest/pin.
export const normalizeFittingRunRequest = (input: FittingRunRequest, snapshotAt: string): FittingRunRequest => {
  exact(input, ["version", "fittingRunId", "evaluationPlanId", "foldId", "fitCutoff", "selection", "modelIdentity", "splitPolicy", "population", "slots"]);
  if (input.version !== TRAINING_READ_VERSION) refuse("training-version-refused");
  [input.fittingRunId, input.evaluationPlanId, input.foldId].forEach(identity);
  const snapshot = instant(snapshotAt), fit = instant(input.fitCutoff);
  if (fit > snapshot) refuse("training-future-cutoff");
  const selection = normalizeTrainingSelection(input.selection);
  exact(input.modelIdentity, ["modelVersion", "codeCommit", "configurationSha256"]);
  identity(input.modelIdentity.modelVersion); sha256(input.modelIdentity.configurationSha256);
  if (typeof input.modelIdentity.codeCommit !== "string" || !/^[a-f0-9]{40}$/.test(input.modelIdentity.codeCommit)) refuse("training-code-identity-refused");
  exact(input.splitPolicy, ["version", "evaluationMode", "aggregationPolicyId", "aggregationPolicySha256"]);
  if (input.splitPolicy.version !== "target-event-disjoint-v1" || !["fixed-holdout", "walk-forward"].includes(input.splitPolicy.evaluationMode)) refuse("training-split-policy-refused");
  identity(input.splitPolicy.aggregationPolicyId); sha256(input.splitPolicy.aggregationPolicySha256);
  exact(input.population, ["status", "enumerationOrigin", "enumerationSha256"]);
  if (input.population.status !== "unqualified") refuse("training-population-unqualified");
  identity(input.population.enumerationOrigin); sha256(input.population.enumerationSha256);
  if (!Array.isArray(input.slots) || !input.slots.length || input.slots.length > TRAINING_BOUNDS.slotsPerRun) refuse("training-slot-bounds-refused");
  const events = new Map<string, TrainingSlot["partition"]>();
  const targets = new Set<string>(); const datasets = new Map<string, number>();
  for (const slot of input.slots) {
    exact(slot, ["datasetId", "partition", "playerId", "gameId", "season", "seasonType", "kickoff", "kickoffObservationId", "featureCutoff", "labelsAsOf", "featureRef", "labelRef"]);
    identity(slot.datasetId); evidenceIdentity(slot.kickoffObservationId); playerIdentity(slot.playerId); gameIdentity(slot.gameId);
    optionalIdentity(slot.featureRef); optionalIdentity(slot.labelRef);
    if (!["training", "evaluation"].includes(slot.partition) || !["REG", "POST"].includes(slot.seasonType) ||
        !Number.isInteger(slot.season) || slot.season < 1999 || slot.season > 2100) refuse("training-slot-refused");
    const feature = instant(slot.featureCutoff), label = instant(slot.labelsAsOf), kickoff = instant(slot.kickoff);
    if (feature > snapshot || label > snapshot) refuse("training-future-cutoff");
    if (feature >= kickoff) refuse("training-feature-not-pregame");
    if (slot.partition === "training" && (label > fit || kickoff >= fit)) refuse("training-label-after-fit");
    if (slot.partition === "evaluation" && feature < fit) refuse("training-evaluation-before-fit");
    const prior = events.get(slot.gameId);
    if (prior && prior !== slot.partition) refuse("training-evaluation-event-overlap");
    events.set(slot.gameId, slot.partition);
    const target = slot.partition + "|" + slot.playerId + "|" + slot.gameId;
    if (targets.has(target)) refuse("training-duplicate-target");
    targets.add(target);
    datasets.set(slot.datasetId, (datasets.get(slot.datasetId) ?? 0) + 1);
    if (datasets.get(slot.datasetId)! > TRAINING_BOUNDS.slotsPerDataset || datasets.size > TRAINING_BOUNDS.datasets) refuse("training-dataset-bounds-refused");
  }
  return { ...structuredClone(input), selection, slots: structuredClone(input.slots).sort(compareSlots) };
};

export const fittingRunRequestDigest = (request: FittingRunRequest, snapshotAt: string) =>
  digest(canonical(normalizeFittingRunRequest(request, snapshotAt)));

const reference = (record: SourceConsumerRecord): ConsumerReference => ({ id: record.id, bodySha256: record.bodySha256,
  executionDigest: record.executionDigest, recordedAt: record.recordedAt, predecessorId: record.predecessorId, inputDigest: record.body.inputDigest });
const byRecorded = (a: SourceConsumerRecord, b: SourceConsumerRecord) =>
  compareText(a.recordedAt, b.recordedAt) || Buffer.compare(Buffer.from(a.id, "utf8"), Buffer.from(b.id, "utf8"));
const profilesEqual = (a: string[], b: string[]) => canonical(a) === canonical(b);
const featureMatches = (record: SourceConsumerRecord, slot: TrainingSlot, selection: TrainingSelection) => {
  const body = record.body;
  return record.kind === "feature" && body.kind === "feature" && body.bundle.request.playerId === slot.playerId &&
    body.bundle.request.gameId === slot.gameId && body.bundle.request.cutoff === slot.featureCutoff &&
    body.bundle.request.candidate === selection.candidate && body.bundle.featureVersion === selection.featureVersion &&
    profilesEqual(body.manifest.profileIds, selection.profileIds);
};
const labelMatches = (record: SourceConsumerRecord, slot: TrainingSlot, selection: TrainingSelection) => {
  const body = record.body;
  return record.kind === "label" && body.kind === "label" && body.playerId === slot.playerId && body.gameId === slot.gameId &&
    body.seasonType === slot.seasonType && body.stat === selection.stat && body.version === selection.labelVersion &&
    profilesEqual(body.manifest.profileIds, selection.profileIds);
};

// Operates on a bounded, complete inventory of authorized, byte-verified source
// records from one snapshot. It is deliberately not a public reader: no rights,
// SQL completeness, deletion guard or pin can be established by this function.
// Future label records are used only to disclose current supersession, never to
// return a later value at an earlier label clock.
export const selectTrainingRows = (request: FittingRunRequest, snapshotAt: string, records: SourceConsumerRecord[],
  activePinnedFeatureIds: ReadonlySet<string> = new Set()): TrainingSelectedRow[] => {
  const run = normalizeFittingRunRequest(request, snapshotAt); const snapshot = instant(snapshotAt);
  if (records.length > TRAINING_BOUNDS.consumers) refuse("training-consumer-bounds-refused");
  const inventory = new Map<string, SourceConsumerRecord>();
  const featuresByRequest = new Map<string, SourceConsumerRecord[]>();
  const labelsByTarget = new Map<string, SourceConsumerRecord[]>();
  const currentSuccessors = new Set<string>();
  const featureKey = (player: string, game: string, cutoff: string) => canonical([player, game, cutoff]);
  const labelKey = (player: string, game: string) => canonical([player, game]);
  for (const record of records) {
    if (inventory.has(record.id)) refuse("training-duplicate-consumer");
    instant(record.recordedAt); inventory.set(record.id, record);
    if (instant(record.recordedAt) > snapshot) continue;
    if (record.kind !== record.body.kind) refuse("training-consumer-kind-mismatch");
    if (record.body.kind === "feature") {
      const req = record.body.bundle.request; const key = featureKey(req.playerId, req.gameId, req.cutoff);
      const group = featuresByRequest.get(key) ?? []; group.push(record); featuresByRequest.set(key, group);
    } else {
      const key = labelKey(record.body.playerId, record.body.gameId);
      const group = labelsByTarget.get(key) ?? []; group.push(record); labelsByTarget.set(key, group);
      if (record.predecessorId) currentSuccessors.add(record.predecessorId);
    }
  }
  for (const group of featuresByRequest.values()) group.sort(byRecorded);
  return run.slots.map((slot, ordinal) => {
    const features = (featuresByRequest.get(featureKey(slot.playerId, slot.gameId, slot.featureCutoff)) ?? [])
      .filter((record) => featureMatches(record, slot, run.selection));
    const feature = slot.featureRef === null ? features.at(-1) ?? null : inventory.get(slot.featureRef) ?? null;
    if (feature && (!featureMatches(feature, slot, run.selection) || instant(feature.recordedAt) > snapshot)) refuse("training-feature-reference-mismatch");
    let featureSelection: TrainingFeatureSelection = { state: "missing", reason: "feature-not-recorded", reasons: [], quality: [], reference: null, record: null };
    if (feature && feature.body.kind === "feature") {
      const target = feature.body.bundle.target;
      if (target && (target.gameId !== slot.gameId || target.season !== slot.season || target.seasonType !== slot.seasonType || target.kickoff !== slot.kickoff)) refuse("training-kickoff-reference-mismatch");
      const expired = !activePinnedFeatureIds.has(feature.id) && snapshot >= instant(feature.recordedAt) + 90 * 86_400_000;
      const usable = feature.body.bundle.status === "ready-inputs";
      featureSelection = { state: expired ? "expired" : usable ? "usable" : "unavailable",
        reason: expired ? "feature-expired" : usable ? null : "feature-inputs-unavailable",
        reasons: [...feature.body.bundle.reasons], quality: [...feature.body.bundle.quality],
        reference: reference(feature), record: !expired && usable ? feature : null };
    }
    // Heads are determined over the entire player/game lineage before profile
    // matching. Otherwise a successor using other profiles revives an ancestor.
    const labels = (labelsByTarget.get(labelKey(slot.playerId, slot.gameId)) ?? [])
      .filter((record) => instant(record.recordedAt) <= instant(slot.labelsAsOf));
    const successors = new Set(labels.flatMap((record) => record.predecessorId ? [record.predecessorId] : []));
    const heads = labels.filter((record) => !successors.has(record.id));
    if (heads.length > 1) refuse("training-label-lineage-ambiguous");
    const label = slot.labelRef === null ? heads[0] ?? null : inventory.get(slot.labelRef) ?? null;
    if (label && (!labelMatches(label, slot, run.selection) || instant(label.recordedAt) > instant(slot.labelsAsOf))) {
      if (slot.labelRef !== null) refuse("training-label-reference-mismatch");
    }
    const selected = label && labelMatches(label, slot, run.selection) ? label : null;
    const currentSuccessor = selected && currentSuccessors.has(selected.id);
    return { ordinal, slot,
      history: { policy: TRAINING_HISTORY_POLICY, definitionSha256: TRAINING_HISTORY_SHA256,
        fromSeason: slot.season - 2, throughSeason: slot.season, windows: [4, 8, 16], maximumSlots: 16 },
      feature: featureSelection,
      label: { state: selected ? "usable" : "missing", reason: selected ? null : label ? "label-profile-mismatch" : "label-not-recorded",
        reference: selected ? reference(selected) : null, supersededAsOf: selected ? successors.has(selected.id) : false,
        supersededNow: Boolean(currentSuccessor), record: selected },
    };
  });
};
