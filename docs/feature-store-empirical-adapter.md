# #163 empirical adapter — approved design and implementation roadmap

Owner-approved roadmap: [issue #163](https://github.com/ven2dev/dfs-ev-demo/issues/163#issuecomment-6250059648).
Implementation branch: `feature/dfsEV-163-empirical-adapter`, created in a separate
worktree from fresh `origin/main` at `20b712c7ec2a9a4e8cd3bbb5d780f5f4f559ac21`.
The original four steps are committed through `938d398`. Independent review
confirmed the premise and found a shared rights-expiry defect. The owner approved
the latest-effective-decision rule; the repair below passes its local correctness
and repeated latency gates. The owner approved the review-fix commit; focused
re-review remains pending. Nothing has been pushed.

## Design basis

- **Pattern:** a pure equal-mass empirical-distribution kernel plus a versioned,
  research-only input adapter over trusted materialized QB passing-yards features.
  This remains an uncalibrated interim hit-rate model; it supplies no calibrated
  baseline, predictive-projection or population-completeness claim.
- **Alternatives rejected:** reconstructing raw evidence per prediction repeats
  ingestion work and risks the latency/work budgets; inventing availability
  timestamps to fit the strict wrapper falsely claims historical knowledge.
- **Layer placement:** the kernel goes in `src/lib/projection/empirical.ts`, ready
  for the future `packages/domain` move under #148. The database/rights adapter
  goes in `src/lib/featureStore/empiricalAdapter.ts`, on the server/pipeline side.
  No workspace migration belongs to #163. **The kernel imports nothing from
  Next.js, the database or server-only modules; a dependency-boundary test enforces
  this. The adapter depends on the kernel, never the reverse.** No deviation.
- **Targets:** p95 <=210 ms for both warm and cold request paths, against the
  unchanged 300 ms deadline; exactly three SQL statements and two batched current
  rights/status checks per successful request; zero raw-evidence or per-row
  validation reads. Prototype before expanding the implementation.
- **Assumptions:** trusted pipeline/database owner; a restricted local research
  reader; immutable, versioned features; season-scoped snapshot lineage; actual
  knowledge clocks; no hosted writes or production-readiness claim.

## Contract and requirement reasons

- Every success/refusal variant identifies `rightsScope: 'research'` and the
  adapter identity, so research authorization cannot be mistaken for serving
  clearance. Successful outputs identify the uncalibrated interim hit-rate model,
  sample size, feature/history-policy/evidence-mode versions, feature identity,
  actual selection/knowledge clocks, source lineage and freshness flags. Future
  serving integrations re-authorize their serving use at request and delivery.
- Keep the legacy fitter's validation order, numeric results, output shape and
  temporal refusals unchanged to protect its existing callers. Its existing
  histories longer than 16 remain supported; only the new adapter is capped.
- The new adapter accepts the existing policy's 2–16 eligible prior REG games.
  Two excludes the degenerate one-observation case, not statistical unreliability;
  the output remains explicitly noisy/uncalibrated. Sixteen preserves the approved
  recency and bounded-work policy; it is not an optimized window. Neither limit is
  retuned here, to avoid silently changing the registered experiment.
- Consume an exact pinned feature identity and explicit knowledge-as-of selection;
  preserve the feature's pregame cutoff and real timestamps, and carry
  `historical-availability-unverified` plus stale/superseded flags. Unknown
  versions, insufficient history, the target event, equal-cutoff and future events
  fail closed to prevent policy drift and event-time leakage. Earlier games'
  passing yards are outcomes already materialized as lagged feature history.
  The adapter reads that history from `feature_values`, not from the label table.
  It never reads the outcome label for the game being predicted.
- Use three short statements: (1) resolve pinned metadata/lineage and authorize
  research rights/current status; (2) read the authorized materialized history;
  (3) recheck that same feature/lineage and current rights before delivery. Compute
  in memory and withhold the response until the recheck passes, refusing deletion
  or revocation visible to that query. **Accepted limit:** changes committed after
  the third query's snapshot and before bytes leave the process cannot be
  guaranteed to be observed. This is check-and-recheck, not an atomic-delivery or
  in-flight-revocation guarantee. No reader locks, cache or per-record
  reconstruction is introduced to close that remaining window.

## Atomic delivery steps and acceptance mapping

1. **Extract the single math implementation with legacy parity — 30–45 minutes.**
   Move support construction and probability/pricing arithmetic currently inside
   `fitBaseline`, `probabilityAt` and `priceSide` in `baseline.ts` into `empirical.ts`.
   Keep strict qualification and compatible public exports in `baseline.ts`, which
   delegates to that kernel. Preserve the arithmetic operation order and leave
   one implementation of each calculation, including in the prototype. Enforce
   the domain import boundary and test signed/zero values, equal masses, ties,
   integer Push, half-yard Push=0 and the legacy >16 case, plus existing temporal/
   validation refusals. This small mechanical extraction is the prerequisite to
   the cheap proof; adapter expansion remains gated on that proof. Meets AC1/AC2.
2. **Cheap request-path spike before adapter expansion — 45–60 minutes.** Reproduce
   the #138 fixture from its 16 pinned objects using the local ObjectStore and disposable PostgreSQL;
   setup stays outside measurement. Prototype the exact three-query boundary over
   materialized features with restricted connections. Measure both modes and actual
   query counts. A target miss stops expansion and returns evidence to the owner;
   it does not trigger a looser budget. Meets the early-proof part of AC4.
3. **Finalize the versioned research adapter — 45–60 minutes.** Complete the
   pinned-input/output contract, explicit versions, rights scope, actual clocks,
   sample-size and retrospective/freshness disclosures. Cover n<2, n>16, malformed
   or unknown versions, target/equal-cutoff/future games and current-state refusal.
   Earlier games' outcomes come only from materialized lagged feature history;
   the adapter reads neither `outcome_labels` nor the target game's label. Meets AC2/AC3.
4. **Integrated probes, final evidence and review handoff — 45–60 minutes.** Test
   rights revocation and source deletion between queries, missing/pruned features,
   flags and clock boundaries. Prove the adapter works when its reader has no
   `fs138.outcome_labels` or normalized/raw-evidence read permission: earlier-game
   values remain readable through their materialized feature row. Measure constant
   work at 2, 8 and 16 history slots. Repeat the final hot-path matrix, record every miss, run focused
   kernel/legacy/adapter and affected PostgreSQL checks, typecheck and lint. Commit
   compact receipts after owner approval and hand off for owner-run Codex review.
   Meets AC1–AC4. No repeated full database gate after each small edit.

Planning range: approximately 3–4 hours including discovery, focused validation,
receipts and documentation; owner waiting time is excluded. If projected total
exceeds five hours, split the remaining scope and stop before taking it on.

## Measurement contract

- **Warm gate:** existing restricted connection; authorization through response
  serialization. **Cold gate:** inside an already-running process, start before
  opening a fresh restricted connection and finish after response serialization.
  Both gate at p95 <=210 ms; unexpected refusals/deadline failures remain failures.
- **Measured separately, not gated:** fresh Node/module startup and the full
  parent-observed startup-to-response total. Report connection setup, each of the
  three queries, calculation and serialization separately, plus request total.
- Alternate cold and warm cohorts across three rounds, at least 100 requests per
  mode per round. Report sample counts, nearest-rank p50/p95, maxima and misses for
  each round and the combined modes; each round meets the same p95 gate. Use
  deterministic cases spanning 2022–2025 and sample sizes 2–4, 5–8 and 9–16.
  Absolute gates use alternating cohorts; ABBA is only for a subsequent explicit
  optimization comparison and requires the same pinned fixture/boundary.
- No raw-file, per-row evidence or application-result cache on the measured path.
  Disclose unflushed OS/PostgreSQL caches. Local runs do not establish Vercel
  function boot or Neon compute-wake latency; neither is simulated or cleared by
  this proof. #168 remains the broader prediction-capacity deliverable.
- Compact receipts retain source/code/query/fixture hashes, runtime, fixture counts,
  boundaries/cache state, per-stage distributions, deterministic work counts,
  failures and per-target verdicts. Full logs stay off main; useful archived logs
  may receive an owner-approved evidence tag. Persisted artifacts use ObjectStore.

## Approval and scope boundaries

The owner approved this roadmap with the four incorporated amendments; this
issue comment is the durable roadmap record. The owner has approved the branch
and starting implementation from fresh main.
Keep every other worktree/branch untouched to avoid modifying reference work.
Each atomic step is verified and summarized for owner approval before its commit.
The owner runs Codex review; each push needs fresh consent; the owner merges.

SQL changes stay in `db/proposals/` for later movement to `packages/db`. No frozen
migrations, retired #106/#118/#127 implementation, hosted writes, Production,
GCS, product route/UI, deployment, model registry or #164 evaluation is included.
Do not add attribution trailers. No initial capacity pass is claimed by this plan.

## Step 1 checkpoint

The shared arithmetic is implemented in `projection/empirical.ts`, with no module
dependencies. `baseline.ts` retains strict qualification and its existing public
API, delegates support/probabilities, and re-exports the same pricing/validation
functions. The model version, complete legacy output envelope and histories over
16 games are unchanged. The new adapter's narrower policy is not imposed here.

All 33 projection tests, typecheck and changed-file lint passed. A supplemental
comparison against the original main module matched 12,287 exact results/refusals;
committed regression tests cover hand-calculated values, arithmetic order,
temporal/refusal precedence, the 37-game case and the domain import boundary.
See the [compact receipt](evidence/feature-store-163/step-1-kernel.json).
This step makes no adapter latency, SQL-budget or database-permission claim.
The owner approved the step-1 commit, recorded as `42c9d09`.


## Step 2 checkpoint — cheap request-path proof

The script-only prototype follows the approved check/read/recheck pattern and
uses the step-1 kernel. The proposal SQL adds a dedicated research reader role,
with feature and lineage/rights metadata permissions. It adds no tables, reader
locks, cache or ordered migration. The full adapter remains step 3.

The fixture was rebuilt from all 16 exact #138 source objects through ObjectStore
and the existing ingestion/feature jobs. Its 2021 data supplies warm-up history;
2022–2025 features are materialized before timing. No labels were materialized.
The 12 measured examples span all four evaluation seasons and exactly 2, 8 and
16 history games. Each mode includes 25 requests for every season/sample pair.
This remains retrospective evidence with historical availability unverified.

Three alternating-order rounds each contain 100 cold and 100 warm requests.
No requests were discarded. Each cohort and both aggregate modes passed the
unchanged nearest-rank p95 <=210 ms gate; there were zero refusals, deadline
failures or individual requests above 210 ms.

| Request boundary | n | p50 | p95 | Worst cohort p95 | Maximum | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Cold | 300 | 14.27 ms | 17.26 ms | 19.02 ms | 34.87 ms | Pass |
| Warm | 300 | 3.80 ms | 5.78 ms | 8.17 ms | 35.23 ms | Pass |

All 600 requests executed exactly **three SQL statements**, including **two
batched research-rights/status checks**. Actual statement tracing verifies the
authorization/history/authorization sequence. EXPLAIN visits only feature values,
feature inputs, source-snapshot metadata, job status and rights decisions.
The restricted login's label-table, label-input, normalized-table/view and raw
source-manifest reads all fail with PostgreSQL 42501; its derived insert fails
too. Earlier outcomes are obtained exclusively from materialized feature history.

Cold requests include a fresh restricted connection inside an already-running
process. Warm requests reuse a restricted connection. SQL loading, fixture setup,
permission probes and EXPLAIN happen before timing. There is no application-result
cache and no named prepared statement; OS/PostgreSQL caches are unflushed.
Separate fresh-Node probes (n=3, measured only) report process/module/setup,
connection, each query, calculation, serialization and parent-observed total.
They do not establish Vercel boot or Neon compute-wake readiness.

See the [compact receipt](evidence/feature-store-163/step-2-hot-path.json) for stage
percentiles, query/fixture/code hashes, every target verdict and misses. Full
per-request trials and plans stay outside git in the receipt's local ObjectStore
audit addresses. Typecheck and changed-script lint pass. No database suite or
kernel suite was repeated for this script-only checkpoint; its actual PostgreSQL
permission/work probes and repeated latency matrix ran successfully.

The step-2 receipt belongs to `ff184a6`, including that commit's prototype and
SQL. Reproducing that historical measurement requires that checkpoint. The same
command at the final candidate now measures the completed step-4 adapter on Node
24 with the disposable local PostgreSQL service running:

```sh
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/feature-store/empirical-spike.ts
```

The prototype clears the early performance gate. It does not complete #163:
explicit supported-version/refusal handling, both evidence modes, stale/superseded
disclosures, interrupted-connection handling and race probes remain steps 3–4,
followed by the final adapter matrix and owner-run independent review.
Revocations after the last query snapshot retain the approved delivery-gap limit.
The owner approved the step-2 commit, recorded as `ff184a6`. Nothing has been
pushed. Its timings describe that prototype commit, not the expanded step-3
adapter or SQL.


## Step 3 checkpoint — versioned research adapter

`createEmpiricalAdapter` loads code-owned proposal SQL during setup, then reads an
exact feature ID under an explicit knowledge-as-of timestamp and supported
feature/history-policy/evidence-mode tuple. It uses the shared kernel over the
materialized lagged history, with no label, normalized-data or object-byte read.
Successes and refusals carry the adapter identity and research scope; successes
also identify the uncalibrated interim hit-rate model, sample size, pinned/natural
identities, original knowledge/cutoff clocks, source snapshot lineage, both rights
decision receipts and current freshness. These outputs confer no serving rights.

Pinned once-valid values remain available after newer usable or unavailable
versions appear. The output distinguishes superseded from stale and carries the
historical-availability-unverified flag in retrospective mode. Unknown version
combinations, unavailable/missing features and malformed or out-of-policy history
produce explicit unavailable results. Event comparisons preserve PostgreSQL
microseconds, so equality is refused and one microsecond before cutoff is allowed
in both evidence modes. Real knowledge clocks are not backdated.

A successful call still executes three short statements: batched authorization,
materialized history and batched delivery recheck. The actual client is connected,
exclusive and non-pipelined; the caller owns connection setup and replacement.
The 300 ms adapter deadline starts at invocation. A caller covering connection
setup supplies an earlier absolute `deadlineAt` on the same monotonic clock.
Pre-cancelled/expired requests issue no SQL and leave that connection reusable.
An interrupted query terminates the connection and marks it `discard`; the caller
replaces it, preventing timed-out work from leaking into a later request. No SQL
rollback, retry, session setting or lock is added to the read budget. The accepted
post-recheck delivery gap remains unchanged.

All **16 named PostgreSQL contract probes** pass (17 Node test entries including
the parent). They cover research-role read/write denials, hand probabilities,
2/8/16 constant work, request/stored-version refusals, inclusive knowledge clocks,
both evidence modes, missing/unavailable inputs, malformed history, target/equal/
future events, microsecond boundaries, pinned freshness, current rights refusals,
pre-cancellation, query timeout and in-flight abort. Interrupted connections refuse
subsequent queries. Both timeout and abort probes use real PostgreSQL sleeping
queries; malformed-history backstops also use explicitly corrupted read results.

The fixture is synthetic contract data inserted by the pipeline login, with a
small source object written through the local ObjectStore. Strict-mode success
uses a fictional future target with sources captured now; it is **not** proof of
genuine historical strict availability. No target labels are materialized. These
are correctness probes, not an evaluation or a final latency benchmark. See the
[compact receipt](evidence/feature-store-163/step-3-adapter.json) for every probe
verdict and source hashes.

All 33 kernel/legacy projection tests also pass. Typecheck, changed-file ESLint
and whitespace checks pass. SQL remains proposal-only. No ordered migrations or
other worktrees changed. The owner approved the step-3 commit, recorded as
`02648ac`. Its receipt preserves the file hashes at that checkpoint.

Step 4 was planned to inject revocation/deletion between statements, exercise
pruned inputs, repeat the cold/warm matrix with query tracing and prepare the
independent-review handoff. Its completed local results follow; the step-2 speed
result does not substitute for the final adapter measurement.


## Step 4 checkpoint — final local proof and review handoff

No adapter or SQL change was needed after step 3. The existing benchmark now
calls the completed versioned adapter, and its startup helper uses the same
factory. The early prototype remains a historical script; it is not imported by
the adapter or final benchmark. This is an absolute-target measurement, not an
optimization comparison or a claim that the final adapter improved on step 2.

All **22 named adapter PostgreSQL probes** pass (23 Node entries including the
parent). Six added cases commit actual writer changes between reader statements:
rights revocation and source deletion at either boundary; lineage expansion;
pruning an exact version before/during delivery; the accepted post-final-snapshot
revocation gap; and a real sleeping query interrupted by the absolute deadline
without relying on a pg query timeout. Deleted/pruned versions return unavailable
rather than silently selecting a replacement. Tests use separate restricted
reader and pipeline-writer connections with no reader transaction or table lock,
no timing sleeps for the committed-change races, and real database knowledge
clocks. An assertion requires every named case to run even without receipt output.
See the [correctness receipt](evidence/feature-store-163/step-4-correctness.json).

The final fixture re-ingests all **16 exact #138 wire objects** (103,468 normalized
rows) and materializes 2022–2025 features, retaining 2021 as warm-up history. No
labels are materialized. Source bytes and the natural feature-content hash match
the step-2 fixture exactly. The twelve selected player-games span four seasons
and sample sizes 2, 8 and 16, with 25 requests per cell per mode. They remain
retrospective reconstruction, with historical availability unverified.

