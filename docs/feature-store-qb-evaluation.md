# Preregistered QB baseline evaluation (#164)

Status: step 4 complete, ready for owner and independent review. Local targets
pass; hosted CI and merge remain pending.
The [owner-approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/164#issuecomment-6296073750)
sets a five-hour engineering cap. Each atomic commit and every push needs owner
approval. This follows merged #189; database/pipeline extraction remains later work.

## Design basis

- **Pattern:** preregistered walk-forward evaluation over an immutable,
  version-pinned materialized cohort. Pure scoring lives in `packages/domain`;
  local database and ObjectStore orchestration lives in `services/pipeline`.
- **Alternatives:** random folds mix future and past information. Tuning,
  smoothing or calibration on evaluation outcomes changes the registered
  baseline. Per-example reconstruction repeats ingestion work and conflicts
  with the feature-store design.
- **Targets:** reproduce 2,504 logical examples and content SHA-256
  `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`
  before scoring. Cohort loading uses the existing three SQL statements,
  including two batched rights/status checks, and one ObjectStore read. No
  per-example SQL or raw-source reads enter evaluation. The owner approved
  completed-report time <=7 seconds against a 10-second deadline, measured
  repeatedly cold/warm, excluding fixture reconstruction. Final report delivery
  checks and their complete-path counts are verified separately. No statistical
  accuracy or ROI threshold is imposed.
- **Requirement reasons:** version/hash pins prevent silent policy changes;
  event and knowledge clocks prevent false historical-availability claims;
  player-aware identities prevent opposing QBs being conflated; current rights
  and deletion checks prevent delivery of withdrawn evidence; visible infinity
  and unavailable counts prevent selective finite-only results.
- **Assumptions:** trusted pipeline/database owner, restricted reader, local
  research rights and local ObjectStore. No completeness or product calibration
  claim. Existing strict fitter results and temporal refusals stay unchanged to
  preserve its contract.

The model is the **uncalibrated interim hit-rate baseline**, not a calibrated
predictive projection. Earlier-game outcomes enter predictions through lagged
materialized features; the target outcome is used only for scoring.

## Experiment and input pins

The preregistration is commit `6aa7953`, document
[feature-store-spike-preregistration.md](feature-store-spike-preregistration.md),
SHA-256 `dc6bf2e044bcbdd6de4b1d6f91db9c623f630ad1eaf7bf1b8abdfe1f3c05c97d`.
Its old review-status header is historical; the owner approved its commit.
The setup verifies the exact committed bytes rather than editing that policy.

`evaluation-prepare.ts` uses the 16 exact #138 wire objects through ObjectStore,
checks their hashes, and ingests isolated copies with real current capture and
database knowledge clocks. No download or synthetic correction is substituted.
All ingestion succeeds before the pinned label checkpoint. Both evidence modes
use that checkpoint for their derived jobs; dataset selection uses the later
publication clock so the computed rows are visible. Neither clock is backdated.

The fixture creates and drops its own disposable database using the existing
harness. It writes detailed input pins, snapshot clocks, coverage ledger and
immutable dataset files through local ObjectStore. Git receives only compact
receipts. Exact-file hashes include fresh IDs and clocks; the natural content
hash is the reproducibility target across new fixtures. A subsequent evaluation
recreates the isolated fixture, checks the same logical cohort and records its
own exact input pins before scoring. Archived setup artifacts alone do not
establish current rights after their scratch database is retired.

Strict PIT and flagged retrospective reconstruction remain separate. The latter
retains `historical-availability-unverified`. Missing strict historical evidence
is reported as unavailable. Evaluation targets are 2022–2025, with 2021 warm-up
only, latest <=16 eligible prior games, minimum 2, cutoff kickoff minus one hour.
The full coverage ledger retains unavailable features/labels and history gaps;
missing participation is never converted into zero.

## Delivery steps

1. Reproduce and pin inputs, versions, code and preregistration before scoring.
2. Prove registered scoring and player-aware identities on hand/synthetic cases.
3. Run the fixed chronological evaluation, all required strata and separate modes.
4. Verify repeated logical hashes, complete-path work and speed, domain/boundary
   tests and both PostgreSQL suites; prepare compact receipts for owner review.

Every metric uses pooled/per-season groups and n=2–4/5–8/9–16 strata, including
empty cells. Thresholds are fixed at 199.5/224.5/249.5/274.5/299.5. Preserve
positive-infinite log loss in cases and aggregates, show Over/Under calibration,
and score unnormalized integer RPS once per player-game. Market comparison is
unavailable without genuine captured pre-cutoff player-prop lines.

## Preliminary feasibility evidence

The pre-approval synthetic probe processed 2,504 examples / 12,520 threshold
cases in 43–72 ms over six trials using existing math and real local ObjectStore.
Database responses were stubbed; RPS and stratified aggregation were absent.
OS/file caches were unflushed. This is preliminary evidence, not a final speed
or PostgreSQL pass. The final measurements retain misses and state their full
boundary and cache state. No target is relaxed after observing results.

## Step 1 checkpoint

The [input-pins receipt](evidence/feature-store-164/step-1-input-pins.json)
records a passing rebuild from all 16 exact files on the standard 512 MiB local
PostgreSQL container. Retrospective examples by season are 595 / 632 / 644 / 633
(2022–2025), totaling 2,504 with the required natural content hash. Strict PIT
has zero eligible forecasts; its 7,465 evaluation candidates remain explicitly
feature-unavailable. Historical labels can be known at the later label checkpoint
without qualifying a forecast at its historical pregame cutoff.

Both cohort reads measured three SQL statements, two batched rights/status
checks and one dataset object read, with no per-example SQL or raw source reads.
The full pin and coverage artifacts are local ObjectStore addresses in the
receipt; they are not committed. The disposable scratch databases were removed.
No real-data scoring or completed-report timing claim is made at this checkpoint.
See the [validation receipt](evidence/feature-store-164/step-1-checkpoint.json).

To reproduce, use Node 24, the preserved raw ObjectStore root referenced by
#138's ingestion receipt, and the standard disposable database:

```sh
docker compose --env-file /dev/null -f compose.test.yml up -d --wait postgres
env -i PATH="$PATH" TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/evaluation-prepare.ts
```

The clean environment prevents application credentials entering the scratch
harness. A missing or mismatched pinned file fails setup rather than fetching a
new revision. The normal preparation path performs no scoring and keeps full
artifacts outside the checkout.


## Step 2 checkpoint

The public domain API `@dfs-ev/domain/qb-evaluation` adds the registered report
scorer. It reuses the existing empirical kernel and three-class probability
scorer; the strict fitter and its existing math/refusals are unchanged. The new
RPS implementation uses the pairwise empirical formula, proven against six
hand-calculated fixtures and an independent integer-CDF sum.

Fold identities contain player/game/history policy; threshold-case identities
contain player/game/threshold. Opposing QBs remain distinct, and duplicate folds
are refused. Predictions use lagged history only. Coverage records remain
separate from scored examples so missing labels never become zero outcomes.

Reports include pooled and per-season groups, all three registered sample-size
strata, and an additional unassigned coverage group for n=0–1. Empty cells stay
visible. RPS counts folds once; threshold metrics count five cases per fold.
Calibration bins retain empty cells and exact zero/one probabilities. Infinite
log loss remains infinite in threshold and combined aggregates, with explicit
case counts/fractions. Chronological history reuse is recorded without claiming
independent folds.

The [synthetic receipt](evidence/feature-store-164/step-2-synthetic-math.json)
records six native Node 24 runs over 2,504 synthetic folds / 12,520 cases:
142–181 ms for calculation plus logical JSON serialization, with the same report
hash every time. No database, connection setup, source reads or object writes
are inside that measurement. The full 7.5 MB synthetic report stays in local
ObjectStore. This is partial-path feasibility, not the completed-report gate.

The [validation receipt](evidence/feature-store-164/step-2-checkpoint.json)
records 56 passing projection tests, standalone domain and repository typechecks,
repository lint/boundary checks and 12 CI/layout checks. No real evaluation has
run. Reproduce the synthetic-only probe with Node 24:

```sh
node services/pipeline/scripts/feature-store/evaluation-math-spike.ts
```


## Step 3 checkpoint

The [evaluation receipt](evidence/feature-store-164/step-3-evaluation.json)
records the first registered evaluation of the pinned real cohort. Exact input
pins (including the preregistration and an aggregate identity over 26
runtime/setup code hashes) were written before scoring. Two independent fixture rebuilds retained the same
natural cohort hash and logical report hashes. The first run's detailed receipt
is retained in local ObjectStore; the compact checkpoint records its reference.
No scoring policy, threshold or smoothing changed after observing results.

The flagged retrospective report contains 2,504 chronological player-game folds
and 12,520 fixed-threshold cases. Season counts are 595 / 632 / 644 / 633;
pooled sample-stratum counts are 176 (n=2–4), 233 (n=5–8), 2,095 (n=9–16).
The [compact score summary](evidence/feature-store-164/step-3-score-summary.json)
retains all 25 season/sample groups per mode. Detailed threshold scores,
Over/Under calibration bins, case identities and history membership stay in the
ObjectStore reports referenced by SHA-256. Empty cells remain explicit.

| Retrospective pooled metric | Result |
| --- | --- |
| Three-class Brier, equal mean of five thresholds | 0.37277348 |
| Binary Over Brier, equal mean of five thresholds | 0.18638674 |
| Unnormalized integer RPS, once per fold | 50.90145845 |
| Natural log loss | positive infinity |
| Impossible observed outcomes under the empirical support | 183 / 12,520 (1.4617%) |

Positive-infinite log loss is preserved in the cases and every affected
aggregate. It is an expected weakness of unsmoothed empirical frequencies, not a
reason to clip or tune the registered baseline. There is no calibrated-product,
ROI or comparative-win claim. Genuine captured market lines are absent, so market
comparison is unavailable. Previously evaluated outcomes enter 2,387 later folds
as lagged history; the report explicitly rejects an independence claim.

Of 7,465 retrospective evaluation candidates, 5,602 have usable features and
2,623 have usable labels, with 2,504 in their scored intersection. The disjoint
selection exclusions are 1,863 feature-unavailable and 3,098 label-unavailable.
Missing-feature and missing-label totals overlap; they are not summed as separate
people. The ledger retains missing participation/stats and unresolved history
reasons. It records 115 known zero-attempt evaluation candidates and 4,841 whose
attempt status is unknown; absent stats are not zero outcomes. All observed QB
stat rows match a roster/game join. Six 2022 roster rows lack a scheduled-game
match; this gap is reported separately from the joined candidate population.
These diagnostics describe the captured fixture, not population completeness.

Strict PIT is separate, with zero forecasts and 7,465 explicitly unavailable
feature candidates. Its later label checkpoint can know historical outcomes
without making historical forecasts available. No knowledge timestamp is
backdated. Both reports retain the 1,916 warm-up candidates separately, with no
2021 target scored. Retrospective outputs carry
`historical-availability-unverified`, `rightsScope: research` and the
uncalibrated interim hit-rate designation.

`withDatasetRead` extends the existing reader's guard through trusted calculation
and private report staging. The three statements are manifest lookup,
authorization and pre-delivery recheck. There are no reader table locks or open
transactions across I/O. A revocation during calculation or upload refuses the
return value; newly staged report bytes are removed on refusal. A source deletion
during calculation also refuses delivery. The ordinary `readDataset` API delegates
to the same operation and retains its previous behavior and work budget.

Reports are private, dataset-bound research artifacts. An archived address is
not a public-serving entitlement: any later delivery requires fresh rights/status
authorization against its pinned dataset. Revocation between the final SQL
snapshot and bytes leaving the process is the accepted delivery-window limit.
There is no report-serving endpoint in this issue.

Three alternating warm rounds per mode on the standard 512 MiB PostgreSQL
fixture completed in 485–504 ms (retrospective) and 880–927 ms (strict). The
boundary includes pin/coverage/dataset reads, three SQL statements, scoring,
serialization, report upload and final rights/status check. Each trial measured
exactly two batched checks, three object reads and one report write, with zero
raw-source or per-example queries. Setup/reconstruction and connection setup
are excluded; caches were unflushed and no scored result was reused. These are
warm checkpoint measurements, not the final cold/warm latency verdict. Fresh
restricted-connection trials, percentiles and both full database suites remain
step 4. Local probes cannot represent Vercel boot or Neon compute wake.

The [validation checkpoint](evidence/feature-store-164/step-3-checkpoint.json)
records 17 focused PostgreSQL cases, 56 projection tests, typecheck, lint,
boundaries and layout/CI checks. Scratch databases and the disposable container
were removed. Reproduce using the clean environment shown for preparation,
substituting `evaluation-run.ts` for `evaluation-prepare.ts`.


## Step 4 checkpoint

The [capacity receipt](evidence/feature-store-164/step-4-capacity.json) records
40 completed reports across ten alternating rounds of cold/warm and both evidence
modes. Every request completed below the 7,000 ms target and 10,000 ms deadline;
no errors, misses or censored observations were removed. This is an absolute
target probe, not an optimization comparison. Cold/warm order reverses every
other round, with no scored-result reuse. OS, file and PostgreSQL caches remain
unflushed. Repeated immutable writes can find the existing report address and
validate its bytes; the first report of each mode also exercises creation.

| Evidence mode | Request state | Runs | p50 | p95 / maximum |
| --- | --- | --- | --- | --- |
| Retrospective | Fresh process and connection | 10 | 513 ms | 537 ms |
| Retrospective | Existing process and connection | 10 | 474 ms | 507 ms |
| Strict PIT | Fresh process and connection | 10 | 941 ms | 962 ms |
| Strict PIT | Existing process and connection | 10 | 893 ms | 931 ms |

The cold gate starts before opening the fresh restricted connection and ends
after report persistence and the pre-delivery check. Node startup and ObjectStore
initialization are recorded separately; local end-to-end p95 including those
stages is 616 ms retrospectively and 1,020 ms strictly. Every query, calculation,
serialization and object-write duration is retained in the full ObjectStore
receipt. Ten observations make nearest-rank p95 equal the maximum: these establish
ample local headroom, not a precise production tail estimate. Local Node boot
does not model Vercel boot or a Neon compute waking from scale-to-zero.

All 40 reports used exactly three SQL statements, two batched rights/status
checks, three object reads and one report write. No query reads normalized raw
evidence, feature rows or label rows during report execution. The same work
budget now runs in CI at 2 and 130 examples; the opt-in probe proves it at 2,504.
The restricted connection factory issues only reader membership. Each cold
trial starts a native Node 24 process, using generated scratch credentials over
IPC and no application configuration. Process startup is measured separately
from the gated connection-plus-request path.

Fresh input pins bind the exact file/content hashes, versions, preregistration
and aggregate of 29 setup/runtime file hashes before scoring. The logical hashes
match step 3 across all trials and this independent fixture rebuild:

- Retrospective: `e8bf09a84fda43f2c19fc28e5a7c78be430ec74eadec660a80270590bc532dfa`.
- Strict PIT: `5e7673b10b88f945bc7cfdd2a0d062de9217ecf2d8ecd00ae69b9a9a6bdd2d0e`.

The registered scores and coverage are unchanged. Infinity remains visible;
strict PIT still has no forecast-qualified historical evidence. No smoothing,
calibration, market-price substitution or policy tuning was added.

The [final checkpoint](evidence/feature-store-164/step-4-checkpoint.json) maps each
acceptance criterion to a verdict. Both full PostgreSQL suites passed on the
standard 512 MiB fixture: 79 feature-store cases; aggregate migration/catalog,
readiness, lease and corpus checks, including 25 PostgreSQL Vitest cases and
74 required Node cases. Guards, lifecycle and 12 catalog contracts passed.
Disposable databases and the container were removed. No frozen database asset,
legacy fitter, existing empirical adapter, UI, workflow or lockfile changed.

The initial default-concurrency application run recorded four existing
5-second test timeouts (AuthStatus, ConnectionIndicator, creator capture-store
concurrency and creator CLI). The complete retry with two workers passed all
909 tests, and the Node lane passed 268, including the 56 projection tests.
No timeout, assertion or application code changed. Both outcomes and full log
hashes are retained; hosted CI still needs to pass at its configured concurrency.
Repository/domain typechecks, lint, seven boundary probes and 12 layout/CI
checks pass. Full reports/traces/logs remain local ObjectStore artifacts; Git
receives compact verdict/hash/count/timing receipts.

Reproduce the opt-in capacity matrix with the clean local environment above,
using `evaluation-benchmark.ts`. The full CI database sequence is
`test:db:guard`, `test:db:lifecycle`, `test:db:local`, then a fresh standard
container for `test:feature-store:db` and cleanup. This completes implementation
and local acceptance proof; owner approval precedes the final commit, fresh
consent precedes pushing/opening the PR, and independent review precedes merge.
