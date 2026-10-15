# #118 independent review handoff

## Boundary and review base

This is a review map, not an independent approval. #118 implements local,
versioned QB passing-yards training reads and durable evidence retention. It
does not qualify real sources or a complete population, authorize model fitting,
or clear the hosted rollout gate. #106, #107 and #95 remain separate dependencies.

The implementation checkpoint is `9cf2a8f5a3793976ee427ad809baa657c65a4f9f` on
`feature/dfsEV-118-training-reads-retention`. At preparation, remote main is
`716d7559f6b3d402b098810efa5e6646f99e6709`. Review the complete branch against
that base, including consumed #106 changes. For the latest training-only
increment, `dae2940..9cf2a8f` isolates invalidation, deadlines and capacity work;
it is not a substitute for reviewing the earlier training readers and pins.
Tie the final disposition to the actual final candidate SHA, not this document's
checkpoint. Main/integration changes need an affected review.

Ordered **0001–0020 is frozen**. #118 owns 0012, 0014, 0016, 0019 and 0020;
0013, 0015, 0017 and 0018 are consumed #106 source/codec dependencies. No later
migration was allocated at that checkpoint. The current
[review-fix plan](predictive-training-review-fixes.md) records the shared-foundation
exception, findings and subsequent migration allocation. Review migration/catalog pairs, manifest generation,
readiness contracts and application consumers together. Do not rewrite a frozen
migration to address a finding.

## Policy and implementation map

| Boundary | Main implementation | Evidence to assess |
| --- | --- | --- |
| Versions, three-season history, distinct feature/label clocks and run-wide event exclusion | [training.ts](../src/lib/predictive/training.ts), [trainingSql.ts](../src/lib/predictive/trainingSql.ts), 0014 | Unsupported versions, forged clocks/history, inclusive boundaries, missing slots and split overlap refusals |
| Guarded evidence batching and exact byte verification | [batchEvidence.ts](../src/lib/predictive/batchEvidence.ts), [persistence.ts](../src/lib/predictive/persistence.ts), 0012 | Rights before every unique file, complete visible correction chains, direct SQL revocation/deletion races, damaged files and failed guard cleanup |
| Immutable selection, assigned shards and numerical pages | [trainingRuns.ts](../src/lib/predictive/trainingRuns.ts), [trainingShards.ts](../src/lib/predictive/trainingShards.ts), [trainingReads.ts](../src/lib/predictive/trainingReads.ts), 0014/0016 | A later correction/publication never changes fixed membership; one response row still verifies the complete assigned shard; missing and unusable states remain explicit |
| Current/historical label heads and outcome separation | [trainingReads.ts](../src/lib/predictive/trainingReads.ts), [persistence.ts](../src/lib/predictive/persistence.ts) | Exact label identity, head selection before provider filtering, supersession clocks, no fabricated zero or future outcome |
| Pins, quotas, original expiry and mandatory deletion | [trainingDatasets.ts](../src/lib/predictive/trainingDatasets.ts), 0016 and 0018 retention integration | Execute-only restricted roles, atomic sealing/pin rollback, independent release, 90-day boundary, lineage closure and restored-history deletion parity |
| Complete-run reconciliation | [trainingReadiness.ts](../src/lib/predictive/trainingReadiness.ts), [persistence.ts](../src/lib/predictive/persistence.ts) | All assigned datasets counted, all protected uses authorized, no successful subset or durable readiness certificate |
| Audited invalidation | [trainingInvalidation.ts](../src/lib/predictive/trainingInvalidation.ts), 0019 | Narrow diagnostic vocabulary, database-confirmed versus reader-reported provenance, immutable digest address after deletion, no automatic permanent denial after repair |
| Deadline/cancellation and retry | [trainingOperation.ts](../src/lib/predictive/trainingOperation.ts), [persistence.ts](../src/lib/predictive/persistence.ts) | Exact-backend same-login cancellation, interrupted connection replacement, draining cleanup, rollback before commit and idempotent retry after unknown commit |
| Transaction-local SQL reuse | [0020](../db/migrations/0020_predictive_training_validation_memo.sql), [trainingValidation.test.ts](../tests/db/trainingValidation.test.ts) | Private owner-created state, all 36 evidence locks, same-transaction write refusal, exact cutoff/version keys, rights epochs and scheduled expiry, unchanged answers versus released kernels |

The PostgreSQL regressions are chiefly in
[sourceClaims.test.ts](../tests/db/sourceClaims.test.ts). They include restricted
logins and direct SQL writers; pure tests alone cannot establish these boundaries.
[trainingValidation.test.ts](../tests/db/trainingValidation.test.ts) separately
tests upgrade rollback, original-record parity and memo bypass attempts.
Review independently specified numerical and temporal expectations, not just
agreement between two code paths sharing a builder.

A committed guarded training read leaves an empty PostgreSQL TEMP namespace.
Catalog/migration administration must use a **fresh administrative connection**;
the strict catalog refusal remains. Reusable training sessions are supported;
interrupted sessions must be replaced. Future tables or clock-sensitive policies
need forward changes to the guard/dependency set and memo keys.

## Outstanding finish gates

- Follow the [revised capacity plan](predictive-training-capacity-plan.md):
  nested run-read/aggregation profiling, serialized client submissions,
  reduced duplicate inspection/access work and repeated completion within 70%
  of each deadline (30% headroom).
  Withdraw the per-node closure prototype from planned promotion; keep the
  original set-based closure unless inventory scaling evidence supports change.
- Independent review of the complete training implementation and consumed
  source/codec boundaries, with findings resolved and a written disposition.
- Representative capacity evidence and reviewed operating guidance: row width,
  full 16-slot history, opponent context and provider file sizes are separate
  dimensions. Configured ceilings are not demonstrated capacity.
- A green final aggregate database gate/remote CI tied to the final integrated
  candidate. The prefix20 run passed 230 PostgreSQL cases; four fixture/version
  failures were corrected and passed focused rechecks, but the aggregate command
  has not yet been rerun green. Do not report those runs as a green aggregate.

Use the [capacity report](predictive-training-capacity.md),
[retained validation evidence](predictive-training-evidence.md) and
[API handoff](predictive-training-handoff.md) for exact scopes, results and logs.
Capacity measurements are warm local samples through non-superuser APIs, with
synthetic population evidence and explicit missing future-target labels.
No usable real QB training dataset or validated #54 Part B result is claimed.

The latest wider-inventory checkpoint records no successful numerical page or
current-label read, including at width1 in the 64-QB/eight-profile inventory.
The guarded width16 SQL label probe itself takes 14.808 s; byte-backed one-member
preparation also issues 3,645 statements. Assess both SQL validation and fresh
metadata/access work before accepting larger-workload readiness. A pg concurrent
query deprecation warning is reproduced with four distinct features without
benchmark instrumentation and traced to parallel before-file rights checks.
The common executor needs a strict no-overlap repair and interruption/draining
regressions; the current trace does not claim that repair is implemented.
