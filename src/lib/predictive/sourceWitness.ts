import { hasPositivePlayerUsage } from "./participation.ts";
import { reconciliationOutcome } from "./policies.ts";
import { selectSourceFact, sourceFactRequest, sourceFactSnapshot, type SourceFactSnapshot, type WithheldSourceFact } from "./sourceFacts.ts";
import { canonical, compareText, digest, entityKey, exact, instant, refuse, sourceKey } from "./validation.ts";

export const SOURCE_WITNESS_VERSION = "source-consumer-witness-v1";
export type SourceHeadReference = {
  profileId: string; lineageKey: string; entityKey: string; bindingId: string; revisionId: string; headToken: string;
};
export type SourceWitness = {
  version: typeof SOURCE_WITNESS_VERSION; cutoff: string; profileIds: string[]; entityKeys: string[];
  coverage: "recorded-lineages-only"; heads: SourceHeadReference[]; withheld: WithheldSourceFact[];
  reason: string | null; missingEntityKeys: string[]; evidenceDigest: string;
};
const evidence = ({ cutoff: _cutoff, evidenceDigest: _digest, ...fields }: SourceWitness) => {
  void _cutoff; void _digest; return fields;
};
const reference = (row: SourceFactSnapshot["heads"][number]): SourceHeadReference => ({
  profileId: row.head.plan.binding.sourceProfileId, lineageKey: row.lineageKey, entityKey: row.entityKey,
  bindingId: row.head.id, revisionId: row.head.revision!.id, headToken: row.headToken,
});

// Shared application preparation for feature/decision/label dependencies. The
// input must come from the verified persisted reader; hashing is not authority
// to read bytes, record decisions or finalize labels. No active consumer uses
// this contract without the matching SQL head rule/recorder (sourceConsumers).
export const sourceFactWitness = (snapshot: SourceFactSnapshot, entityKeys = snapshot.request.entityKeys): SourceWitness => {
  const request = sourceFactRequest({ ...snapshot.request, entityKeys });
  if (snapshot.request.entityKeys.length && (!request.entityKeys.length ||
      request.entityKeys.some((key) => !snapshot.request.entityKeys.includes(key)))) refuse("source-witness-scope-refused");
  if (canonical(snapshot) !== canonical(sourceFactSnapshot(sourceFactRequest(snapshot.request), snapshot.heads, snapshot.withheld, snapshot.reason)))
    refuse("source-witness-snapshot-refused");
  // These checks detect inconsistent snapshots, not forged/rehashed evidence.
  // Byte, rights, full-lineage and current-plan verification belong to the reader.
  const lineages = new Set<string>();
  for (const row of snapshot.heads) {
    if (!row.head.revision || entityKey(row.head.revision) !== row.entityKey || lineages.has(row.lineageKey) ||
        !request.profileIds.includes(row.head.plan.binding.sourceProfileId) ||
        (snapshot.request.entityKeys.length && !snapshot.request.entityKeys.includes(row.entityKey)) ||
        instant(row.revisionKnownAt) > instant(row.head.recordedAt) || instant(row.head.recordedAt) > instant(request.cutoff) ||
        row.headToken !== digest(canonical({ bindingId: row.head.id, revisionId: row.head.revision.id, planDigest: row.head.plan.planDigest })))
      refuse("source-witness-snapshot-refused");
    lineages.add(row.lineageKey);
  }
  const heads = snapshot.heads.filter((row) => !request.entityKeys.length || request.entityKeys.includes(row.entityKey))
    .map(reference).sort((a, b) => compareText(a.lineageKey, b.lineageKey));
  const withheld = snapshot.withheld.filter((row) => row.routing === "unresolved" || !request.entityKeys.length ||
    row.entityKeys.some((key) => request.entityKeys.includes(key))).map((row) => ({ ...row,
      entityKeys: row.entityKeys.filter((key) => !request.entityKeys.length || request.entityKeys.includes(key)).sort(compareText),
    })).sort((a, b) => compareText(a.lineageKey, b.lineageKey));
  const fields: Omit<SourceWitness, "cutoff" | "evidenceDigest"> = { version: SOURCE_WITNESS_VERSION, profileIds: request.profileIds, entityKeys: request.entityKeys,
    coverage: snapshot.coverage, heads, withheld, reason: snapshot.reason,
    missingEntityKeys: request.entityKeys.filter((key) => selectSourceFact(snapshot, key).state === "missing") };
  // Query time alone cannot stale a decision. The reference pins binding ID and
  // token, so an unchanged recapture still changes the evidence set.
  return { ...fields, cutoff: request.cutoff, evidenceDigest: digest(canonical(fields)) };
};

