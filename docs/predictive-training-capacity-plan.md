# #118 next iteration: profile the training read path

This plan supersedes the closure-first next step at `0724027`. The owner accepted
that checkpoint's reporting, not training capacity. #118 and #54 Part B remain
incomplete/blocked. The next unit is the existing QB training read path: identify
and remove repeated validation/access work without changing selected evidence,
cutoffs, rights, numerical outputs, retention or operation deadlines.

## Priority and evidence

The per-node closure prototype introduced a measured regression, but removing
it would recover about one second of a roughly 30-second operation. It cannot
meet the next preparation target of 21 seconds by itself. The original
full-table-scan concern was an unmeasured scaling concern, not evidence that
closure was the current bottleneck.

The [paired record](evidence/predictive-training-capacity64-interleaved-review-drafts-2026-10-14.json)
identifies these higher-priority candidates in the two draft width16 dataset
preparations:

| Query group | Calls per preparation | Recorded client time | Investigation |
| --- | ---: | ---: | --- |
| `predictive_training_run_read` | 1 | 6.820–6.830 s | Profile nested consumer checks, reconstruction and rights work |
| Coalesced `jsonb_agg` group, fingerprint `1abc1bdabebc…` | 4 | 5.223–5.454 s total | Capture the full parameterized statement and profile each constituent call |
| `predictive_read_compressed_inspections` | 1,043 | 2.892–3.176 s total | Map duplicate capture sets and callback fan-out before proposing a bounded access batch |
| Protected-use rights authorization | 322 | 2.288–2.399 s total | Map repeated use sets to actual before-file and delivery boundaries |
| `predictive_prepare_training_dataset`, including closure | 1 | 1.833–3.272 s | Secondary investigation; do not make closure the capacity strategy |

The heavy aggregation preview contains `predictive_source_decision_plan` calls;
it is not sufficient to attribute the batch to publication reads. Nested plans
must identify the actual functions and relations. Summed client SQL timings
are 26.547/26.929 seconds, but include queue wait and possible overlap. They are
priority signals, not a disjoint server-CPU breakdown. Existing evidence already
supports a reproducible one-row slowdown; another complete matrix is not needed
to rediscover it.

## Ordered work and finish boundaries

1. **Locate and prevent overlapping client submissions.** Preserve parallel
   evidence branches/coalescing, but make the common database executor submit
   only one query at a time. Include direct access checks as well as batched
   metadata. Test that errors drain pending work, cancellation retires the
   connection, queued work cannot run after retirement, and rollback/commit
   cannot escape unfinished branches. Do not use pg private queue internals or
   enable pipelining to hide the warning. This is driver compatibility work,
   not a claim of capacity improvement.
2. **Profile before changing validation SQL.** Use a disposable service only,
   with nested `auto_explain` or `pg_stat_statements.track = all` if available.
   Configure profiling through administrative setup; API calls retain their
   restricted roles and normal deadlines. Record extension/configuration,
   complete statement fingerprints, nested calls, plans, rows, buffers and
   repeated request identities. Redact parameter values; the fixture is
   synthetic. Separate instrumented diagnostic times from uninstrumented
   capacity measurements. Profile `predictive_training_run_read` and the four
   aggregation batches first. Do not assume JSON aggregation itself is costly
   before examining the functions inside it.
3. **Implement one measured optimization.** Choose the largest avoidable cost
   from that profile. Reuse immutable validation only under the existing guard
   and exact evidence/version/cutoff/rights-epoch keys. Consider grouping
   identical inspection/access obligations and bounded capture/use arrays;
   fresh current authorization still runs before each unique file and at
   delivery. Every dataset's checks must remain chained. Do not remove full
   lineage checks, silently narrow a population, cache current permission, or
   bypass final direct-SQL validation to reduce counts. Record before/after
   nested work and client calls, not just a faster wall time.
4. **Verify behavior, then capacity with headroom.** Run affected Node and
   PostgreSQL cases for the actual change, including rights boundaries,
   deletion, corrupted files, exact historical replay and interruption recovery.
   Only then repeat the applicable interleaved API measurements. A failed
   experiment is retained with its reason; it does not trigger an unchanged
   full gate or another broad rewrite.

The first deliverable is a nested profile and one chosen optimization with its
affected regressions. A successful closure microbenchmark, one successful
dataset preparation or a larger timeout cannot satisfy that boundary. No new
calendar estimate is asserted before profiling.

## Closure and migration disposition

Keep the released set-based closure as the planned implementation. Withdraw
the per-node rewrite from promotion; retaining the measured kickoff indexes is
the intended reduced 0023 scope. The present proposal file remains unchanged
as a recorded experiment until that reduced candidate is prepared and its
tests reconciled. Do not describe this draft as an accepted scaling fix.

A future closure replacement needs exact closure/protected-use/retention parity
and measured growth at 64, 256 and 1,024 QBs, with selected dataset width held
constant as the unrelated evidence inventory grows. Compare the original
set-based implementation; a set-based indexed alternative is optional only if
those measurements justify it. This scaling experiment is not a prerequisite
to profiling the present bottleneck.

