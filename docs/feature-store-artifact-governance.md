# Model artifact governance (#166)

Steps 1–4 implement the proposal lifecycle, source/explicit-dataset deletion
APIs, guarded artifact-read/calculation boundary and mandatory artifact cleanup,
with retained-fixture benchmarking and integrated acceptance evidence.
Apply `packages/db/proposals/166_artifact_governance.sql` after the #138
foundation/governance proposals, #163 effective rights and #165 model manifests
in a registered local scratch database. This is proposal SQL, without a frozen
migration or hosted rollout.

## Design basis

**Pattern.** Extend lineage-driven logical invalidation followed by the existing
grace-delayed, resumable deletion queue. Dataset pins define dependency; address
sharing defines physical retention. Writer transitions use the established
source → dataset → run → sorted address lock order. Delivery will authorize
before access and revalidate before returning a trusted callback's result.
The [owner-approved roadmap and spike](https://github.com/ven2dev/dfs-ev-demo/issues/166#issuecomment-6551190046)
select this pattern; there is no new provenance graph, event table or queue.

**Alternatives.** Reader coordination locks/transactions across I/O would block
invalidation during reads; two fresh SQL snapshots avoid those long holds.
Immediate deletion would bypass grace and race reads; logical invalidation
precedes removal. A per-example evidence graph duplicates existing lineage and
repeats the retired training-read design. Resurrection by clearing tombstones
or weakening descriptor uniqueness would reintroduce withdrawn evidence; the
owner selected permanent refusal. Cleanup-ownership transfer and completed
removal recovery were split into [#229](https://github.com/ven2dev/dfs-ev-demo/issues/229)
to bound this issue; fencing/upload deadlines need unavailable ObjectStore
conditional writes (#172).

**Targets.** The completed feature will enforce two statements per successful
artifact read: one batched authorization with pin retrieval, one fresh
pre-delivery rights/status check. Zero per-example/per-file authorization SQL,
reader DML or explicit reader coordination locks; no transaction/lock held
across I/O or calculation. Automatic SELECT AccessShareLock is expected.
Mandatory cleanup uses one bounded page SELECT, then four SQL statements per
deletable candidate (BEGIN, recheck, ack, COMMIT) and one ObjectStore DELETE;
refused candidates use three statements and no DELETE/ack. Read and cleaner
CI budgets land with their respective steps 2 and 3. The final opt-in benchmark retains the
per-block p95(Q1+Q2) ≤21 ms gate under 30 ms (≥30% headroom), with interleaved
baseline runs. This is **local-fixture only**; hosted region/network RTT remains
unmeasured (#220). No wall-clock CI assertions.

The fixture is the retained 16 exact 2021–2025 nflverse wire files on the
512 MiB PostgreSQL 18.6 / Node 24 local fixture, with 2,504 retrospective
members (natural cohort hash
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`)
and a genuine zero-member strict-PIT guard. Grace is configurable, default
300 seconds, within the existing 0–86,400-second range.

**Requirement reasons.**

| Rule | Risk prevented |
| --- | --- |
| Invalidate through server-owned dataset/source pins. | Callers cannot omit withdrawn inputs, and a shared file cannot invalidate an unrelated run. |
| Preserve identity, pins, recorded_at and rights receipt; append invalidated_at and its deletion event ID once. | Governance cannot rewrite the first publication or resurrect a withdrawn run. |
| Keep both publication guards and sample current rights after lock waits. | Direct SQL and long waits cannot bypass current rights; refused callers never receive a historical run. |
| Permanently retain descriptor uniqueness and deletion tombstones. | Identical deleted evidence cannot be republished at the same identity/address. |
| Only non-invalidated runs retain shared bytes; last-reference deletion re-arms removal. | Cleanup neither breaks unaffected runs nor retains invalidated bytes forever. |
| Mandatory cleanup defers while a model orphan observation exists; the scoped sweep still deletes after orphan grace. | Exactly one cleaner owns an address, with neither conflicting deletion nor an ownership dead end. |
| Separate byte-removal and queue-completion times in evidence. | A pending receipt cannot be misread as data still present during observation retirement. |
| Use real restricted LOGINs and narrow APIs. | Owner-session role switching cannot masquerade as a permission proof. |
| Enforce client counts and server work in CI; speed gates stay opt-in. | Definer functions cannot conceal per-example work, and machine speed cannot cause flaky CI timing failures. |

**Assumptions and limits.** Trusted database owner/pipeline and private ObjectStore
root; restricted readers; local research; immutable pins; accepted conservative
season lineage. The orphan observation remains the cleanup owner until its
configured retirement window (24 hours by default). Mandatory removal can stay
pending through that window even though bytes are removed after orphan grace;
late bytes still rely on the orphan sweep. A late PUT after mandatory completion
without a surviving observation has no scheduled revisit in #166. #229 owns
recovery-aware handoff and the completed-removal recovery lane; #166 claims no
such guarantee. A PUT outside the recovery window remains outside the existing
operational assumption. Revocation after the final delivery snapshot remains
the foundation's accepted small delivery gap. No public delivery, streaming,
population-completeness or hosted-latency claim is made.

## Lifecycle and deletion APIs

`model_runs.invalidated_at` and `deletion_event_id` reference the existing
`deletion_events` receipt. A paired-column constraint and immutable-publication
trigger prevent clearing/replacing the first invalidation or modifying original
publication fields. Ordinary pipeline credentials retain SELECT-only access to
registry tables. No new reader/app artifact access is granted in step 1.

`deleteSources` extends the foundation closure from deleted snapshots through
affected datasets to dependent runs. `deleteDatasets` deletes only the requested
dataset pins, leaving source snapshots and derived values intact. Both use the
same private closure to lock dependent metadata, record affected `run_ids`,
invalidate runs and enqueue every artifact of those runs in one transaction.
Grace starts after invalidation/provider cleanup. Repeated deletion preserves
the first run clock/event while re-arming removal with the greatest deadline.

The private closure has no caller EXECUTE grant. Public deletion APIs require a
writer LOGIN, 1–1,024 distinct non-null IDs, an existing complete target set,
a reason of 1–512 characters and finite grace within the accepted range.
Failure rolls back status, receipt and queue writes together.

`guard_model_publication` still executes before HEADs and inside
`publish_model_run`. After source/dataset/address lock waits, it checks current
rights, then invalidated identity/pins and permanent address tombstones.
SQLSTATE `P1661` means `model-publication-invalidated`; `P1662` means
`model-object-deleted`; `P1665` means `model-current-rights-refused`. Pipeline
`ArtifactGovernanceError.code` maps those states without parsing provider text.
Preparation also preserves an explicit invalidated-pin refusal before scoring
or uploads. Live get-or-create retains the original clock and rights receipt,
including retries after a lost COMMIT response.

Because these APIs enqueue models/audits immediately, step 1 includes the SQL
reference/ownership checks that make the new rows safe. Mandatory recheck
defers while an orphan observation exists. Orphan recheck preserves the record
and allows deletion after its own grace, subject to live-run protection;
absent-record retirement ignores invalidated references. Step 3 completes page
filtering, explicit models/audits requeue, CI budgets and integrated cleanup
tests, described below. The existing #164 lock-protected reference check remains; its cleanup
handoff to the mandatory owner is #229.

## Evidence and remaining work

The approved preimplementation spike measured 3,600 interleaved reads across six
shapes. Overall shape p95(Q1+Q2) was 2.404–4.875 ms; worst repeated block p95 was
10.268 ms (65.77% headroom under 30 ms). Thirteen behavior probes and the hidden
DML negative control passed. These are historical mechanism results from a
disposable prototype, not timings for this implementation. Final source-byte
evidence and the per-block gate will be rerun in step 4.

The [committed evidence index](evidence/feature-store-166/README.md) separates
the losslessly archived spike from the fresh implementation's
[step-1 lifecycle receipt](evidence/feature-store-166/step-1-lifecycle.json).
Step 1 proves exact deletion scope with real derived/member/provider rows,
restricted LOGIN refusals, both publication/deletion lock orders, transactional
rollback, permanent typed invalidation/tombstone refusal and a lost-COMMIT-reply
retry that preserves the original run. No prototype source was copied into the
implementation.

Step 2 adds the two-query trusted delivery boundary and deterministic read/server
work budgets, described below. Step 3 finishes cleaner orchestration and its per-candidate budget.
Step 4 supplies the final benchmark, acceptance mapping and premise-first review
below. Steps 1–3 are committed as `0484bd6`, `becbcd0` and `39947fb`;
the owner has approved the step-4 commit. Evidence receipts retain their
precommit source identities and status.
Each step is reviewed before committing. The approved planning estimate was
3½–4 hours; discovery beyond five hours triggers a split before
further implementation. Push requires fresh owner consent.

## Guarded artifact reads and calculation

The public pipeline subpath `@dfs-ev/pipeline/feature-store/model-artifacts`
exports `readModelArtifacts` and `withModelArtifacts`. Both accept a run UUID
and one to three distinct supported slots: `descriptor`,
`strict-point-in-time-v1`, `retrospective-reconstruction-v1`. Slots may only
select pinned artifacts; callers supply no addresses or source scope.

Q1 calls `fs138.authorize_model_read(run_id, slots, true)` once. Within that
statement's stable snapshot it derives the run's full dataset/source lineage,
checks current rights once per distinct profile and checks run/dataset/source
status. Only then does it return immutable run metadata, dataset pins, selected
artifact pins and the current authorization receipt. Even a descriptor-only
read authorizes every cited dataset/source. The restricted reader receives only
EXECUTE on this narrow function; registry table SELECT/mutation and writer APIs
remain refused. The original publication receipt is historical metadata, never
an authorization certificate.

The API GETs each selected artifact once, checks its pinned byte size and invokes
the optional trusted calculation. It does no HEAD, PUT, DELETE, raw/dataset-byte
read or ordinary integrity rehash. After all I/O and calculation, Q2 calls the
same function with `false`, re-deriving current rights/status in a fresh statement
and returning only its receipt. Results are released only after Q2 succeeds.
There is no nested dataset guard. #167 may put its single context lookup inside
the trusted callback; its future handler will then use three total SQL calls.
Context lookup/lineage integration and serving behavior remain #167 work.

Use a dedicated idle READ COMMITTED connection for the entire operation so a
caller transaction cannot keep locks open across I/O. The API opens no
transaction. The SQL function rejects repeatable-read/serializable snapshots,
which could hide a newly committed revocation from Q2. An idle connection and a
callback that never streams, caches or releases private bytes are trusted caller
preconditions, matching the existing publisher's dedicated-connection contract.
PostgreSQL's extended Parse/Bind protocol means transaction and statement clock
inequality is not a valid way to detect a previously open transaction. Real
paused-GET/calculation probes instead verify idle session state, no transaction,
no held locks and a concurrent deletion that commits before Q2.

A tombstone for shared-retained bytes does not refuse an unaffected existing
run. Its live status and rights decide delivery. Invalidated runs, invalidated
datasets, deleted sources, missing lineage and denied/expired grants all refuse.
Malformed requests, missing run/slot, rights refusal, status refusal and snapshot
session refusal have typed codes (`model-read-request-refused`,
`model-read-missing`, `model-current-rights-refused`,
`model-read-status-refused`, `model-read-session-refused`). Missing, failed or
wrong-size GETs produce `model-artifact-unavailable` with the original cause.
Calculation errors and database/socket failures preserve their original error;
none returns a buffered result. Same-size corruption remains #170's integrity
qualification responsibility, as it is for ordinary foundation reads.

## Step-2 CI work budgets

The database lane automatically discovers `model-artifacts.check.mts`. It
asserts exactly **two client SQL statements** and **one GET per selected file**
on success and on Q2 refusal. Initial rights/status refusal uses one query and
zero GETs. There are zero client BEGIN/COMMIT/ROLLBACK calls and zero ordinary
HEAD/PUT/DELETE/list calls. Tests cover single-mode and paired-mode runs with
0 versus 2,504 actual members, descriptor-only and all selected artifacts.

The measurement-only wrapper samples `pg_stat_xact_user_tables` immediately
before/after the actual production authorization function in one autocommit
statement. This includes work inside definer functions. Q1 and Q2 each enforce
zero all-table DML and zero scans/tuple fetches of membership, example-value,
example-lineage and normalized tables. These deterministic counters are
identical at 0 and 2,504 members. Full metadata counters are retained for review;
their physical probe counts can differ with custom/generic plans and early
EXISTS exits. CI does not force a planner mode to manufacture equality.
In-statement `pg_locks` inspection rejects advisory, tuple/transaction and
relation coordination locks; normal AccessShareLock is expected. Hidden scan
and definer-DML negative controls demonstrate that the oracle detects violations.
No wall-clock gate runs in CI; the final retained-fixture benchmark still gates
each candidate block's p95(Q1+Q2) at ≤21 ms under 30 ms, local-fixture only.

## Mandatory model/audit cleanup

`cleanupDeletedObjects` uses one pending-page SELECT, bounded at 1,024 eligible
addresses. It excludes observed model/audit addresses **before** the limit, so
their 24-hour recovery records cannot starve later eligible work. Raw/dataset
selection keeps its foundation behavior. Selection does not claim ownership:
each candidate takes the common address lock through `removal_recheck`, which
rechecks due status, orphan ownership and current live references after waits.

An authorized candidate uses four client SQL statements: BEGIN, recheck, ack and
COMMIT, with one ObjectStore DELETE between recheck and ack. Ack internally
rechecks eligibility under the same transaction/address lock before marking
`removed`; this is included in server-work evidence. A refused candidate uses
three SQL statements and no DELETE/ack. Ordinary mandatory cleanup uses zero
ObjectStore GET, HEAD, PUT or list calls. The existing `shared` return array is
the legacy list of recheck-refused candidates; the queue's durable `outcome`
distinguishes `shared-retained` completion from a still-pending deferral.

Only a non-invalidated run keeps a model/report address shared-retained. Such
an attempt completes durably, releasing its page slot. Deleting the last live
reference re-arms completion/outcome and begins a new grace after invalidation
work; repeated deletion keeps the greatest deadline. Invalidated run references
do not retain bytes. Sources/datasets retain their existing live-reference rule.

For observed addresses with pending removal, `orphan_recheck` retains the record
and authorizes the scoped sweep after orphan grace, subject to live references.
Mandatory selection/recheck continues to defer and ack refuses. An absent record
retires only after the configured recovery window from its last enrollment
(default `MODEL_ORPHAN_RETIREMENT_SECONDS = 86400`). Mandatory cleanup then
performs an idempotent DELETE of already-missing bytes and completes `removed`.
Evidence records byte-removal, observation-retirement and queue-completion times
separately: pending status can persist up to that window after bytes are gone.

The writer-only `requeueRemovedObject` API extends the existing narrow SQL
operation to models/audits. It resets completion/outcome under the common lock,
preserving the event, grace and permanent tombstone. An unknown address is a
no-op, so requeue cannot silently claim unregistered objects. A surviving orphan
observation still owns cleanup after requeue. Completed tombstones are not
automatically polled; recovery-aware ownership handoff, #164 participation and
completed-removal late-PUT recovery remain #229. The interim late-PUT gap is
unchanged.

`artifact-cleaner.check.mts` enforces the four/three-statement counts, one-page
bound and ObjectStore counts. For 0 and 2,504 actual members, database-side
counters include both recheck and ack's internal recheck: zero example-table
scans/tuple fetches, zero non-queue DML, no recheck writes on deletion/deferral,
one queue update on shared completion and one on ack. Deterministic work remains
identical across row counts. Behavior probes cover grace and last-live-reference
re-arm, observation deferral after an actual lock wait, both publication/cleaner
orders, unlink-before-ack exceptions and real backend termination, lost COMMIT
replies, explicit requeue, and real reader/outsider LOGIN refusals. A combined
page fixture skips 1,025 observed addresses, durably completes 1,025 shared
attempts and reaches a later removable object. Its publication metadata controls
are synthetic and make no retained-report provenance claim.

## Final implementation benchmark — local-fixture only

The [opt-in runner](../services/pipeline/scripts/feature-store/artifact-governance-benchmark.ts)
uses the actual `withDatasetRead`, `publishQbModelRun` and `withModelArtifacts`
APIs. It rebuilds the 16 retained wire files with fresh database clocks, the
natural 2,504-member retrospective cohort and the genuine zero-member strict
guard. Three real publications cover strict, retrospective and paired modes.
Outside timing it verifies exact report bytes, logical report hashes,
descriptor pins and SQL-owned dataset pins against those fresh publications.
Report sizes are **9,290,167** and **306,542** bytes in this run; archived
prototype sizes are not substituted for freshly generated envelopes.

Before installing the candidate proposals, 25 dataset baseline reads per mode
measured p95(Q1+Q2) of **4.368 ms** (zero members) and **3.230 ms** (2,504
members). Baseline reads use the unchanged three-query API; only its two rights
queries enter the timing comparison. After proposal installation, each of six
shapes runs six ABBA blocks, 25 reads per position, using that same baseline
and the two-query candidate. This yields **3,600 interleaved samples** plus
50 baseline-first samples; all **1,800 candidate reads** and **36 candidate
blocks** pass. Each block's gate uses the nearest-rank p95 of the 50 individual
Q1+Q2 sums, rather than adding separately computed percentiles.

| Run / selected files | Worst block p95(Q1+Q2) | Headroom under 30 ms |
| --- | ---: | ---: |
| Strict / descriptor | 2.134 ms | 92.89% |
| Strict / descriptor + report | 4.425 ms | 85.25% |
| Retrospective / descriptor | 4.551 ms | 84.83% |
| Retrospective / descriptor + report | 6.380 ms | 78.73% |
| Paired / descriptor | 1.894 ms | 93.69% |
| Paired / descriptor + both reports | 3.535 ms | 88.22% |

Every block clears **≤21 ms**, providing at least the required 30% headroom.
The [full receipt](evidence/feature-store-166/final-benchmark.json) retains all
samples, per-query durations, per-block results, baseline samples, exact fixture
and source hashes, GET/calculation/full-read timing and work counts. No ordinary
hashes, HEADs or writes occur during timed reads. The callback only sums byte
lengths. Full-read p95s are informational (the worst block was 46.075 ms);
this does not measure #167's parsing, context lookup or projection workload.

These are **local-fixture-only** results: PostgreSQL 18.6, Node 24.18.1,
512 MiB tmpfs, warm/unflushed caches and an existing restricted LOGIN. Query
timing includes local loopback and `pg` decoding; instrumentation overhead
applies to both arms. Hosted RTT, Neon wake/region (#220), cold caches,
end-to-end serving and capacity remain unmeasured. There is no elapsed-time CI
assertion and no ratio-to-baseline gate. Source hashes were unchanged at the
end of the experiment; a separate verification recomputes counts, percentiles,
hashes and fresh report pins in the [verification receipt](evidence/feature-store-166/final-verification.json).

## Final acceptance and premise-first review

**Premise.** Lineage invalidation, immutable identity/tombstones and resumable
idempotent removal fit these private offline artifacts. The existing queue and
address lock remain the coordination mechanism. Two short authorization
snapshots fit a trusted buffered calculation; reader transactions across file
I/O would obstruct deletion. Review found no new pattern deviation requiring
an owner decision. Permanent refusal, the trusted callback/idle connection,
the final-snapshot delivery gap and #229's interim recovery limitation remain
the explicit approved decisions and assumptions.

**Targets.** The final implementation clears every local speed block. CI proves
two read statements independent of selected files and example count, plus zero
example-table work/all-table reader DML inside the SQL functions. Cleanup uses
one bounded page plus four statements per deletion (three per refusal), one
DELETE and zero ordinary GET/HEAD/PUT/list calls. Server counters include ack's
internal recheck and stay within the same budgets at 0 and 2,504 actual members.
The negative controls detect hidden scans and definer DML. Metadata physical
probe counts remain visible rather than being forced equal across query plans.

| Acceptance / carry-forward | Fresh final evidence |
| --- | --- |
| Both deletion APIs invalidate exactly dependent runs, preserving unrelated sources/datasets/derived rows. | [Lifecycle](evidence/feature-store-166/final-lifecycle.json): exact run/address sets, real membership/provider rows, atomic rollback and both publication/deletion lock orders. Exactness remains within the accepted conservative dataset lineage. |
| Original identity, pins, recorded_at and rights receipt remain immutable; deleted identity/address cannot be republished. | Lifecycle: immutable-field assertions, typed runner/direct-SQL refusals and live get-or-create retry after a lost COMMIT response. Both publication guards stay. |
| Revocation/deletion before access or during any selected GET/calculation withholds delivery. | [Read boundary](evidence/feature-store-166/final-read-boundary.json): initial zero-GET refusals, descriptor-only full-lineage checks, 12 mid-operation controls, Q2 socket failure and callback/request-mutation controls. |
| Exactly two read statements, bounded selected GETs, no reader coordination locks or transaction across I/O. | Read boundary: eight shapes, 0/2,504 actual members, internal work/lock probes, hidden-work negative controls and paused readers with concurrent committed deletion. One optional context control composes within the same two checks. |
| Shared report bytes survive unaffected live runs and are removed after the last live reference and configured grace. | [Cleaner](evidence/feature-store-166/final-cleaner.json): shared-retained completion, greatest grace/re-arm and unaffected-run delivery; invalidated references cannot retain bytes. |
| Orphan and mandatory ownership do not conflict or strand observed bytes under pending intent. | Cleaner: orphan bytes disappear after orphan grace while observation and pending intent survive; zero mandatory DELETE/ack while observed; retirement permits idempotent missing-byte deletion and durable `removed`. Three clocks remain separate. |
| Four-statement cleaner budget; crash/resume, requeue and page progress. | Cleaner: raw server counters including ack's recheck, actual lock waits/disconnects, unlink-before-ack and lost-COMMIT controls; 1,025 observed plus 1,025 shared addresses cannot starve later removable bytes. |
| Role isolation and proposal-only rollout. | All three receipts use real restricted LOGINs. [Final validation](evidence/feature-store-166/final-validation.json) records regression/contracts/static checks, unchanged frozen migrations and zero remaining scratch resources. |

**Limits and successor boundary.** Mandatory `pending` may last through the
24-hour observation-retirement window although bytes disappeared after orphan
grace. Evidence records byte removal separately from retirement/completion.
Completed tombstones have no automatic revisit; #229 owns the cleanup handoff,
#164 participation and late-PUT recovery lane. This issue supplies explicit
requeue, without claiming that recovery guarantee. #167 owns serving/context
integration, #168 capacity and #170 same-size integrity qualification. The
final regression receipts qualify this proposal/runtime; no hosted deployment
or frozen migration is authorized by these results.
