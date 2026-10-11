import type { Capture, CompletionRecord, Decision, IdentityLink, Label, Observation, ParticipationRecord, Profile, Reconciliation, Revision } from "./types.ts";
import { LABEL_STATS } from "./types.ts";
import { markerHeadsAt } from "./completion.ts";
import { participationHeadsAt } from "./participation.ts";
import { compareText, gameIdentity, instant, playerIdentity, refuse } from "./validation.ts";

const HOUR = 3_600_000;

// canonical-label-finalization-v1: the earliest operational-final time is the
// later of the completion bound + 72 hours and the first Thursday 12:00 UTC
// strictly after the bound. Mirrored by predictive_label_eligible_final_at().
export const eligibleFinalAt = (bound: string): string => {
  const at = instant(bound);
  const day = new Date(at); day.setUTCHours(12, 0, 0, 0);
  let thursday = day.getTime() + ((4 - day.getUTCDay() + 7) % 7) * 24 * HOUR;
  if (thursday <= at) thursday += 7 * 24 * HOUR;
  return new Date(Math.max(at + 72 * HOUR, thursday)).toISOString();
};

type Context = {
  observations: Map<string, Observation>; decisions: Map<string, Decision>; captures: Map<string, Capture>;
  artifactRevisions: Map<string, Revision[]>; profiles: Map<string, Profile>; identityLinks: IdentityLink[];
};
const ids = (values: string[]) => [...values].sort(compareText).join("\n");
const usableBy = (row: Observation, t: number) => instant(row.capture.availableAt) <= t && instant(row.capture.ingestedAt) <= t;
// Heads of the decision's evidence scope at instant t, as replay would see them.
const scopeHeads = (decision: Decision, observations: Map<string, Observation>, t: number) => {
  const parts = decision.entityKey.split(":");
  if (decision.kind === "completion") return markerHeadsAt(observations.values(), parts[1], t);
  if (decision.kind === "participation") return participationHeadsAt(observations.values(), parts[1], parts[2], t);
  const fact = decision.entityKey.slice("reconciliation:".length);
  const visible = [...observations.values()].filter((row) => row.entityKey === fact && usableBy(row, t));
  const superseded = new Set(visible.map((row) => row.revision.predecessorId));
  return visible.filter((row) => !superseded.has(row.revision.id));
};
// A label may cite a decision only while it still matches the evidence heads at
// the label's creation time; a decision overtaken by later evidence is stale.
const current = (decision: Decision, context: Context, t: number) =>
  instant(decision.decidedAt) <= t && ids(decision.inputs.map((input) => input.observationId)) === ids(scopeHeads(decision, context.observations, t).map((row) => row.revision.id));

// Revisions usable at t with no successor usable at t, across all facts.
const headsAt = (observations: Map<string, Observation>, t: number) => {
  const usable = [...observations.values()].filter((row) => usableBy(row, t));
  const superseded = new Set(usable.map((row) => row.revision.predecessorId));
  return usable.filter((row) => !superseded.has(row.revision.id));
};
// 9 (bridge-v1): the pinned bridge revision maps the provider identity to this
// player; it is usable, current and unambiguous at creation, effective at every
// current kickoff for the game, and its profile is linked to the selected row's.
const bridgeBinds = (label: Label, bridge: Observation | undefined, selected: Observation, context: Context, created: number) => {
  if (!bridge || bridge.revision.kind !== "player-bridge" || bridge.revision.data.playerId !== label.playerId || !usableBy(bridge, created)) return false;
  const data = bridge.revision.data; const from = instant(data.effectiveFrom); const to = instant(data.effectiveTo);
  if (selected.revision.kind !== "player-game-stats" || selected.revision.data.rawPlayerId !== data.rawPlayerId ||
      selected.revision.data.playerIdProvider !== data.provider || selected.revision.data.playerId !== label.playerId) return false;
  const heads = headsAt(context.observations, created);
  if (!heads.some((row) => row.revision.id === bridge.revision.id)) return false;
  if (!context.identityLinks.some((link) => link.statsProfileId === selected.artifact.profileId && link.bridgeProfileId === bridge.artifact.profileId &&
      link.provider === data.provider && instant(link.decidedAt) <= created)) return false;
  const ambiguous = heads.some((row) => row.revision.kind === "player-bridge" && row.revision.id !== bridge.revision.id && row.revision.data.provider === data.provider &&
    instant(row.revision.data.effectiveFrom) < to && from < instant(row.revision.data.effectiveTo) &&
    ((row.entityKey === bridge.entityKey && row.revision.data.playerId !== data.playerId) ||
      (row.entityKey !== bridge.entityKey && row.revision.data.playerId === data.playerId)));
  if (ambiguous) return false;
  const schedules = [...context.observations.values()].filter((row) => row.entityKey === "schedule:" + label.gameId && usableBy(row, created));
  const current = heads.filter((row) => row.entityKey === "schedule:" + label.gameId);
  return schedules.length > 0 && current.every((row) => row.revision.kind === "schedule" && from <= instant(row.revision.data.kickoff) && instant(row.revision.data.kickoff) < to);
};