The matrix retains every request: three rounds, 100 cold and 100 warm requests
each, with cohort order cold/warm, warm/cold, cold/warm. All six cohorts and both
aggregate modes pass the unchanged **p95 <=210 ms** target against the **300 ms**
deadline. There are no unexpected refusals, deadline failures or individual
requests above 210 ms.

| Boundary | Requests | p50 | p95 | Worst cohort p95 | Maximum | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Cold | 300 | 17.91 ms | 26.89 ms | 41.40 ms | 62.98 ms | Pass |
| Warm | 300 | 6.19 ms | 7.72 ms | 8.73 ms | 20.31 ms | Pass |

Cold cohort p95 varied from 20.30 to 41.40 ms; the slowest cohort retains ample
headroom. That variation remains visible in the receipt rather than selecting a
faster run. Connection setup, both authorization queries, history read,
calculation and serialization have separate p50/p95/max summaries per cohort and
aggregate. Separate sample-size summaries retain all 100 requests per size/mode.

All **600 requests execute exactly three SQL statements and two batched rights/
status checks**. The proxy traces actual statement text and order, independently
of the adapter counters. Restricted-role denials and EXPLAIN restrict relations
to materialized features, feature inputs, source-snapshot metadata, job status
and rights decisions: there are no raw, normalized, label or per-row validation
queries. Setup, SQL loading and EXPLAIN occur outside the request boundary; no
measured feature request is discarded as warm-up.

