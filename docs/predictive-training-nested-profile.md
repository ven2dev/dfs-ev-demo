# #118 nested read diagnosis and witness population experiment

This iteration follows the accepted [capacity plan](predictive-training-capacity-plan.md).
It fixes overlapping client submissions, profiles the released SQL, and tests
one measured source of repeated work. It does not qualify real evidence or
complete #118. The ordered migration chain remains frozen at 0001–0020;
#106's 0021 is still pending and #118's 0022–0024 remain proposals.

## Nested diagnosis

The [retained prefix20 profile](evidence/predictive-training-nested-profile64-prefix20-2026-10-14.json)
uses 64 synthetic QBs across eight source profiles, selecting 16 distinct
features with one history slot and no opponent context. Labels are missing for
those target games. A restricted login runs the actual APIs on fresh connections.
Administrative setup enables PostgreSQL 18.6 `auto_explain`, nested plans,
analysis and buffers, a 10 ms logging threshold, and per-node timing disabled.
Bind-parameter logging is disabled; plans still contain synthetic fixture
constants. The normal 10/30-second API deadlines remain in effect.

The profile records 354 nested plans. The artifact groups them by exact query
text and phase, retaining counts, inclusive durations and each group's slowest
plan. It also retains every top-level statement/fingerprint, source/migration
hashes and the raw working-log hash. Nested durations overlap and must not be
summed as disjoint CPU time. Sub-threshold calls are absent. Instrumentation
changes timing; these measurements are diagnosis, not a capacity gate.

| Instrumented operation | Wall time | Important nested work |
| --- | ---: | --- |
| Read fitting run | 5.514 s | 16 full-population witness calls: 4.707 s inclusive |
| Prepare dataset | 24.068 s | Run read: 5.679 s; four decision-plan batches: 4.696 s; final SQL preparation: 2.166 s |

The heavy `jsonb_agg` group executes `predictive_source_decision_plan`; its
aggregation is not established as the bottleneck. Each filtered witness request
first validates **all** visible source lineages, then filters to requested
entities. Different entity filters therefore repeat the same population work.
An example nested rights plan loops over 64 bindings and their dependency arrays,
touching 6,211 shared blocks while checking the same context profile repeatedly.
Historical plan checks also repeat across distinct witness requests.

Application access fan-out remains measurable: dataset preparation submits
1,051 direct compressed-inspection rechecks and 326 protected-use authorization
queries. This experiment leaves those checks intact. It targets population
reconstruction first; a reduced number of client calls is not claimed.

## Chosen experiment

[The unnumbered proposal](../db/proposals/training_witness_population.sql) calls
the existing unfiltered witness kernel once per profile scope, cutoff and rights
epoch, then derives the requested entity view. It uses the existing owner-created,
bounded transaction-local memo only under the complete evidence guard. It does
not persist a new witness, change evidence selection, skip a lineage or cache
current file-access permission. No additional migration number is allocated.

The projection preserves head ordering, historical destinations on unresolved
lineages, known-destination filtering, missing-entity suppression by unresolved
evidence, scope-wide refusal reasons and the original evidence digest. Request
validation and future-clock refusal run before cache lookup. A changed rights
epoch produces a new population; missing locks or a write-capable lock disable
reuse through the released memo guard.

The mandatory regression compares every result with the unchanged kernel. It
covers CSV and gzip, one/multiple/all/missing entities, historical cutoffs,
known-destination stale bindings, unresolved corrected source rows, preserved
earlier history, profile/cutoff isolation in the same transaction, scheduled
context-rights expiry, a same-transaction rights write, malformed inputs and
future clocks. Restricted-role fitting-run, dataset and page reads return
independently expected yardage and explicit missing labels. Function ownership,
ACLs, volatility, security settings and configuration remain unchanged.

## Comparison boundary

The opt-in `vitest.training-witness-capacity.config.mts` compares the serialized
current application on prefix20 with that same application plus only the
witness-population proposal. It seeds once, prepares run inventories once, then
clones the same rows in baseline/candidate/candidate/baseline order. Each API
gets a fresh restricted connection. Widths 1/16 use the 64-QB inventory;
four-QB mode is only a smoke test. Returned page rows must agree across modes
and with fixture values; no file may be read twice within one successful API.

It retains every refusal and uses the unchanged deadlines. Candidate operations
must complete within 7 seconds for reads and 21 seconds for preparation to meet
this iteration's headroom target. This isolates one optimization: it excludes
the 0022–0024 review drafts, #106's pending context recorder, full history,
opponent context, usable labels and whole-run readiness. It cannot clear the
final combined capacity or aggregate database gates.

The four-QB smoke comparison passes all 12 calls. Baseline/candidate preparation
times are 734/735 ms versus 676/636 ms; these tiny-fixture values are not evidence
of 64-QB readiness. The first 64-QB attempt failed during decision seeding with
`Query read timeout`, before any measured call. A single otherwise-idle retry
then hit the benchmark's unchanged 900-second test deadline before emitting
seed progress or workload measurements (the runner reported 1,760.59 seconds
elapsed). No cause for that discrepancy is established. Neither attempt supplies
before/after capacity evidence; do not infer a larger-workload improvement.
Working logs are `/private/tmp/dfs118-witness-capacity64-setup-refusal.log` and
`/private/tmp/dfs118-witness-capacity64.log`.

Focused validation passes the expanded population parity case (24.14 seconds),
the strict serialization SQL case, five affected cancellation/deadline/access
regressions, eleven Node cases and six report-contract cases. Typecheck, affected
lint, local document links and whitespace checks pass. The larger profile and
small comparison are opt-in diagnostics, not required correctness cases. The
two new correctness cases are in the mandatory DB report contract. No aggregate
database gate was repeated and no ordered migration/catalog artifact changed.

Next: inspect the benchmark startup/setup failure, then collect the same-snapshot
64-QB comparison without increasing timeouts. Promote no SQL optimization until
its capacity evidence and independent review support it. Integrate #106's frozen
0021 when supplied, reconcile guard/dependency inventories and reduced 0023,
then run final combined capacity and the aggregate database gate.