Frozen 0001–0020 remain unchanged. #106 owns 0021; #118's 0022–0024 remain drafts
until the frozen 0021 checkpoint is integrated. Any new context tables used by
validation must enter guard/memo dependencies through forward DDL and coverage
tests. No new migration number is allocated by this plan. Profiling and the
application query executor work can proceed while 0021 is pending. Finalize any
SQL optimization only after coordinating its slot and integrating that prefix.

## Capacity acceptance with variation

Use **70% of the unchanged deadline** as the working acceptance target for
reviewed workloads: at most 7 seconds for a 10-second read and 21 seconds for a
30-second preparation. This is a target, not demonstrated capacity or a reason
to raise a deadline. Include the normal operation's complete guard, rights,
bytes, decoding and delivery work; exclude fixture setup only.

Require at least two candidate repetitions interleaved with the pinned baseline
on the same seed snapshots. Every required candidate call must complete with
that headroom; report all values, worst duration, refusals and query/work counts.
Do not average away a refusal or discard a slower sample. Baseline failures
remain visible but do not require the old implementation to pass. A diagnostic
comparison that expects refusals remains separate from the capacity gate.

Start optimization feedback at selected widths 1/16 in the existing 64-QB,
eight-profile inventory. That does not clear width64, full 16-slot history,
opponent context or representative provider file sizes. Supported workloads
and operating limits need explicit review before #118 closes. The full aggregate
database gate runs on the final integrated candidate, once affected checks and
the agreed capacity workloads pass; repeat it only for later affected changes.

## pg warning: located before optimization

The installed driver is pg 8.23.1. Its warning was reproduced with four distinct
synthetic QB features using `seedCapacity(..., 4, { guardedRecording: true })`,
`prepareFittingRun` and `prepareDataset` on frozen prefix20. The direct
administrative harness client had no benchmark proxy; this probe establishes
the call site, not role security. With `NODE_OPTIONS=--trace-deprecation`,
the stack is:

```text
Client.query (pg/lib/client.js:780)
query (src/lib/predictive/persistence.ts:146)
batchAccess (src/lib/predictive/persistence.ts:1244)
batchAccess (src/lib/predictive/persistence.ts:1410)
readBytes (src/lib/predictive/persistence.ts:210)
verifySourceConsumer (src/lib/predictive/persistence.ts:1193)
```

`verifyConsumerBatch` starts independent consumers with `Promise.allSettled`.
Their before-file access checks call the direct query executor, outside the
metadata batch's single-statement flush. The trace confirms that overlapping
submissions occur in the store, not solely in benchmark instrumentation. The
trace probe passed in 6.29 seconds and is diagnosis, not a capacity result or
a driver fix. The existing shared-body 1/16/64 regression also passed in
19.64 seconds without emitting the warning; shared reconstruction alone does
not cover distinct-consumer submissions. Keep the distinct-feature probe as an
opt-in diagnostic, and add a strict no-overlap assertion with the executor fix.

Reproduce the diagnostic on an owned disposable service with Node 24:

```sh
NODE_OPTIONS=--trace-deprecation TEST_DATABASE_URL='postgresql://dfs_ev_test:dfs_ev_test@[::1]:54329/dfs_ev_test' node node_modules/vitest/vitest.mjs run --config vitest.training-query-trace.config.mts
```

Working logs: `/private/tmp/dfs118-distinct-query-warning-trace.log` and
`/private/tmp/dfs118-query-warning-trace.log`. The committed opt-in command also
reproduces the same stack and passes in 4.99 seconds; its working log is
`/private/tmp/dfs118-final-query-trace.log`. Typecheck, affected ESLint, document
links and whitespace checks pass. No new full benchmark, aggregate
gate, application change or SQL change is claimed by this planning checkpoint.

## Executor repair

The common store executor now serializes direct and batched statements through
one promise queue. Each queued submission retains its original operation clock
and checks connection retirement after waiting. ROLLBACK drains the same queue;
an interrupted connection still requires replacement. Independent verification
branches and metadata coalescing remain enabled. This changes submission order,
not the rights, cutoff, reconstruction or numerical rules.

A restricted-login regression seeds four distinct features, rejects overlapping
submissions, and injects an actual division-by-zero SQL failure while sibling
verification branches are pending. It verifies rollback, no dataset publication,
zero remaining statements, and recovery to independently expected feature values
with explicit missing labels. Five affected SQL/file cancellation, deadline,
partial-pin rollback and chained compressed-access regressions also pass. Eleven
focused Node cases, six report-contract cases, typecheck and affected lint pass.
These checks establish executor behavior, not training capacity.

The opt-in `vitest.training-profile.config.mts` profiles nested `auto_explain`
statements on an owned disposable prefix20 database. Administrative setup enables
instrumentation for a restricted login; measured APIs keep their ordinary
deadlines. Four-player smoke profiling passes. Larger-inventory profiling and
the resulting optimization evidence are recorded separately from capacity gates.

The [nested diagnosis and witness experiment](predictive-training-nested-profile.md)
now retain the 64-QB profile and test one concrete optimization: reconstruct an
unfiltered witness population once per guarded scope/cutoff/rights epoch, then
derive exact entity views. The expanded parity regression passes, as does the
four-QB interleaved smoke comparison. Two larger comparison attempts stopped
during setup, so no 64-QB speed improvement or capacity pass is claimed. The
unnumbered SQL remains an experiment outside the ordered migration chain.