Cold includes opening a fresh restricted connection in a running process; warm
reuses an existing restricted connection. The cold caller gives the adapter an
absolute deadline starting before connection setup. There is no result cache or
named prepared statement. OS and PostgreSQL caches remain unflushed. Three
separate fresh-process probes report process/module/setup time (72.40–84.84 ms)
and parent-observed total (115.92–126.52 ms); these are measured, not gated. Local
PostgreSQL does not establish Vercel cold boot, Neon wake, hosted networking,
concurrent-load or production-capacity readiness. The broader gate remains #168.

The [final latency receipt](evidence/feature-store-163/step-4-hot-path.json) records
all boundaries, fixture/code/query hashes, run/stage/sample-size distributions,
zero misses and each target verdict. Full per-request trials and plans are stored
outside git through the local ObjectStore at the receipt's exact audit addresses.
Only compact receipts belong to this change.

### Acceptance evidence

| #163 criterion | Local evidence | Status |
| --- | --- | --- |
| Preserve strict legacy numbers/refusals; explicit versions | Shared arithmetic only; 33 kernel/legacy tests; step-1 parity receipt; request/stored-version and evidence-mode probes | Pass |
| Hand fixtures and event/sample boundaries | Signed/zero values, ties, integer/half-yard Push, n<2/n>16, malformed history and target/equal/future event probes in both modes | Pass |
| Real clocks and retrospective disclosure; no target label read | Verbatim DB clocks, microsecond boundaries, research/uncalibrated flags; empty label table plus denied label/raw/normalized reads | Pass |
| Compact repeated timing/count evidence and misses | All 600 final requests, six passing cohorts, 3 statements/2 rights checks, no forbidden relations, 0 misses | Pass |

