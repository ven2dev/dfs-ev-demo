# #138 local feature-store foundation acceptance boundary

Status: owner-authorized scope revision on 2026-10-17. Steps 1–5 are preserved
through `420710f`; current main was merged cleanly at `05bf12c` (main `4e13c0f`).
This closes the existing oversized foundation delivery after its PR review and
CI, rather than turning #138 into an indefinite tracker. Every successor below
is a separate issue/branch/PR with a planning estimate no greater than five hours.
This historical foundation is the explicitly accepted scope exception; it is
not retroactively a five-hour issue.

## Design basis

- **Pattern:** incremental delivery of a trusted ELT/feature-store foundation,
  followed by bounded model, serving, governance and qualification changes.
- **Alternatives:** continuing the week-sized issue hides scope and review cost;
  discarding or rewriting approved foundation commits destroys reviewed history.
- **Targets:** retain all original hard deadlines and 30% headroom. This PR proves
  the dataset target and deterministic producer work budgets; other performance
  gates retain their own successor issues and are not silently waived.
- **Requirement reasons:** an explicit acceptance boundary prevents foundation
  merge being mistaken for full model/cloud readiness; <=5-hour successor scopes
  keep delivery/review manageable; evidence pins prevent claims drifting across
  implementations; unchanged migrations prevent accidental production rollout.
- **Assumptions:** local research, trusted pipeline, disposable PostgreSQL,
  local ObjectStore, historical availability unverified, no complete population.

## Foundation delivered by this PR

- Main-based code, mutable proposal SQL only, isolated `fs138` schema, no ordered
  migration or generated schema/catalog change; no held legacy implementation.
- Original-byte validated ingestion, typed normalization, actual DB knowledge
  clocks, strict/reconstruction as-of selection, pipeline-only derived writers.
- Set-based versioned QB features/labels, <=16 prior eligible REG games with
  minimum 2 and one-hour pregame cutoff; event-time leakage refused in both modes.
- Explicit missing/ambiguous labels, synthetic correction with last-valid stale/
  superseded flags, and accepted season-scoped snapshot lineage.
- Immutable pinned datasets with version/flag policy, 2021 warm-up excluded,
  exact-file and natural-key/value hashes, and local ObjectStore publication.
- Two batched rights/status queries (authorization and pre-delivery), no reader
  table locks, upload-before-BEGIN, HEAD under the cleaner address lock, immediate
  invalidation plus configurable delayed deletion, resumable cleanup and pruning.
- The committed preregistration precedes evaluation; source gaps and license/
  availability limits are retained. No statistical evaluation has run.

## Evidence and merge gates

The owner reviewed all five step-5 corrections and approved commit `420710f`.
Historical measurement receipts retain their original statuses and timestamps;
they are not rewritten to imply that a later final candidate was already tested.

- 2,504 usable retrospective pairs (2022–2025); all retain the historical-
  availability warning. Strict historical snapshot eligibility is not fabricated.
- Dataset cold trials: 851.75 / 600.89 / 628.19 ms; warm: 519.16 / 463.93 /
  458.61 ms. Each passes <=21,000 ms under 30,000 ms, with eight SQL statements,
  exactly two measured rights/status queries and no per-row calls.
- Producer budgets: ingestion 12 statements, derived job 8, dataset read 3.
  No revised producer cold/warm capacity pass is claimed by this PR.
- Deleting isolated 2025 stats invalidates exactly 1,948 features, 1,948 labels
  and six datasets. All 5,517 earlier 2022–2024 feature and label rows survive
  with identical IDs/values and zero earlier-season recomputation.
- Step-5 evidence: 40 PostgreSQL probes, 15 unit tests, typecheck and lint pass.
  Final integrated checks are recorded separately in the PR and scope receipt.
- [Step-5 checkpoint](evidence/feature-store-138/step-5-checkpoint.json),
  [dataset/deletion receipt](evidence/feature-store-138/step-5-real-dataset.json),
  [validation](evidence/feature-store-138/step-5-validation.json).

The PR remains draft pending owner-run independent review and final-commit remote
CI. Neither scope approval nor step approval substitutes for implementation review.
The PR closes #138 only when the owner subsequently merges it. This session never
merges. Fresh push consent was supplied in the instruction to update #138 and
open its PR; no later implementation is authorized by that instruction.

## Successor issues: all unfinished criteria preserved

Each estimate includes implementation, focused validation, compact evidence and
documentation; owner waiting time is excluded. If revised LOE exceeds five hours,
split remaining scope before proceeding. No successor implementation starts as
part of this foundation publication. Each starts from main after prerequisites
merge, with its own owner-approved roadmap. The preregistration stays unchanged.

| Issue | Deliverable | Planning LOE |
|---|---|---|
| [#163](https://github.com/ven2dev/dfs-ev-demo/issues/163) | share empirical math and prove the materialized-feature adapter | 3–4 hours |
| [#164](https://github.com/ven2dev/dfs-ev-demo/issues/164) | run preregistered chronological QB baseline evaluation | 4–5 hours |
| [#165](https://github.com/ven2dev/dfs-ev-demo/issues/165) | publish immutable model and report manifests | 2–3 hours |
| [#166](https://github.com/ven2dev/dfs-ev-demo/issues/166) | govern model artifacts with rights and delayed deletion | 3–4 hours |
| [#167](https://github.com/ven2dev/dfs-ev-demo/issues/167) | serve local predictions from materialized QB features | 2–3 hours |
| [#168](https://github.com/ven2dev/dfs-ev-demo/issues/168) | prove repeated cold and warm prediction capacity | 2–4 hours |
| [#169](https://github.com/ven2dev/dfs-ev-demo/issues/169) | complete repeated ingestion and season-job capacity matrices | 3–5 hours |
| [#170](https://github.com/ven2dev/dfs-ev-demo/issues/170) | add bounded local integrity and recompute audits | 3–5 hours |
| [#171](https://github.com/ven2dev/dfs-ev-demo/issues/171) | resolve source-license and Neon configuration qualification | 2–4 hours |
| [#172](https://github.com/ven2dev/dfs-ev-demo/issues/172) | prove the GCS ObjectStore adapter after owner billing approval | 3–5 hours after prerequisites |
| [#173](https://github.com/ven2dev/dfs-ev-demo/issues/173) | record the complete thin-slice go/no-go verdict | 2–3 hours |

The original ingestion <=42 s, features <=84 s, dataset <=21 s and prediction
p95 <=210 ms headroom targets remain unchanged. Absolute targets use repeated
cold/warm trials; ABBA applies only to optimization comparisons. Every miss and
blocked prerequisite remains visible. Closing this foundation is not the full
thin-slice go/no-go and does not close #52, #54 or establish population completeness.

## Gated and accepted carry-forwards

- Season-scoped lineage is conservative: deleting an earlier season can
  invalidate later features citing it even if one numerical history uses no row
  from that file. Per-row lineage is deferred.
- GCS is unimplemented and live tests remain gated on the owner's Blaze/budget/
  dedicated test-bucket/service-account decision. Never use app Firebase admin
  credentials. Upload custom `sha256` metadata, compare size+hash on HEAD and use
  `ifGenerationMatch=0` for atomic create-only uploads.
- Upstream schedule permission and actual Neon timeout remain unqualified.
  No hosted writes, Production commands, deployment or product UI are included.
- The former [step-6 proposal](feature-store-spike-step-6-plan.md) is superseded
  as a single implementation scope; it remains background for the linked issues.
