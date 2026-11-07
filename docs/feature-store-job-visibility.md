# Producer completion and point-in-time visibility (#241)

The owner approved the [measured roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/241#issuecomment-6713355392).
Implementation is proposal-only, in four reviewed steps. Step 1 supplies the
shared completion relation and repairs the existing derived display reader.
Step 2 repairs dataset selection/freshness and the narrow #163 reader.
Normalized/producer selection and final qualification follow in separate steps.
Existing #231 authorization stays in its current owner.

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

The owner-approved resource tiers keep CI on the unchanged 512 MiB
`compose.test.yml`. The live producer context gate is read-only on the pinned
portable graph; existing small-cohort tests prove statement counts and aggregate
loops. Full-season materialization EXPLAIN and the producer speed benchmark are
opt-in on the existing 2 GiB `compose.feature-store-spike.yml` override. Receipts
record the actual mount size and sampled disk peak. This separation prevents
full materialization's WAL from exhausting the server shared by CI/local lanes;
CHECKPOINT alone cannot guarantee reclaimed WAL. No other PostgreSQL setting or
application target changes. The separate disk follow-up is not a #241 blocker.

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
| Keep full-season materialization outside the standard CI test glob. | WAL exhaustion can restart every backend on the shared 512 MiB server. |

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

## Step 2: dataset pins, freshness and the direct #163 reader

Dataset feature and label sets join the shared completion relation independently
at `featuresAsOf` and `labelsAsOf` before their head/last-valid ranking. One
captured database observation clock supplies one materialized current-job set
and both current-head sets. A newer completed unavailable head retains the
pinned last valid value with both stale and superseded flags; running/failed
heads and other versions/policies do not change those flags. The existing
`includeSuperseded=false` policy can exclude that retained row on rebuild.

The #163 exact-feature check uses the same relation at `knownAsOf`. A successful
job completed after the pin refuses with `feature-after-as-of`; running/failed
jobs retain `feature-unavailable`. Current freshness uses the shared relation
at the statement's database clock. The restricted reader gains only the
`finished_at` column and shared-function execute grant needed for this rule;
it still cannot read labels, normalized values or job counts. Current rights,
deletion/pruning refusals and the no-partial-delivery contract stay in place.
Neither #166 nor #231 authorization SQL changes.

The resumed step-2 validation passes seven new behavior probes, the existing
dataset/#163 suites, and 45 shared-rule/#166/#231 compatibility test results.
At every n=2–16 the direct reader uses three statements/two checks and exactly
2P effective-rights calls for the independently observed profile set. Dataset
build/delivery stay at 8 SQL/2 checks and 3 SQL/2 checks/1 GET, with zero hashes
or payload reads inside publication transactions. Typecheck, lint, eleven
import-boundary checks and five focused unit tests pass under Node 24.

All three live dataset plans (retrospective, strict and active corrections)
pass: root 8,624/10,349 hits, current_f 2,657/3,190 and current_l 686/825, each
with zero reads. Both heads execute once for 9,381 natural keys. current_jobs
executes once at 2 hits/0 reads, with a measured two-page heap and no used
index: relation-size ceiling 2. Executed unavailable corrections set all four
freshness flags without changing selected values or the 2,504-row logical hash.
Negative controls reject an extra pass and an extra page. Exact plans, catalog
page measurements and failed attempts remain durable alongside the receipt.
These are CI work/behavior checks; final speed qualification remains step 4.

## Step 3 historical implementation stop

The proposed normalized selector uses one internal relation carrying both source
and normalizer job IDs. Its legacy projection is preserved. The shared completion
relation applies to both owners before ranking: reconstruction uses the checkpoint,
strict reads use the cutoff, and strict producer context additionally uses each
request's event boundary. Producer planning reuses authoritative eligible snapshot
IDs. The canonical producer SQL definitions move from the mutable #138 proposal
into #241's proposal, avoiding two maintained copies. Correction links and
retention remain unchanged.

Six new behavior groups pass with real knowledge clocks, including separate
source/normalizer owners, all four normalized families, inclusive completion,
running/failed fallback, strict per-game fallback, one-statement normalized reads,
eight-statement producer traces and atomic rollback. Two initial assertions
mistakenly counted unrelated contexts in the shared synthetic population; their
failed attempts remain retained. The assertions now match the full player/game/
context-game tuple. Existing synthetic ingestion/derived expectations are updated
to completion eligibility without backdating job clocks.

The final-source live work run is **not qualified**. On 2026-11-07 at
22:28:53.257 UTC PostgreSQL PANICed writing `pg_wal/xlogtemp.1176876` during
the full-materialization EXPLAIN: no space left on device. It terminated all
backends and recovered. No target or resource setting changed, and the gate
was not retried. The parent telemetry connection also died before the work
record or its in-flight telemetry could be flushed; no complete plan/buffer
receipt or peak-disk claim is made for this attempt. The PostgreSQL log and
last durable boundary measurements are retained. The verified scratch database
was removed after recovery. Typecheck, lint, eleven import checks and one focused
unit test pass, but remaining DB/compatibility and final speed proof are pending.

## Step 3 resumed validation and resource tiers

After the owner changed the resource policy, the read-only producer context CI
gate passes on a freshly recreated standard container. It consumes 1,659,581
hits and zero reads against the unchanged 1,745,394 ceiling. All nine required
CTEs execute once with real rows, including 16 snapshots, 1,948 targets and
119,515 requests. Neither a shared-helper Function Scan nor LockRows appears;
negative controls reject repeated execution and excess buffers. The cost is
about 14.1% above the original 1,454,495-hit candidate diagnostic, still inside
its approved 20% allowance; the margin has not been rebased. All 103,468 selected
normalized rows match the legacy post-completion projection exactly.

The standard-container behavior run passes 28 results across the new completion,
ingestion and existing derived suites. Another 44 results pass dataset work and
behavior plus #166/#231 compatibility. This preserves one normalized statement,
eight new-producer statements at small/large cohorts, dataset 8/2 build and
3/2/1 delivery, direct-reader 2P rights calls at every n, and two-SQL model-only
reads. Actual standard mount size is 536,870,912 bytes; sampled peak across that
run is 466,530,304 bytes (444.918 MiB, 86.898%).

The full materialization plan/parity test is deliberately named
`job-visibility-producer-plan.mts`, outside the `*.check.mts` CI glob. It requires
explicit opt-in and the measured spike mount size before connecting. Run it with
Node 24 after starting Compose with both the standard file and
`compose.feature-store-spike.yml`; supply `FEATURE_STORE_241_FULL_PLAN=1` and
the measured byte count as `FEATURE_STORE_241_TMPFS_BYTES`.

On the actual 2,147,483,648-byte mount, full-season materialization/parity passes:
1,948 outputs and 31,168 snapshot links match, with histories/gaps executing once.
Sampled peak use is 538,312,704 bytes (513.375 MiB, 25.067% of that mount), above
the entire standard mount capacity. max_wal_size=1 GB, shared_buffers=128 MB and
work_mem=4 MB match the standard run. Sampling is once per second plus gate
boundaries, not an exact allocation peak. No new failure was retried or ignored.

Final producer speed qualification remains step 4: four fixed-version samples
only on the 2 GiB override, each eight statements and <=84 s under 120 s. The
retained baseline resource exception and prior stopped receipts are unchanged.
The standard fixture is restored after opt-in validation. Permanent source
identities and exact new records are appended under the #241 evidence folder.

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
claim. The producer, dataset root and feature/label-head CI ceilings remain
ceil(candidate hits × 1.20). The owner replaced only the tiny current-job
subtree's page budget after the retained step-2 stop:

| Scope | Measured candidate hits | CI ceiling |
| --- | ---: | ---: |
| Producer context root | 1,454,495 | 1,745,394 |
| Dataset selection root | 8,624 | 10,349 |
| Dataset current_jobs | 2 in the original probe | Heap pages + pages of indexes actually used; loops=1 |
| Dataset current_f | 2,658 maximum | 3,190 |
| Dataset current_l | 687 maximum | 825 |

Each named root/subtree caps both hits and hits+reads independently; inclusive
ancestor/descendant counters are not summed. Dataset current jobs and both heads
execute once with rows>0, and producer histories/gaps execute once. No helper
Function Scan or explicit reader LockRows node is allowed, preventing a policy
refactor from hiding per-row procedural work. These live SQL CI gates land with
the corresponding dataset and producer steps on a pinned work fixture.

For `current_jobs`, a 20% margin on two pages left only one page of slack and
made normal heap-layout differences into failures. Its revised bound is one
relation pass: hits+reads <= the job table's heap pages plus pages of only the
index(es) used by that subtree, with Actual Loops=1. The observer reads
`pg_relation_size` and `pg_class.relpages` after ANALYZE in the same transaction
as EXPLAIN and records physical/analyzed page counts, used indexes and measured
hits/reads alongside the computed ceiling. Unused indexes supply no slack.
This changes only that node; root/current_f/current_l keep their fixed ceilings
to prevent overall cost growth. Setup/observer SQL is outside product work
counts and timings, and performs the plan under the existing reader role.

The portable CI fixture replays each producer's lifecycle: insert its running
job, then in its publication transaction insert its outputs, ANALYZE, terminal
UPDATE and COMMIT. It supplies fresh clocks through the ordinary triggers; no
clock trigger is disabled. A pinned, hash-checked 5,003,909-byte gzip is committed
for this real relational graph so CI needs no workstation ObjectStore or
downloads. The owner accepted this fixture size; the final PR body will call it
out. It reproduces the sixteen-file graph, 9,381 natural keys and 2,504
retrospective/zero strict rows, not historical clock visibility.

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