Final affected checks pass: **68/68 feature-store PostgreSQL test entries**
(including the 23 adapter entries and the queue-progress boundary regression),
**33/33 kernel/legacy projection tests**, TypeScript and changed-file ESLint.
Frozen migration hashes and main catalog isolation remain covered by the existing
feature-store schema probes. No repeated benchmark was needed after the passing
matrix: only documentation and evidence packaging changed. The
[checkpoint receipt](evidence/feature-store-163/step-4-checkpoint.json) indexes
these results and the exact correctness/timing receipts. Repo-wide hosted CI and
owner-run independent review remain pending.

### Review focus and remaining workflow

Review the premise first: the import-free domain kernel is shared by the strict
legacy wrapper and a server-side versioned materialized-feature adapter. Check
that it remains an uncalibrated research hit-rate model and does not imply
population completeness or genuine historical availability. Then inspect the
unchanged performance/work gates, exact-version selection, current rights and
deletion checks, freshness disclosure and interrupted-connection replacement.

The accepted delivery gap remains: revocation committed after the final query's
snapshot may miss that response; the next request refuses. A named probe proves
that limit. Callers supply an exclusive connected non-pipelined client, replace
any client marked `discard`, and independently check serving rights before any
future product request/delivery. No current product route consumes these outputs.

