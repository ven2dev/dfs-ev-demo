# #61 follow-up: bounded latency profiling proposal

Status: owner approved 2026-10-22; initial harness committed as e3838d6, local review correction pending commit/review; nothing deployed. Separate <=2-hour child scope under #61, so profiling does not silently expand the original benchmark into application implementation.

## Design basis

- Pattern: profile the existing hot path before choosing an optimization. Preserve the atomic conditional-debit pattern and its failure guarantees while separating transport cost from contention.
- Alternatives: changing the latency target now is rejected because the measured miss requires an explicit owner decision; replacing PostgreSQL with another managed store before identifying the bottleneck adds service/secret complexity without proof; sharding a single account balance would introduce a new accounting design and is outside this scope.
- Targets: retain the original warm <=50 ms p95 target and <=35 ms headroom threshold at 20 workers. Three alternating 1,000-sample baseline/budget pairs remain the acceptance measurement. Add three diagnostic single-worker pairs of 100 samples per mode; these diagnostic samples cannot substitute for the 20-worker acceptance result.
- Work budget: <=8,020 HTTP round trips and <=16,040 explicit SQL statements, including timeout setup and bookkeeping. Planned samples: 6,000 acceptance + 600 diagnostic + 1,000 correctness + 100 collector attempts, with the remaining allowance reserved for setup, metadata, claims and cleanup. Enforce counters before any workload.
- Reasons: retain transaction-local server timeouts to prevent unbounded synthetic lock waits; keep samples synthetic and isolated to prevent app/Production data changes; fail closed after ambiguous writes to prevent duplicated provider sends; retain target-scale contention to avoid making a single-client result look like capacity proof.
- Assumptions: the same Preview project, Neon resource/iad1 mapping and included compute; no real provider calls. No independent suspend claim is needed for this warm-path profiling scope.

## Steps and estimates

1. Create a child issue after approval; owner-requested branch under the normal per-issue workflow. Prepare SQL RETURNING/timing instrumentation and validate its meaning locally, without changing the debit predicate or dropping timeout protections. 0.5 h.
2. Owner-approved commit and independent review; fresh push consent for a protected disposable Preview. Recheck exact region/target/protection and use a new expiring token with no environment-variable edits. Run the bounded comparison and record client/server timing distributions separately. 0.75 h active.
3. Remove the owned synthetic schema and exact disposable deployment, verify absence, and return a measured optimization recommendation or an explicit target decision. 0.5 h.

Estimated active total 1.75 h. Stop before 2 h if the diagnosis requires a new transport, store or accounting pattern. That design gets its own owner decision and spike. No permanent migration, Production change, rate-limit rollout, PR to main or automatic merge is authorized by this proposal.

## Resulting decision

If server-side contention dominates, propose a bounded contention/admission optimization and prove it at 20 workers before implementation. If transport dominates even for the baseline, return supported transport options and their operational tradeoffs. If the target remains unattainable under the approved hosting model, ask the owner to choose a revised requirement or hosting design; never relax it silently.

## Concrete harness and timing interpretation

