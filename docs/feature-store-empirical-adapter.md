# #163 empirical adapter — approved design and implementation roadmap

Owner-approved roadmap: [issue #163](https://github.com/ven2dev/dfs-ev-demo/issues/163#issuecomment-6250059648).
Implementation branch: `feature/dfsEV-163-empirical-adapter`, created in a separate
worktree from fresh `origin/main` at `20b712c7ec2a9a4e8cd3bbb5d780f5f4f559ac21`.
The owner approved starting the issue iteration. Steps 1–2 are committed; the
versioned research adapter is implemented and its focused step-3 correctness
probes pass. Final adapter latency and between-query race probes remain step 4.

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

Reproduce on Node 24 with the disposable local PostgreSQL service running:

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
other worktrees changed. Step 3 is ready for owner review and commit approval;
no step-3 commit or push has been made.

Step 4 remains: inject revocation/deletion between statements, exercise pruned
inputs, run the final repeated cold/warm matrix with query tracing and stage
percentiles against this completed adapter, and prepare the independent-review
handoff. The step-2 speed result does not substitute for that final measurement.