export const checkSourceWitness = (recorded: SourceWitness, snapshot: SourceFactSnapshot) => {
  exact(recorded, ["version", "cutoff", "profileIds", "entityKeys", "coverage", "heads", "withheld", "reason", "missingEntityKeys", "evidenceDigest"]);
  const scope = sourceFactRequest({ profileIds: recorded.profileIds, entityKeys: recorded.entityKeys, cutoff: recorded.cutoff });
  if (recorded.version !== SOURCE_WITNESS_VERSION || recorded.coverage !== "recorded-lineages-only" ||
      recorded.evidenceDigest !== digest(canonical(evidence(recorded))) ||
      canonical(scope.profileIds) !== canonical(recorded.profileIds) || canonical(scope.entityKeys) !== canonical(recorded.entityKeys))
    refuse("source-witness-record-refused");
  if (instant(recorded.cutoff) > instant(snapshot.request.cutoff)) refuse("source-witness-cutoff-refused");
  if (canonical(recorded.profileIds) !== canonical(sourceFactRequest(snapshot.request).profileIds)) refuse("source-witness-scope-refused");
  const current = sourceFactWitness(snapshot, recorded.entityKeys);
  const reason = current.reason ?? (current.withheld.length ? "source-evidence-withheld" : null);
  const state = reason ? "unavailable" as const : recorded.evidenceDigest === current.evidenceDigest ? "unchanged" as const : "changed" as const;
  // 'unchanged' also describes an unchanged empty set. It is not a usable
  // selection, complete population, fresh decision or final-label approval.
  return { state, reason, current };
};

// The statistics contribution to participation-v1/F3, not a full participation
// decision. Explicit inactive/snap evidence still needs the policy's complete
// evidence scope. Unknown source evidence cannot be rescued by positive rivals.
export const sourceUsageEvidence = (snapshot: SourceFactSnapshot, key: string) => {
  sourceFactRequest({ ...snapshot.request, entityKeys: [key] });
  if (!key.startsWith("player-game-stats:")) refuse("source-usage-scope-refused");
  const witness = sourceFactWitness(snapshot, [key]); const selection = selectSourceFact(snapshot, key);
  const state = selection.state === "withheld" ? "withheld" as const : selection.heads.length &&
    selection.heads.every((row) => hasPositivePlayerUsage(row.head.revision!)) ? "positive-usage" as const : "not-established" as const;
  return { state, witness, populationCoverage: "unqualified" as const };
};

// A read-only application of reconciliation-v1, over the exact bound head set.
// Withheld evidence is not silently discarded to manufacture single-source
// agreement. The selected reference retains its binding, not just revision ID.
export const sourceReconciliationEvidence = (snapshot: SourceFactSnapshot, key: string) => {
  const witness = sourceFactWitness(snapshot, [key]); const selection = selectSourceFact(snapshot, key);
  if (selection.state === "withheld") return { state: "withheld" as const, outcome: null, selected: null, witness };
  const outcome = reconciliationOutcome(selection.heads.map((row) => ({ id: row.head.revision!.id,
    sourceKey: sourceKey(row.head.revision!, row.head.plan.binding.sourceProfileId), data: row.head.revision!.data })));
  const selected = selection.heads.find((row) => row.head.revision!.id === outcome.selectedObservationId);
  return { state: "evaluated" as const, outcome, selected: selected ? reference(selected) : null, witness };
};

// Only confirms the selected binding's own source capture. Completion, rights
// for outcome use, reconciliation, identity and all other label checks remain
// mandatory; this helper cannot finalize a label. It requires a selection under
// reconciliation-v1, including the deterministic choice for agreeing sources.
export const sourcePostWindowCapture = (snapshot: SourceFactSnapshot, recorded: SourceWitness, request: {
  entityKey: string; bindingId: string; captureId: string; eligibleAt: string;
}) => {
  exact(request, ["entityKey", "bindingId", "captureId", "eligibleAt"]);
  const eligible = instant(request.eligibleAt);
  if (recorded.entityKeys.length && !recorded.entityKeys.includes(request.entityKey)) refuse("source-witness-scope-refused");
  sourceFactRequest({ ...snapshot.request, entityKeys: [request.entityKey] });
  if (!request.entityKey.startsWith("player-game-stats:")) refuse("source-post-window-scope-refused");
  const check = checkSourceWitness(recorded, snapshot);
  const result = (reason: string | null, head: SourceHeadReference | null = null) => ({
    state: reason ? "unavailable-source-capture" as const : "confirmed-source-capture" as const,
    reason, head, captureId: reason ? null : request.captureId, witness: check.current, labelsFinalized: false as const,
  });
  if (check.state !== "unchanged") return result(check.reason ?? "source-witness-changed");
  const selection = sourceReconciliationEvidence(snapshot, request.entityKey);
  if (!selection.selected) return result("source-selection-" + (selection.outcome?.result ?? "withheld"));
  const row = snapshot.heads.find((head) => head.head.id === selection.selected!.bindingId)!;
  if (row.head.id !== request.bindingId) return result("source-binding-selection-mismatch");
  const captures = row.head.plan.binding.sourceCaptures;
  if (captures.length !== 1 || captures[0].id !== request.captureId) return result("source-capture-selection-mismatch");
  const capture = captures[0]; const cutoff = instant(snapshot.request.cutoff);
  if (instant(capture.capturedAt) < eligible) return result("source-capture-before-final-window");
  if (instant(capture.capturedAt) > instant(capture.availableAt) || instant(capture.availableAt) > instant(capture.ingestedAt) ||
      instant(capture.ingestedAt) > cutoff || instant(row.head.recordedAt) > cutoff) return result("source-capture-after-cutoff");
  return result(null, reference(row));
};