The owner approved the step-4 commit. This checkpoint packages the completed
local proof for owner-run independent review. Fresh consent precedes any push
or PR; the owner merges.
No frozen migration, hosted write, GCS, UI, deployment or retired branch changed.


## Independent review at 938d398 — shared rights repair

The reviewer confirmed the design premise and reported no high-severity finding.
The medium finding was confirmed in both readers: filtering expired decisions
before choosing the latest one could resurrect an older grant. The owner approved
**latest effective decision wins; expiry refuses access until a new grant**.

The companion proposal `db/proposals/163_effective_rights.sql` now defines the
single read-only, invoker-rights policy function used by both the adapter and the
existing dataset reader. It selects the latest recorded decision whose valid-from
has passed, then returns no effective uses if that decision has expired. The
selected decision identity remains intact. Future-effective decisions wait until
their effective time, and later explicit grants can restore access. Both callers
pass their single statement clock as effective and knowledge time. No clock is
backdated and no reader privilege is elevated.

The disposable harness applies this proposal after the two existing #138 files.
Those #138 files and all frozen migrations remain unchanged. Any manually created
scratch fixture using the updated dataset reader also needs this companion
proposal; it is not a hosted rollout or an ordered migration.

The original checkpoint's lint entry now lists all nine TypeScript/MTS files
changed at `938d398`. The repair's complete changed-file lint run covers **13
files**, including its additional dataset, harness and rights tests. The parser's
short timezone-offset behavior remains unchanged: an unsupported format refuses
access. No authorization or look-ahead bypass was identified in that low finding.