// The nine binding checks, mirrored by predictive_label_check() in 0003.
export const validateLabels = (labels: Label[], context: Context) => {
  const byId = new Map<string, Label>(); const successors = new Set<string>();
  for (const label of labels) { if (byId.has(label.id)) refuse("duplicate-label"); byId.set(label.id, label); }
  for (const label of labels) {
    playerIdentity(label.playerId); gameIdentity(label.gameId);
    const field = LABEL_STATS[label.stat] ?? refuse("invalid-label");
    const created = instant(label.createdAt);
    const fail = (check: number) => refuse("label-binding-" + check);
    const completion = context.decisions.get(label.completionDecisionId) as CompletionRecord | undefined;
    const participation = context.decisions.get(label.participationDecisionId) as ParticipationRecord | undefined;
    // 1-2: the decisions concern this game and this player-game, and are current.
    if (!completion || completion.kind !== "completion" || completion.entityKey !== "completion:" + label.gameId || !current(completion, context, created)) fail(1);
    if (!participation || participation.kind !== "participation" || participation.entityKey !== "participation:" + label.gameId + ":" + label.playerId ||
        !current(participation, context, created)) fail(2);
    const labelled = label.state === "provisional" || label.state === "final";
    if (labelled) {
      if (completion!.outcome.state !== "completed" || participation!.outcome.state !== "offensive-participant") fail(2);
      // 3: a selected reconciliation of this player-game's stats, current at creation.
      const reconciliation = context.decisions.get(label.reconciliationDecisionId ?? "") as Reconciliation | undefined;
      if (!reconciliation || reconciliation.kind !== "reconciliation" || reconciliation.entityKey !== "reconciliation:player-game-stats:" + label.gameId + ":" + label.playerId ||
          reconciliation.outcome.result !== "selected" || reconciliation.outcome.selectedObservationId !== label.selectedObservationId || !current(reconciliation, context, created)) fail(3);
      // 4: the value is the selected payload field for this season type.
      const selected = context.observations.get(label.selectedObservationId ?? "");
      if (!selected || selected.revision.kind !== "player-game-stats" || selected.revision.data.seasonType !== label.seasonType ||
          selected.revision.data[field] === null || selected.revision.data[field] !== label.value || !usableBy(selected, created)) fail(4);
      if (label.playerBridgeObservationId !== null) {
        if (!bridgeBinds(label, context.observations.get(label.playerBridgeObservationId), selected!, context, created)) fail(9);
      } else if (label.state === "final") fail(9);
    } else {
      if (label.value !== null || label.selectedObservationId !== null) fail(4);
      if (label.playerBridgeObservationId !== null) fail(9);
      if (label.state === "excluded" && (completion!.outcome.state !== "completed" ||
          !["zero-offensive-participation", "inactive-or-dnp"].includes(participation!.outcome.state))) fail(2);
    }
    // 5: final labels need the post-window capture that reconfirmed the evidence.
    if (label.state === "final") {
      const eligible = eligibleFinalAt(completion!.outcome.completionObservedAt!);
      const capture = context.captures.get(label.postWindowCaptureId ?? "");
      if (label.eligibleFinalAt !== eligible || label.finalizedAt === null || instant(label.finalizedAt) < instant(eligible) || created < instant(label.finalizedAt)) fail(5);
      if (!capture || capture.state !== "published" || !capture.bodyComplete || !capture.headerVerified || !capture.parserSucceeded ||
          instant(capture.capturedAt) < instant(eligible) || !context.artifactRevisions.get(capture.artifactId)?.some((revision) => revision.id === label.selectedObservationId)) fail(5);
      // 6: every dependency was usable when this label version was created.
      if (instant(capture!.ingestedAt) > created) fail(6);
    } else if (label.postWindowCaptureId !== null || label.finalizedAt !== null || label.eligibleFinalAt !== null) fail(5);
    // 7: versions form one unbranched chain per natural key.
    if ((label.labelVersion === 1) !== (label.predecessorId === null)) fail(7);
    if (label.predecessorId !== null) {
      const prior = byId.get(label.predecessorId);
      if (!prior || prior.playerId !== label.playerId || prior.gameId !== label.gameId || prior.seasonType !== label.seasonType ||
          prior.stat !== label.stat || prior.labelVersion + 1 !== label.labelVersion || instant(prior.createdAt) >= created || successors.has(prior.id)) fail(7);
      successors.add(prior!.id);
    }
    // 8: synthetic evidence anywhere in the label makes it synthetic-proof.
    const cited = [completion, participation, context.decisions.get(label.reconciliationDecisionId ?? "")].filter((value): value is Decision => !!value);
    const evidenceRows = [label.selectedObservationId, label.playerBridgeObservationId].flatMap((id) => context.observations.get(id ?? "") ?? []);
    const synthetic = cited.some((decision) => decision.mode === "synthetic-proof") ||
      evidenceRows.some((row) => context.profiles.get(row.artifact.profileId)?.purpose === "synthetic-test");
    if (synthetic !== (label.mode === "synthetic-proof")) fail(8);
  }
};