Fresh base: origin/main f46d930 (#190 merged). Branch: feature/dfsEV-206-budget-latency-profile. This is a disposable branch; no PR or merge to main.

The reviewed #61 harness is carried forward into an isolated checkout. Its authorization, exact Preview hostname, iad1 guard, transaction-local 5 s statement / 2 s lock timeouts, non-replayed workload claim, unknown/active/completed activity tracking, ownership-validated idempotent cleanup and blocked ordinary API routes are retained. Dedicated schema: `bench61_206_20261022`. New local 256-bit token, only its SHA-256 digest and <24-hour expiry in source; no environment changes.

Each warm sample records client time around the complete Neon HTTP timeout+statement transaction, a materialized executor-clock interval returned by SQL, and the paired difference. The server interval includes row-lock waiting after the clock is evaluated, but excludes planning, timeout setup and commit. The residual also contains pool/proxy queueing, transaction overhead, serialization and network time. It is not pure transport. Distributions are computed from each paired difference, never by subtracting unrelated percentiles. The instrumentation adds an executor clock to the existing conditional UPDATE; predicates and atomicity are unchanged.

Three 100-sample-per-mode single-worker diagnostic pairs precede three 1,000-sample-per-mode 20-worker acceptance pairs. Mode order alternates within each group. Only the 20-worker client p95 determines the unchanged 50 ms target / 35 ms headroom result. The clocks add measurement overhead; results describe this instrumented operation and are compared honestly with the prior uninstrumented receipt, not treated as identical queries.

During each 20-worker budget trial, at most ten additional transactions sample pg_stat_activity at >=20 ms intervals. Only counts of matching synthetic-schema queries and Lock/IO/LWLock waiters leave PostgreSQL. Sampling can perturb contention and is a diagnostic, not exact per-request lock time. A zero observation does not prove absence of contention. Compare single-worker and 20-worker executor distributions alongside these snapshots. No other role privileges or settings are changed.

The workload reserves 7,900 HTTP round trips / 15,800 explicit SQL statements before starting. Its maximum successful path is 7,761 / 15,522 (including <=30 sampler transactions); setup is 2 / 10, catalog 3 / 6, cleanup 2 / 6. Total planned maximum: 7,768 / 15,544, below 8,020 / 16,040. Every generic query checks its counters before dispatch; all claims reserve against shared control-row caps. Transaction protocol BEGIN/COMMIT is implicit in the Neon HTTP transaction and not counted as explicit submitted statements. No automatic retries. Failed workers and samplers are drained before failure is returned, leaving activity unknown. Cross-request cleanup coordination is described below.

No idle/cold sample is offered by this operator page; retained internal idle regressions protect the previous fixes. Any future idle observations remain idle-first-request unless suspension is independently established.

## Initial verification (e3838d6, before coordination correction)

Passed on Node 24.18.1: 951 application tests + 294 Node tests (5 default opt-in skips), 6/6 fixed PostgreSQL integration tests, root/web typechecks, full lint including 10 import-boundary probes, and the production Turbopack build. Without opt-in all six integration tests skip without constructing a pool. Sandbox-only localhost listen failures cleared on the full-suite rerun with loopback enabled.

The held-lock sample recorded 90.382 ms in the executor and 93.581 ms at the local client, with a matching lock waiter observed. The full local run used exactly 7,761 round trips / 15,522 explicit SQL statements. Receipt: `docs/evidence/206-profile/local-receipt.json`. These client measurements use a local pg adapter, not Neon HTTP, and cannot resolve the hosted bottleneck or clear the 50 ms hosted gate.

Fixed opt-in fixture: PostgreSQL 18.6, 512 MiB, 127.0.0.1:54361 only. The integration fixture stays at root outside web compilation and does not add pg to the web workspace. The held-lock regression validates the executor timer and wait sampler; correctness, cleanup interruptions/lost replies, ownership and activity regressions are retained.

## Review and execution gates

Stop after local validation for owner commit approval, then independent owner-run review. Fresh push approval precedes deployment. Recheck Vercel protection, runtime iad1, designated Preview hostname/resource and token expiry before setup. Only after the approved hosted run, save sanitized evidence, run owned-schema cleanup and verify absence, then remove the exact disposable deployment and verify its URL is unavailable. Permanent #61 implementation remains blocked on the missed original target.

References: PostgreSQL 18 [clock_timestamp](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) and [pg_stat_activity](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW). Installed Next.js route/proxy guides read before implementation.

## Review correction: live-run cleanup coordination (design basis)

Pattern: a fixed-duration, per-request database lease with transaction-scoped shared/exclusive fencing. Each admitted action gets a random request identity and a database-clock expiry of 300 seconds, matching the function duration cap. Every workload transaction acquires the same shared advisory lock and checks the exact owner/request identity and unexpired lease before running its measured statement. Cleanup tries the exclusive form of that lock without queueing (refusing any in-flight transaction immediately), validates ownership and refuses a live lease before changing activity or dropping anything. The lock is scoped to this experiment's fixed pair of integer keys, not an application account lock. The nonblocking cleanup attempt avoids introducing an exclusive-lock queue into live benchmark timings.

Alternatives: process-local busy flags do not coordinate Vercel instances; checking only active_action makes abandoned runs permanently block cleanup; expiry without a transaction fence allows an in-flight or resumed writer to overlap a drop. A long transaction around the entire benchmark would require a persistent connection and change the HTTP request experiment, so it is rejected. We follow the lease/fencing pattern without a new service or production schema.

Reasons: the shared lock stays held until the measured transaction commits/rolls back, preventing teardown of an admitted in-flight transaction; the per-request check rejects later transactions after lease expiry or ownership change, preventing a paused process from resuming after cleanup. A failed/abandoned action retains its lease until the original 300-second expiry, after which cleanup can recover; there is no heartbeat extension or automatic retry. Successful completion clears the lease. Cleanup remains idempotent and revalidates ownership under its exclusive fence on every retry. Failed or ambiguous work leaves idle eligibility unknown.

Targets/assumptions: unchanged 20 workers, 50 ms p95, 35 ms headroom, 8,020 round trips and 16,040 explicit submitted SQL statements; fixed PostgreSQL 18.6/512 MiB local fixture. The guard is folded into the existing timeout-setup SELECT, so two submitted statements / one HTTP round trip remain per workload transaction. It adds one control-row check plus a shared advisory lock per transaction to both modes, included in client elapsed/residual and excluded from the executor interval; that overhead will be disclosed rather than called pure transport. One additional setup CREATE FUNCTION statement increases setup to 10 statements and total maximum to 15,544; no production assets or package boundaries change.

Validation before correction commit: overlap a paused run with a separate cleanup request; reject cleanup with lease and activity unchanged; resume and complete the run; clean up successfully. Simulate abandoned expiry, retain an in-flight fenced transaction, reject teardown while it is held, then permit teardown after it drains; reject a late transaction from the expired identity. Retain prior ownership, interruption, lost-response, idle-state and workload-count regressions. Owner review repeats before any push/deploy.

### Correction verification

Local correction: 9/9 PostgreSQL regressions passed, including the three overlapping-request/expiry tests; 4/4 access-control tests passed. Full application suite: 951 passing, 9 opt-in skips; Node suite: 294 passing. Typecheck, full lint (including all 10 import-boundary probes), production build and whitespace checks passed. The opt-in suite skips all nine tests without constructing a pool when BENCH61_LOCAL_TEST is absent. No source outside the disposable web harness and its root fixture/documentation/evidence changed; no dependency, lockfile, database-package, pipeline or CI edits.

Updated receipt: `docs/evidence/206-profile/local-coordination-receipt.json`; initial receipt retained separately. Workload count remains 7,761 round trips / 15,522 submitted statements; planned total with setup, catalog and cleanup is 7,768 / 15,544. The guard introduces internal PostgreSQL work (one control-row read and shared fence per workload transaction), despite leaving the submitted-statement count unchanged. The revised client timings include it; do not compare them to the original unguarded hosted timings as if the operations were identical. The hosted 50 ms gate remains failed/unresolved.

Failed/abandoned operation procedure: do not retry the workload. Retry cleanup after the original five-minute lease deadline (or after successful completion); an in-flight guarded transaction causes immediate cleanup refusal without queueing behind it. After it drains, retry cleanup, which revalidates owner and absence under the exclusive fence. New work from an expired request fails before its measured statement. No lease is forcibly expired by the production handler; only fixed local tests advance that state to avoid five-minute test waits.

Repeat review is required against e3838d6 plus this uncommitted correction. Commit, push and deployment remain separate owner gates. This correction does not grant push or deployment consent.
