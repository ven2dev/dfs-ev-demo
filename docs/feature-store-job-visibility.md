# Producer completion and point-in-time visibility (#241)

The owner approved the [measured roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/241#issuecomment-6713355392).
Implementation is proposal-only, in four reviewed steps. Step 1 supplies the
shared completion relation and repairs the existing derived display reader.
Dataset/#163, normalized/producer selection and final qualification follow in
separate steps. Existing #231 authorization stays in its current owner.

## Design basis

**Pattern.** Shared relational temporal eligibility composed into existing
set-based selectors. Successful producer completion by the caller's boundary
is an additional condition before ranking; insertion clocks alone do not prove
that a row was usable then. One invoker-rights SQL relation owns that condition.
Callers keep their versions, natural-key ordering, requested clocks, fallback,
current freshness and current rights/status checks.

**Alternatives.** Copying completion predicates across readers repeats the drift
this inventory found. Scalar PL/pgSQL verification hides per-example work.
Application-side filtering acts after ineligible heads or lineage have already
affected selection. New publication clocks or rewritten stored timestamps change
the accepted temporal contract. PostgreSQL commit timestamps would require the
server-start `track_commit_timestamp` setting/restart, have unverified hosted
availability and truncatable history, and add a second clock beside #231's
`finished_at`. Passing observation time as a bound parameter instead needs an
extra statement or an application clock, breaking the one-statement or database
clock contract.

**Targets.** The real fixture remains the retained 16 files from seasons
2021–2025, with 2,504 retrospective examples and zero strict historical examples.
Display and normalized reads each use one SQL statement. A new producer and a
dataset build each use eight; dataset builds keep two rights checks. Dataset
delivery stays at three statements/two checks/one GET. Direct #163 reads keep
three statements/two checks at every n=2–16, with exactly 2P rights calls for the
independently derived profile scope. #231 controls remain three/two/one and
model-only reads two statements. Reader coordination locks and per-example
queries/verification remain absent. Automatic SELECT AccessShareLock is expected.

Opt-in speed gates remain <=84 s for the full-season producer under 120 s,
<=21 s for dataset build under 30 s, and each #163 cohort's p95 <=210 ms under
300 ms, preserving at least 30% deadline headroom. CI enforces work counts and
buffer/plan bounds, with no wall-clock assertion.

**Requirement reasons.**

| Requirement | Risk prevented |
| --- | --- |
| Filter successful completion before visible-head/last-valid ranking. | Running, failed or later-completed revisions can hide permitted historical values. |
| Share the completion rule; let each caller supply its own boundary. | Policy drift or conflating source checkpoints, request knowledge and current observation time. |
| Keep current freshness separate from pinned values and current rights/status. | Leaking later values or retaining legally withdrawn data through fallback. |
| Prove inlining, work counts and pinned buffer/plan ceilings. | Hidden per-example calls or gradual growth in accepted relational work. |
| Use real DB clocks and retain previous evidence unchanged. | Fabricated temporal eligibility or erased qualification failures. |
| Proposal SQL and workspace package exports only. | Premature migration rollout or cross-package private imports. |
| Stop on a new 53100, gate miss or the 8.5-hour cap. | Concealing resource failures, relaxed targets or unreviewed scope growth. |

**Assumptions.** Trusted atomic pipeline producers, private ObjectStore, research
use, Node 24 and local PostgreSQL 18.6. Current deletion/pruning and rights still
override historical retention. This feature does not claim hosted latency or
historical recovery of deleted rows. Current successful status and `finished_at`
are the existing job contract; no new temporal clock is introduced.

`finished_at` is stamped by the terminal UPDATE before COMMIT. A request pinned
between those operations can see the old revision before COMMIT and the new one
after COMMIT with the same timestamp. The disposable probe measured this window;
it remains the accepted limitation shared with #231, not a commit-time guarantee.

## Step 1: shared policy and derived display

Apply `@dfs-ev/db/assets/241_job_visibility.sql` after the #138 proposal in the
registered local fixture. The test harness installs it transactionally. No
ordered migration or frozen SQL changes.

`fs138.completed_jobs_at(timestamptz)` returns job IDs whose current status is
successful and whose `finished_at` is at or before the supplied boundary.
PUBLIC has no execute grant; the existing trusted reader and pipeline-writer
roles have execute permission and retain their existing table privileges.
The relation runs with invoker rights and introduces no definer privilege.

`readLastValidFeature` and `readLastValidLabel` keep their existing shared query
shape and one-statement budget. They join this relation at `knownAsOf` before
building the visible, head and valid sets. Running/failed revisions are absent
from those sets; a completed unavailable head retains the earlier usable value
with stale/superseded flags. A later usable correction retains the existing
corrected-value display reason. Correction-link writes are unchanged.

The SQL relation deliberately has no function-level SET clause so PostgreSQL
can inline it. Current-clock callers in later steps use the captured clock
column in a lateral relation; a scalar subquery argument prevents SQL SRF
inlining. This relation performs timestamp comparison only and emits no
session-dependent timestamp JSON.

Step-1 validation passes on Node 24.18.1 and the loopback PostgreSQL 18.6
fixture: the nine new completion/display checks and nine existing derived
checks (20 Node test results including their two parent tests), typecheck,
lint, eleven import-boundary checks and the existing derived unit test.
The eight feature/label × n=2/16 × evidence-mode plans execute the visible
relation once with two revisions, with no helper Function Scan, LockRows or
relation lock held after the read. This is behavior/work proof; final speed
qualification remains step 4. Exact records, source SHA-256 and Git blob IDs
are retained in [the step-1 evidence folder](evidence/feature-store-241/README.md).

## Qualification carried from the disposable proof

Eleven behavior/scope checks and eighteen #166/#231 controls pass. Six candidate
dataset builds use eight statements/two checks, worst 804.299 ms (97.319%
headroom under 30 s). The six #163 candidate p95s are 26.746/25.587/23.880 ms
cold-connection and 7.543/8.658/8.613 ms warm; all 600 requests succeed at three
statements/two checks. Cold includes connection setup, not a fresh process or
flushed caches. Twenty-two primitive checks and thirteen plans prove work and
inlining, including correction branches with nonzero rows.

All four fixed-version producer samples pass in 8.085–8.607 s at eight statements.
The owner accepts those samples while retaining the final baseline's 53100
(job `58f0fc66-5405-4b9b-af29-380ca3a63e9c`) as a comparison resource failure,
not a replaced, retried or counted success. No complete ABBA claim is made.
The old 668.225666 ms query remains unexplained and retained by owner decision.
Post-completion fixture content matches historical hashes, but old pins lack a
complete finish-clock inventory; universal historical non-impact is unproved.

The added checks cost relational work: candidate context execution/hits rose
from 2,432.989 ms/771,335 to 3,944.134 ms/1,454,495 in the diagnostic pair.
The query still inlines, and full-operation targets pass. This is not a speedup
claim. The approved CI ceilings are ceil(candidate hits × 1.20):

| Scope | Measured candidate hits | CI ceiling |
| --- | ---: | ---: |
| Producer context root | 1,454,495 | 1,745,394 |
| Dataset selection root | 8,624 | 10,349 |
| Dataset current_jobs | 2 | 3 |
| Dataset current_f | 2,658 maximum | 3,190 |
| Dataset current_l | 687 maximum | 825 |

Each named root/subtree caps both hits and hits+reads independently; inclusive
ancestor/descendant counters are not summed. Dataset current jobs and both heads
execute once with rows>0, and producer histories/gaps execute once. No helper
Function Scan or explicit reader LockRows node is allowed, preventing a policy
refactor from hiding per-row procedural work. These live SQL CI gates land with
the corresponding dataset and producer steps on a pinned work fixture.

Disk telemetry measured 224 MiB WAL even after CHECKPOINT while max_wal_size is
1 GB above the 512 MiB tmpfs. The failed comparison's peak sampled usage was
97.35%. One-second, non-atomic samples cannot reconstruct the exact exhausted
allocation. The later reader/plan gates pass with unchanged settings. Disk sizing
is a separate issue; this feature changes no server setting or resource size.

Final-source qualification in step 4 runs four fixed-version producer samples
only against the absolute 84 s gate, citing the retained comparison and owner
exception instead of rerunning baseline. Dataset and #163 gates rerun as planned.
Any fixed-version 53100 or gate miss stops and retains its samples. Disposable
results qualify the design, not the final permanent sources. Selected full
records and compact source-hashed receipts belong under
`docs/evidence/feature-store-241/`, audited with the existing TypeScript tool.

## Why it escaped

#138 treated insertion clocks as knowledge time; #163 added current success
without historical completion. Tests expected visibility at ingestion/computation,
atomic publication hid unfinished rows from ordinary concurrent reads, and
fixtures captured cutoffs after awaiting jobs. Replay of a pin between insertion
and completion was missing. #231 fixed its own path without a complete caller
inventory. Shared eligibility and cross-caller real-clock replay tests address
that drift. The resolver's deliberately repeated selection remains unchanged.
