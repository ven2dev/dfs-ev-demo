# #52 follow-up issue drafts

These are local acceptance-criteria drafts, not opened GitHub issues. The owner
approved the [PR B foundation boundary](predictive-pr-b.md#revised-pr-b-acceptance-boundary-2026-10-13)
subject to independent review. Keep #52 as the parent; a foundation merge does
not close its original criteria. Preserve the existing commits and frozen
migrations. Create new branches from merged main for the follow-ups.

## First usable real QB passing-yards slice

The first step is to select one QB, one target event, an explicit player-history
window and an explicit opponent-history window. Selection is still outstanding;
do not estimate delivery until the following inventory has been completed for
that bounded scope. A current capture cannot be backdated to an old cutoff.

| Required dependency | Inventory must record |
| --- | --- |
| Player/team/game identity | Exact IDs, permitted source/profile, bridge versions and effective/knowledge times |
| Target and history schedules | Kickoff versions, independent expected-game enumeration, REG/POST and reschedule handling |
| Membership | Evidence-backed dated membership and gaps for every retained player-history slot |
| Player and opponent statistics | Exact captures/rows, paired denominators, binding heads, completeness and cutoff eligibility |
| Individual participation and completion | Permitted evidence for the selected games; positive usage, zero-opportunity, known absence and unknown remain distinct |
| Reconciliation and final label | Required source decisions, exact raw player bridge, finalization window and selected post-window capture |
| Rights and operation | Permission for each requested use, retention rules, request/byte/runtime/memory/storage caps and recovery procedure |

Acceptance criteria:

- Publish the completed inventory, selected scope, unresolved dependencies and
  a revised estimate that includes implementation, independent review and final
  checks. If a required source does not qualify, report the precise blocker and
  next source decision rather than silently weakening the contract.
- Implement/persist the minimum schedule, identity and membership adapters
  needed for that scope, with missingness and correction tests. Qualify the
  selected individual completion/participation evidence in this issue.
- Produce one usable real QB bundle with player usage **and opponent context**,
  and one qualified final label. Preserve exact source/binding/decision/rights
  provenance; report excluded and unresolved history slots.
- Retain real captures A and B and reproduce the earlier cutoff after B.
  Demonstrate later replay against the evidence actually observed. Edited
  fixtures cannot be reported as observed provider corrections. If no provider
  correction occurs, report that limitation and retain the separate fixture
  correction proof rather than claiming an observed correction.
- Enforce minimum resource limits and demonstrate idempotent retry and
  reproducible interrupted-run/restore recovery for this scope. Record the
  actual schema/code versions and measured costs.
- Keep population completeness explicitly unqualified unless its separate gate
  passes. No training, model validation, product integration or hosted activation
  is implied by this proof.

## Complete participation and outcome population

Define a bounded population/history claim and account for every compatible
roster candidate, including zero-opportunity participants, confirmed absences and
unresolved cases. Preserve source/effective/knowledge times, reconciliation and
applicable numeric labels. Publish coverage/exclusion/unresolved counts and
fail closed where evidence is insufficient. An individual QB proof does not
close this gate; #54 cannot claim population-complete evaluation without it.

## Remaining raw injury and depth adapters

Persist both selected groups with reviewed headers, identity bindings, exact
capture provenance, append-only corrections, retention and explicit missingness.
Document freshness/removal semantics and the limits of publication evidence.
Raw research capture does not authorize predictor or public-display use; record
those qualification decisions separately. Keep broader enrichment out of scope.

## Remaining market consumers

Implement the remaining eight registry markets in separately bounded passing,
rushing and receiving increments using shared verified evidence. Each increment
names its required fields/positions, chronology, denominators, missingness,
labels, manifests and replay/retention checks. Preserve QB/FB cases where the
registry permits them. Record supported and blocked capabilities; model
sufficiency/evaluation belongs to #54. Required snap inputs remain an explicit
dependency, rather than hiding licensing work inside a consumer implementation.

## Snap-source qualification

Qualify a permitted source's offensive snaps, team denominator, player/event
bridges, freshness, coverage, correction history, retention and use rights.
PFR remains rejected under the approved source decision. No purchase or paid
acquisition is authorized by this draft. Deliver a qualified source contract or
a precise blocked disposition. Then track the required adapter/integration;
consumers requiring snap share cannot be declared usable before it exists.

## Broader multi-feed acquisition and operations

After the bounded local proof, cover all seven selected capture groups with
shared polling, conditional responses, checkpoints, idempotency, bounded retries
and failure observability. Measure and enforce profile-wide request, bytes,
runtime, memory, storage and retention budgets at representative scale. Verify
indexed query plans and recovery. This expands the first slice's local limits;
it does not duplicate its basic proof or activate a hosted scheduler.

## Hosted and scheduled activation

This issue remains blocked by [#95](https://github.com/ven2dev/dfs-ev-demo/issues/95)
and approved persistence, source-use rights and measured budgets. Document the
hosting/scheduler profile, credentials and role boundaries, recovery/retention
and monitoring, then verify the approved rollout. Completing local ingestion
does not clear #95 or authorize a hosted/dev/Production migration.

## Review and merge sequencing

Review the existing foundation as one PR against the correct merged-main base
`3daf1dc` (refresh main before opening the PR if it has advanced). Resolve review
blockers, including the 0010 two-ledger architecture disposition, and pass final
checks/remote CI. Only then merge. Follow-up tickets track the remaining work;
they do not approve this branch for merge. Keep the commits intact and create
follow-up branches from main after the foundation merge. Until then, any child
implementation depending on it is explicitly stacked and blocked on that merge.