The benchmark boundary remains deliberately narrow: 12 feature IDs, one
knowledge-as-of time, retrospective mode only and unflushed OS/database caches.
#168's broader capacity work should vary feature identities and knowledge clocks
and include strict mode. This proof supplies no such coverage.

### Approved shared-policy repair design basis

- **Pattern:** one read-only SQL policy function shared by the empirical adapter
  and dataset reader. Select the latest recorded, effective decision first;
  expose no effective uses after its expiry, preventing older grants from
  reappearing. Both callers supply the same statement clock for effective and
  knowledge time. A later explicit grant can restore access.
- **Alternatives rejected:** duplicating the corrected predicate leaves two
  policy implementations that can drift; a current-time-only view hides the
  caller's authorization clock and makes knowledge/boundary tests less explicit.
- **Targets:** preserve exactly three prediction statements and two batched
  rights/status queries; repeat all six 100-request cold/warm cohorts at unchanged
  p95 <=210 ms and 300 ms deadline. Dataset build/read statement budgets remain
  eight/three and two rights queries.
- **Requirement reasons:** select before checking expiry to prevent superseded
  grants from resurrecting; preserve database-recorded knowledge time to prevent
  retrospective rights from entering earlier answers; use SECURITY INVOKER and
  existing role grants to avoid expanding reader privileges.
