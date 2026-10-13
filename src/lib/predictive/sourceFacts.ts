import { planSourceBindingTransition, sourceBindingHeadsAt, sourceStatsLineageKey, type SourceBindingEvent } from "./sourceLineage.ts";
import { sourceNormalizationBasis, type SourceNormalizationPlan } from "./sourceNormalization.ts";
import { canonical, compareText, digest, entityKey, exact, gameIdentity, instant, playerIdentity, refuse, TEAM_IDS } from "./validation.ts";

export const SOURCE_FACT_VERSION = "source-fact-heads-v1";
export const SOURCE_FACT_BOUNDS = { profiles: 16, entityKeys: 64, lineages: 256, events: 8192 } as const;
export type SourceFactRequest = { profileIds: string[]; entityKeys: string[]; cutoff: string };
export type SourceFactHead = {
  lineageKey: string; entityKey: string; head: SourceBindingEvent;
  // An unchanged recapture can reuse a revision while replacing its binding.
  // Decisions/manifests must pin the binding as well as the statistical ID.
  revisionKnownAt: string; headToken: string;
};
export type WithheldSourceFact = {
  lineageKey: string; profileId: string; bindingId: string | null;
  reason: string; routing: "known-destinations" | "unresolved"; entityKeys: string[];
};
export type SourceFactSnapshot = {
  version: typeof SOURCE_FACT_VERSION; status: "replayed-source-facts" | "unavailable-source-facts"; reason: string | null;
  request: SourceFactRequest; coverage: "recorded-lineages-only"; heads: SourceFactHead[]; withheld: WithheldSourceFact[];
  inputDigest: string; observationsPublished: false; featuresPublished: false; labelsFinalized: false; populationCoverage: "unqualified";
};

export const sourceFactRequest = (request: SourceFactRequest): SourceFactRequest => {
  exact(request, ["profileIds", "entityKeys", "cutoff"]); instant(request.cutoff);
  if (!Array.isArray(request.profileIds) || !request.profileIds.length || request.profileIds.length > SOURCE_FACT_BOUNDS.profiles ||
      request.profileIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f|]/.test(id)) ||
      !Array.isArray(request.entityKeys) || request.entityKeys.length > SOURCE_FACT_BOUNDS.entityKeys) refuse("source-fact-request-refused");
  for (const key of request.entityKeys) {
    const parts = typeof key === "string" ? /^(player-game-stats|team-game-stats):([a-f0-9-]{36}):(.+)$/.exec(key) : null;
    if (!parts) refuse("source-fact-request-refused");
    gameIdentity(parts[2]);
    if (parts[1] === "player-game-stats") playerIdentity(parts[3]);
    else if (!TEAM_IDS.includes(parts[3])) refuse("source-fact-request-refused");
  }
  return { profileIds: [...new Set(request.profileIds)].sort(compareText), entityKeys: [...new Set(request.entityKeys)].sort(compareText), cutoff: request.cutoff };
};
export const sourceFactSnapshot = (request: SourceFactRequest, heads: SourceFactHead[], withheld: WithheldSourceFact[], reason: string | null = null): SourceFactSnapshot => {
  const evidence = { version: SOURCE_FACT_VERSION, request, coverage: "recorded-lineages-only", heads, withheld, reason } as const;
  return { ...evidence, status: reason ? "unavailable-source-facts" : "replayed-source-facts", inputDigest: digest(canonical(evidence)),
    observationsPublished: false, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" };
};

// Callers provide complete cutoff-visible raw chains and verified current plans.
// This function checks the ledger but cannot authorize rights or verify bytes.
// Canonical filtering happens last: a reroute must not resurrect its ancestor.
export const sourceFactHeadsAt = (history: SourceBindingEvent[], plans: SourceNormalizationPlan[], input: SourceFactRequest) => {
  const request = sourceFactRequest(input); const at = instant(request.cutoff);
  const visible = history.filter((event) => instant(event.recordedAt) <= at);
  if (visible.length > SOURCE_FACT_BOUNDS.events || plans.length > SOURCE_FACT_BOUNDS.lineages) refuse("source-fact-bounds-refused");
  const rawHeads = sourceBindingHeadsAt(visible, request.cutoff);
  const chains = new Map<string, SourceBindingEvent[]>();
  for (const event of visible) {
    if (!request.profileIds.includes(event.plan.binding.sourceProfileId)) refuse("source-fact-profile-scope-refused");
    const key = sourceStatsLineageKey(event.plan.binding.sourceRequest);
    const chain = chains.get(key) ?? []; chain.push(event); chains.set(key, chain);
  }
  if (chains.size > SOURCE_FACT_BOUNDS.lineages) refuse("source-fact-bounds-refused");
  const current = new Map<string, SourceNormalizationPlan>();
  for (const plan of plans) {
    const key = sourceStatsLineageKey(plan.binding.sourceRequest);
    if (!request.profileIds.includes(plan.binding.sourceProfileId) || instant(plan.binding.cutoff) !== at) refuse("source-fact-plan-scope-refused");
    if (current.has(key)) refuse("source-fact-plan-duplicate");
    // Check plan shape/digest/times and same raw identity independently of the
    // freshness comparison. A correctly hashed plan still needs byte/SQL proof.
    planSourceBindingTransition(plan, chains.get(key) ?? [], request.cutoff);
    current.set(key, plan);
  }
  if (rawHeads.some((head) => !current.has(sourceStatsLineageKey(head.plan.binding.sourceRequest)))) refuse("source-fact-plan-missing");
  const byLineage = new Map(rawHeads.map((head) => [sourceStatsLineageKey(head.plan.binding.sourceRequest), head]));
  const heads: SourceFactHead[] = []; const withheld: WithheldSourceFact[] = [];
  for (const [lineageKey, plan] of [...current].sort(([a], [b]) => compareText(a, b))) {
    const head = byLineage.get(lineageKey); const chain = chains.get(lineageKey) ?? [];
    const reason = !head ? "source-binding-missing" : sourceNormalizationBasis(head.plan) !== sourceNormalizationBasis(plan)
      ? "source-binding-stale" : !head.revision ? head.plan.reason ?? "source-binding-withheld" : null;
    if (reason) {
      // Keep only routing metadata, never a stale historical numeric payload.
      // Historical destinations are useful hints, not proof that unresolved
      // current routing is unrelated to a previously unseen destination.
      const entityKeys = [...new Set([...chain.flatMap((event) => event.revision ? [entityKey(event.revision)] : []),
        ...(plan.candidate ? [entityKey({ id: "current-plan", sourceRecordId: "", predecessorId: null, correctionReason: null, ...plan.candidate })] : [])])]
        .filter((key) => !request.entityKeys.length || request.entityKeys.includes(key)).sort(compareText);
      // A plan that cannot currently establish an identity cannot prove it is
      // outside a canonical filter, even when it has historical destinations.
      const routing = plan.candidate ? "known-destinations" as const : "unresolved" as const;
      if (routing === "unresolved" || !request.entityKeys.length || entityKeys.length) withheld.push({ lineageKey, profileId: plan.binding.sourceProfileId,
        bindingId: head?.id ?? null, reason, routing, entityKeys });
      continue;
    }
    const observed = head!; const key = entityKey(observed.revision!);
    if (request.entityKeys.length && !request.entityKeys.includes(key)) continue;
    const revisionKnownAt = chain.filter((event) => event.revision?.id === observed.revision!.id)
      .map((event) => event.recordedAt).sort((a, b) => instant(a) - instant(b))[0];
    heads.push({ lineageKey, entityKey: key, head: observed, revisionKnownAt,
      headToken: digest(canonical({ bindingId: observed.id, revisionId: observed.revision!.id, planDigest: observed.plan.planDigest })) });
  }
  return sourceFactSnapshot(request, heads, withheld);
};

// This preliminary selector exposes uncertainty explicitly. Reconciliation is
// still required for multiple heads; a withheld expected contribution cannot
// become an observed zero or be silently replaced by another provider.
export const selectSourceFact = (snapshot: SourceFactSnapshot, key: string) => {
  if (snapshot.request.entityKeys.length && !snapshot.request.entityKeys.includes(key)) refuse("source-fact-selection-scope-refused");
  const heads = snapshot.heads.filter((row) => row.entityKey === key);
  const withheld = snapshot.withheld.filter((row) => row.routing === "unresolved" || row.entityKeys.includes(key));
  const state = snapshot.reason || withheld.length ? "withheld" as const : heads.length === 1 ? "selected" as const :
    heads.length ? "ambiguous" as const : "missing" as const;
  return { state, head: state === "selected" ? heads[0] : null, heads, withheld };
};