- **Scope:** a companion proposal in db/proposals/, applied by the disposable
  harness after #138. Existing #138 proposal files and all frozen migrations stay
  unchanged. No new tables, cache, reader locks, model artifacts or hosted path.
  The existing rights tables and trusted-writer threat model remain in use. This
  is the shared source/dataset policy repair, not #166's model-artifact expansion.


### Repair validation and focused re-review

All **77 feature-store PostgreSQL test entries** pass, including **23 named
adapter probes**, the dataset build/read regression, and six shared-policy cases:
expired newer grant; expired newer denial; exact microsecond expiry boundary;
future-effective selection; earlier knowledge snapshot; and explicit restoration.
Policy tests use fixed valid-time instants and actual DB-recorded knowledge clocks,
without sleeping to cross expiry. Both production reader regressions show that an
expired superseding decision releases no probabilities/file bytes, and an explicit
new grant restores access. Dataset statement budgets remain eight for build and
three for read, with two rights checks in each operation.

The repeated final adapter matrix also passes: **600/600 requests**, all six
100-request cohorts, exactly **three statements and two batched rights/status
queries**, no raw/normalized/label/per-row validation queries, and **zero misses**.
The same source bytes and natural feature-content hash are retained. Aggregate
p95 is **20.85 ms cold** and **6.80 ms warm**; worst cohort p95 is **20.90 ms**,
against the unchanged 210 ms target and 300 ms deadline. These absolute runs do
not establish a speed improvement relative to the earlier checkpoint.

TypeScript and ESLint on all 13 changed TypeScript/MTS files pass. Kernel/legacy
code and tests are unchanged from the 33-test passing checkpoint. The original
step-2/step-3/step-4 correctness and timing receipts remain historical evidence;
the current repair uses [review correctness](evidence/feature-store-163/review-1-correctness.json),
[repeated timings](evidence/feature-store-163/review-1-hot-path.json) and the
[validation index](evidence/feature-store-163/review-1-validation.json). The latter
records current source hashes and the complete lint scope.

Focused re-review should verify selection-before-expiration in the shared
function, its use at both checks in both readers, invoker privileges, actual
knowledge-time and expiry boundaries, and the unchanged work/speed budgets.
The accepted post-final-snapshot revocation gap still applies. The owner approved
committing the review fixes. Focused re-review, fresh push consent and hosted CI
remain pending.
