# #138 feature-store thin-slice spike roadmap

Status: approved by Vernon, amended 2026-10-17. Main-based worktree
`feature/dfsEV-138-feature-store-spike`; initial design commit `861c406`.
This roadmap records owner authorization to implement the spike, not permission
to commit, push, freeze a migration, deploy or merge.

## Design basis

- **Pattern:** the approved feature-store / ELT design: immutable content-addressed
  snapshots, trusted versioned jobs, materialized features/labels, a set-based
  point-in-time dataset join and source-level rights plus lineage governance.
- **Alternatives:** per-read evidence reconstruction repeats ingestion validation
  and missed capacity targets; caller-computed certificates cannot guarantee
  correct values without the trusted job; refreshed views keep the old graph cost.
- **Targets:** copied below, with both deadlines and required 30% headroom.
- **Requirement reasons:** pipeline-only writes prevent forged derived values;
  database clocks prevent backdating; ObjectStore isolates local/hosted storage;
  no reader table locks avoids the old blocking design; keep every failure in
  evidence to avoid selective benchmark reporting. Preserve 0001–0011 to avoid
  changing committed history. Proposal SQL is not a production migration.
- **Assumptions:** local execution with disposable PostgreSQL; eventual hosted
  deployment; outsiders/application bugs, not a malicious database owner;
  retrospective histories do not establish captured historical availability.

## Approved sequence and acceptance mapping

| Step | Deliverable | Acceptance coverage |
|---|---|---|
| 1 | Source inventory, scoring preregistration, amended roadmap | Real fixture, licenses, temporal/scoring policies and design basis |
| 2 | ObjectStore local adapter; proposal schema, clocks, idempotent jobs and roles | Create-once behavior, main-only code, trusted writers |
| 3 | Validated ingestion, normalization and as-of selection | Real sources, corruption refusal, cutoff boundaries |
| Owner checkpoint | Progress, remaining time and risks after step 3, before continuing | One-week timebox and premise/target review |
| 4 | Feature and label jobs, correction scenario, lineage | Derived values, superseded flag and last-valid fixture |
| 5 | Dataset file/manifest, rights and deletion probes | Point-in-time membership, hashing, reproducibility, invalidation |
| 6 | Empirical baseline, walk-forward scores, local prediction path | Evaluation and prediction latency |
| 7 | Repeated cold/warm benchmark and deterministic work counts | Every target, evidence JSON, explicit verdicts |
| 8 | External confirmations, GCS gated test, final acceptance audit | Dedicated storage credentials, vendor details and final go/no-go |

## Owner amendments

- Authorization: one batched status/rights query. Pre-delivery recheck: one
  further batched query. **Two total**, constant regardless of row count.
  No per-row verification calls; fixed dataset-build statement count.
- ObjectStore: put-if-absent, get, head, list and delete. All persisted source
  and pipeline artifacts go through it; byte removal cannot bypass it.
- History: at most 16 prior eligible REG games, minimum 2, cutoff one hour before
  kickoff; 2021 warm-up and 2022–2025 chronological evaluation. Record exclusions.
- Preregister fixed half-yard thresholds 199.5/224.5/249.5/274.5/299.5 and integer
  whole-distribution RPS. Commit the preregistration before the first evaluation
  to prevent scoring choices after observing outcomes. Genuine captured market
  lines only; report every metric by sample count 2–4 / 5–8 / 9–16. Preserve infinity.
- Participation/identity gaps are reported and do not block the spike. Population
  completeness remains #54 work; unavailable individual records are not invented.
- Retrospective reconstruction using corrected historical facts is approved, with
  `historical-availability-unverified` flags and separate strict point-in-time
  results. Actual snapshot timestamps remain unchanged.
- Deletion grace is configurable: default 300 seconds for eventual Production,
  shortened explicitly in tests. No Production command is authorized here.
- Absolute deadlines require repeated cold and warm runs. ABBA interleaving is
  required only when comparing an optimization with the original implementation.
- About one week total; report a checkpoint after step 3 before continuing.

## Measurement contract

| Operation | Deadline | At least 30% headroom |
|---|---:|---:|
| One season file: download, validate, store, normalize | 60 s | ≤42 s |
| One full season feature job | 120 s | ≤84 s |
| Five-season dataset join, write and hash | 30 s | ≤21 s |
| One prediction, p95 | 300 ms | ≤210 ms |

Use at least three measured cold and three measured warm trials for each
absolute workload; report all attempts. For prediction p95, use at least 100
requests per trial, retaining individual latency samples. Cold means a new
process/connection, no application cache and no reusable job output; report
database/OS cache state explicitly rather than claiming a flushed disk cache.
Warm reuses process/cache state but still executes the measured job; an idempotent
no-op is a separate measurement, not a successful full recomputation benchmark.
Every ingest trial downloads the file; a cached local copy cannot substitute for
network time. No wall-clock deadlines in normal CI.

Before an optimization comparison, capture the original implementation SHA and
identical fixture hashes. Run at least three ABBA blocks on the same environment,
separately for cold and warm workloads. Check result/hash parity, keep timeout
failures as censored measurements and never omit them from the report.

Evidence records machine/runtime/database versions, code/policy/input hashes,
trial mode, full measured boundaries, durations, query/verification counts and
pass/fail verdict per target. An unresolved external prerequisite is `blocked`,
not `pass`; a measured miss is `fail`. Report findings without relaxing targets.

## Boundaries and current state

Only `db/proposals/` may receive SQL. Do not edit ordered migrations, change other
worktrees or import retired graph/recorder/cache code. Port only the pure
parsers/policies and codec listed in the platform design, with provenance recorded.
No scheduled hosted jobs or product UI integration in this spike.

Step 1 was committed with owner approval at `6aa7953`: [sources](feature-store-spike-sources.md),
[inventory evidence](evidence/feature-store-138/source-inventory.json), and
[scoring preregistration](feature-store-spike-preregistration.md). The preregistration
therefore precedes evaluation. Vernon approved the step 2 commit on 2026-10-17;
see the historical implementation checkpoint below. Step 2 was committed at
`13ac8ce`. Step 3 was approved and committed at `b9b6f81`. Step 4
was approved and committed locally at `d07f42c`.
Real-source ingestion and feature/label qualification have run; evaluation has
not run and the full spike capacity gate remains incomplete. Pushing needs fresh owner consent;
owner-run Codex review remains required.

GCS live tests pause for owner confirmation of Blaze, budget and a dedicated
bucket-scoped pipeline service account. Never use the app Firebase admin key,
because that would cross the approved credential boundary. Neon configuration
verification remains read-only and uses only an owner-designated non-production
connection if actual configuration is inspected.

## Step 2 local checkpoint

Pattern remains trusted ELT plus immutable content-addressed object storage.
There is no new cache, reader lock, evidence graph or architecture exception.
The local adapter uses atomic create-if-absent filesystem links; overwrite-by-rename
would break immutability, while adding a lock service is unnecessary for a
create-once primitive. Reads do not rehash bytes: validation belongs to ingestion
and later recompute audits. `head` reports size and the digest encoded in the key;
it is not an integrity certificate.

- `ObjectStore` has put-if-absent, get, head, namespace list and idempotent delete.
  Keys are `raw|datasets|models|audits/<wire-sha256>` without media suffixes. Binary
  bytes are preserved. Repeated writes validate existing bytes and refuse corruption.
  The local adapter uses an existing canonical private directory and bounded files
  (default 256 MiB). Its root and parents are controlled by the pipeline's OS user,
  just as bucket administration is trusted. Concurrent deletion may make an in-flight
  operation fail safely; step 5's delayed cleanup prevents normal delivery races.
- `db/proposals/138_feature_store.sql` creates isolated `fs138` objects alongside
  main's 0001–0011. The proposal is mutable spike SQL, applied in a single scratch
  transaction. It contains profiles, append-only rights/snapshots, job identities
  and four normalized families. Feature/label/dataset/model tables arrive in their
  later roadmap steps, with the same role checks extended to them.
- `fs138_pipeline_writer` owns no tables and can insert derived rows. It cannot
  overwrite normalized rows, disable triggers or backdate knowledge timestamps.
  `fs138_reader` has SELECT only. Neither role has schema CREATE or DELETE; a later
  narrow governance path handles mandatory deletion. No default writer grants are
  assumed for future tables, to prevent silently widening access.
- Database `clock_timestamp()` stamps profile/rights/job knowledge time, snapshot
  ingestion and job completion. Actual source publication/capture times remain
  separate. The rights probe proves a new decision is excluded by an earlier
  knowledge cutoff; the application rights selector is still step 5 work.
- Job identity includes kind, input-set digest, code SHA and policy digest. Only
  the insert winner executes. Retrying an existing running/failed/succeeded identity
  returns its state; automatic retry/recovery of abandoned jobs is not implemented.
  Helpers use short default READ COMMITTED operations. A stronger caller isolation
  level may refuse an invisible concurrent identity; it cannot duplicate execution.

Validation: seven ObjectStore tests, eight PostgreSQL behavior probes (plus their
parent test), typecheck and changed-file ESLint pass on Node 24.18.1. The SQL suite
uses three actual restricted logins on PostgreSQL 18.6, and verifies main's catalog
and frozen migration hashes before/after. The first SQL attempt failed because a
test parameter was inferred as both `text` and the digest domain; the dependent
normalized-row test also failed. Explicit casts fixed the fixture, and the focused
rerun passed. Both attempts are retained:

- [Initial SQL probe](evidence/feature-store-138/step-2-schema-initial.json)
- [Passing SQL probe](evidence/feature-store-138/step-2-schema.json)
- [ObjectStore test report](evidence/feature-store-138/step-2-objects.json)
- [Checkpoint results and source hashes](evidence/feature-store-138/step-2-checkpoint.json)

Reproduce using Node 24 and locked dependencies (`npm ci`), with no application
credentials or `.env` loading:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts tests/predictive/featureStoreObjectStore.test.ts
docker compose --env-file /dev/null --project-name dfs-ev-demo-test -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test npm run test:feature-store:db
docker compose --env-file /dev/null --project-name dfs-ev-demo-test -f compose.test.yml down --volumes
```

These are synthetic correctness probes, not a capacity result or real-data proof.
All four absolute performance targets remain unmeasured. Raw download validation,
the normalizer/as-of reader, end-to-end rights delivery, correction/deletion/audit
probes and GCS tests remain in later steps. Abrupt termination can leave a hidden
local temporary write; it cannot be listed as a complete object. Temporary-file
housekeeping and committed-object orphan recovery remain step 5 cleanup work.

Remote main advanced to `6863d8f` during this step (the #135 UI changes and
development dependency updates). This checkpoint is tested on the #138 base,
not that newer integrated state. Integrate and recheck before a final PR;
no other worktree or branch has been changed here.

## Step 3 owner checkpoint

Historical checkpoint: owner approved this step, committed as `b9b6f81`. At
that checkpoint no evaluation, feature, label, dataset, model or app prediction
had been produced. The step-3 receipts below remain unchanged. Step 4 results
appear after its design basis.

### Design basis and implementation

The approved trusted-ELT pattern is unchanged. Jobs validate immutable source
bytes once, normalize them in bulk, and stamp ingestion with the database clock.
The internal as-of selector is one set-based query over normalized tables; it
does not reopen files, re-prove evidence or lock reader tables. End-user delivery
rights checks arrive in step 5; this selector is an internal pipeline primitive.

Two rejected alternatives remain relevant: retaining caller-computed graph
certificates would duplicate policy and restore the failed read cost; doing
rights/byte validation per normalized row would violate the fixed-work delivery
budget. Source snapshots record current license evidence without claiming that
research-source qualification is commercial clearance.

- Download/normalization is bounded: 64 MiB wire bytes, 192 MiB decoded bytes,
  100,000 rows, 1 MiB CSV record and a 60-second operation deadline. HTTPS
  redirects are allowlisted; transparent content decoding is refused so the
  stored hash identifies exact downloaded bytes. Gzip CRC, UTF-8, expected
  columns, widths, digests and numerical fields are checked before publication.
- Normalization retains REG QB statistics (including zero attempts), weekly
  QB identity/roster claims, 2021–2025 schedules and positive offense
  participation. Missing participation is unknown, not a zero result. Conflicting
  duplicate keys become ambiguous; a malformed player list supplies no positive
  evidence. Eastern kickoff conversion rejects ambiguous/nonexistent clocks.
- Successful ingestion uses ten SQL statements regardless of normalized row
  count. Snapshot and normalized rows commit together. Retries return the existing
  job state; failed or still-running jobs do not silently execute again.
- Raw storage uses ObjectStore exclusively. A failed database publication may
  leave a discoverable content-addressed object; step 5 owns grace-period orphan
  cleanup. Immediate rollback deletion is avoided because another concurrent job
  could already reference the same bytes. Abrupt termination may also leave a
  hidden temporary file; housekeeping remains step 5 work.
- Provenance includes the actual base Git SHA plus an implementation-content
  manifest digest in job policy and snapshot metadata. The receipts do not claim
  that uncommitted step-3 code is contained in the step-2 Git commit.
- `strict-point-in-time-v1` requires both availability and ingestion at or before
  cutoff. `retrospective-reconstruction-v1` uses corrected prior-game facts at a
  pinned ingestion checkpoint, always flagged `historical-availability-unverified`.
  Timestamps are preserved. Equal-time rival snapshots remain ambiguous and
  unknown normalizer versions are excluded.

### Real-file qualification

Both complete runs downloaded and ingested all 16 files in fresh disposable
databases through real restricted pipeline logins. The first created the raw
objects; the second reused their immutable addresses, but still downloaded,
validated and normalized every file. Both produced the same normalized-content
digest, `2861cd0f0fd08dc808c14c7124fdc11a154baaffa8d9e958c071121ffc0bc41d`.

The final run processed 246,304,787 wire bytes, taking 0.870–3.903 seconds per
file (first run: 0.876–5.490 seconds). Each file used ten SQL statements; each
as-of selection used one. Peak process RSS was 547,733,504 bytes (about 522 MiB)
in the final run; the first peaked at 617,529,344 bytes. These are qualification
observations, not the required repeated cold/warm capacity verdict. No optimization
comparison or ABBA claim is made.

| Season | REG games | QB-stat rows | Zero-attempt rows | Missing identity/schedule | Missing positive participation |
|---|---:|---:|---:|---:|---:|
| 2021 | 272 | 655 | 41 | 0 | 0 |
| 2022 | 271 | 633 | 16 | 0 | 0 |
| 2023 | 272 | 663 | 30 | 0 | 0 |
| 2024 | 272 | 664 | 33 | 0 | 0 |
| 2025 | 272 | 664 | 36 | 0 | 1 |

The total is 3,279 QB-stat rows across 1,359 REG games; 156 QB rows have zero
attempts. Reconstruction returns 103,468 normalized rows across all four source
families. Strict historical selection returns **zero**: the current files were
not ingested at the historical cutoff. These data do not establish historical
availability or a usable prospective model.

One QB-stat row lacks positive offense participation: player `00-0029263` in
`2025_01_NYG_WAS` (37 attempts, 168 yards). It remains an explicit gap for the
feature/label eligibility job, rather than a qualified label. This spike does
not prove population completeness; that remains #54 scope.

The 2024 participation file has one malformed REG player list: data-row ordinal
26,090, `2024_02_CLE_JAX`, play `1985`, possession team `CLE`, with duplicate
player `00-0029008`. That play is excluded from positive evidence. It produces
no additional QB coverage gap; a supplemental ObjectStore inspection records
the exact location and reproducible recipe.

The schedule release changed after the initial inventory: `games.csv.gz` grew
from 515,248 to 515,250 bytes. Both ingestion runs pinned current release digest
`962ea33bc96c7b5d298c28b5d8d8b64309ee2ddb450806bf3634fd10c0386dbd`.
Their 2021–2025 normalized results match. The source manifest preserves current
asset metadata separately from the earlier inventory.

### Validation and evidence

Fourteen focused unit tests pass: seven ObjectStore and seven transport/normalizer
cases. Eight new PostgreSQL probes (plus their parent) pass, covering atomic
ingestion/retry, both inclusive cutoff clocks, reconstruction/checkpoint refusal,
corrupt gzip, correction history, equal-time ambiguity, rollback/failed jobs and
the fixed ten-statement budget at 1 and 64 rows. Eight existing schema/permission
probes (plus their parent) also pass against the expanded proposal. They confirm
actual non-pipeline refusal, DB clocks, immutable normalized rows and unchanged
main catalog/frozen migrations. Typecheck and changed-file ESLint pass.

- [Checkpoint verdicts, checks and hashes](evidence/feature-store-138/step-3-checkpoint.json)
- [Final real ingestion](evidence/feature-store-138/step-3-real-ingestion.json)
- [Current source manifest](evidence/feature-store-138/step-3-source-manifest.json)
- [Initial real ingestion](evidence/feature-store-138/step-3-real-ingestion-initial.json)
- [Initial source manifest](evidence/feature-store-138/step-3-source-manifest-initial.json)
- [Participation anomaly](evidence/feature-store-138/step-3-participation-anomaly.json)
- [Unit tests](evidence/feature-store-138/step-3-unit-tests.json)
- [Ingestion/as-of PostgreSQL probes](evidence/feature-store-138/step-3-integration.json)
- [Schema/permission regressions](evidence/feature-store-138/step-3-schema-regression.json)

Reproduce the focused unit and DB probes with Node 24 and the local Compose
database described in step 2. `npm run test:feature-store:db` now includes both
schema and ingestion probes serially. Opt-in real ingestion is
`npm run feature-store:ingest:spike -- ../dfs-ev-demo-138-data/objects`, with
`TEST_DATABASE_URL` pointing only to the disposable local test database. It needs
public GitHub access and downloads all 16 files again. Supplemental inspection:
`node scripts/feature-store/inspect-participation.ts`.

Raw objects remain in the private sibling directory
`/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-138-data/objects`; they are
accessed through ObjectStore and not committed. Scratch normalized databases are
dropped after each proof; recipes, source metadata, hashes and results remain.

### Remaining work and risks

Steps 1–3 are implemented in this first day. Steps 4–8 still remain: feature/label
jobs and supersession; dataset materialization, rights delivery, two-step deletion
and audits; empirical walk-forward scoring and predictions; repeated capacity
gates; external confirmations. No remaining-days forecast is established. The
approved total timebox is about one week, so scope/capacity findings return to
the owner rather than silently extending it or weakening targets.

| Target | Step-3 verdict |
|---|---|
| Ingest ≤60 s, with ≤42 s headroom | Both qualification runs meet the per-file limit; required ≥3 cold/≥3 warm trials remain pending |
| Season features ≤120 s, with ≤84 s headroom | Not measured; step 4 implementation pending |
| Five-season dataset ≤30 s, with ≤21 s headroom | Not measured; step 5 implementation pending |
| Prediction p95 ≤300 ms, with ≤210 ms headroom | Not measured; step 6 implementation pending |

The source-license chain for schedules remains unresolved beyond the release
repository declaration; no commercial-clearance claim is made. Historical
availability is unverified and the participation gap above remains. Rights
delivery, deletion and orphan/temp cleanup are not complete. Pipeline-only writes
are proven for normalized tables, with later derived families still to be added.
The GCS test remains blocked on owner confirmation of Blaze, budget and a
dedicated pipeline service account; Neon timeout/configuration confirmation is
also pending. Nothing uses the app Firebase admin key or a hosted database.

Latest observed `origin/main` is `12290d8`; this branch is three commits ahead
and twelve behind. Integration is pending before the final combined checkpoint.
Only proposal SQL changed; ordered migrations and other worktrees are untouched.

## Step 4 design basis (approved requirements)

**Pattern:** set-based, typed ELT with windowed bitemporal snapshot selection,
append-only feature/label versions and snapshot-level lineage. One context query
handles a season, rather than calling a function for each example. Features use
at most 16 qualified prior REG outcomes, minimum two, with cutoff one hour before
kickoff. Labels are materialized separately at their pinned label checkpoint.

**Alternatives:** per-example `readNormalizedAsOf` repeats the 103k-row JSON union
scan; per-example TypeScript fetches make SQL work grow with the cohort. Both
are rejected. A shared label/feature payload risks target leakage; the two output
tables and materialization queries keep outcome values out of feature payloads.

**Targets:** season feature job ≤120 seconds with ≥30% headroom (≤84 seconds),
constant statement count as examples grow. Repeated cold/warm trials will cover
real seasons; no idempotent no-op counts as a recomputation trial.

**Requirement reasons:** SQL excludes the target game and every game with kickoff
at/after cutoff in both modes to prevent outcome leakage. Only snapshot eligibility
differs between modes. Missing/ambiguous participation, identity, completion or
stats produce explicit unavailable labels to prevent fabricated zero outcomes.
Snapshot-level lineage avoids a row-granular evidence graph. Synthetic correction
fixtures are identified separately so they cannot masquerade as observed changes.
DB clocks stamp computed/known time; append-only values preserve prior checkpoints.

**Assumptions:** trusted pipeline code, disposable local PostgreSQL, pinned source
checkpoint and normalizer version, owner-approved historical reconstruction. A
checkpoint-based candidate inventory can enumerate a strictly unavailable case;
that is coverage accounting, not evidence of its historical availability. Lineage
initially cites the pinned job snapshot set for each output, conservatively
invalidating the job's outputs if a contributing source is deleted. This is bounded
at 16 source snapshots for this fixture and is not a row-closure system.

## Step 4 owner checkpoint

Status: ready for owner review; implementation is uncommitted on `b9b6f81`.
Nothing pushed. Stop before step 5. All SQL remains mutable in `db/proposals/`;
main's 0001–0011 and generated schema/catalog contracts are unchanged.

### Implementation and temporal guarantees

One typed, set-based SQL statement materializes every example in a season. No
feature job calls `readNormalizedAsOf`, scans the JSON union, reads ObjectStore
bytes or issues queries per example. A shared SQL context function is SECURITY
INVOKER with qualified relations and inlinable; it selects snapshot heads over
typed `norm_*` tables. Window counts preserve equal-time ambiguity. `DISTINCT ON`
chooses an internal representative only alongside the tie count; ties refuse
usable output. Cohort histories and gap aggregates are MATERIALIZED once inside
the statement, preventing the planner from executing them again for each target.

Features and labels each use **eight statements** on a successful new job:
bulk-load `ANALYZE`, pinned input/checkpoint selection, job claim, BEGIN, local
timeout, one materialization including lineage, job completion and COMMIT. The
ingestion budget remains ten. ANALYZE is standard statistics maintenance;
pipeline MAINTAIN permission does not allow changing source/derived values.

The feature statement explicitly requires both `context_game_id <> game_id`
and `context_kickoff < cutoff`, before selecting at most 16 prior eligible REG
games. This is identical in strict and reconstruction modes. Only snapshot
eligibility changes. At least two qualified prior outcomes are needed; uncovered
prior candidates remain in `history_gaps`. Tied history kickoff ordering refuses
the affected feature. Target identity/schedule ambiguity refuses the target.
The target's yards are absent from its feature payload, and the feature job
never queries `outcome_labels`.

Labels use a separate materialization with explicit schedule, completion, stats,
identity/team and positive-offense-participation checks. Unknown or ambiguous
evidence produces `state=unavailable`, `value=NULL` and reasons. Qualified zero
yards remains zero. The DB stamps `computed_at`/`known_at`; pipeline grants are
INSERT-only for values and lineage. Actual restricted non-pipeline logins cannot
forge or mutate them.

Each output cites the pinned job snapshot set: 16 snapshots in the real fixture.
This is conservative snapshot-level dependency accounting. A later deletion may
invalidate more of a job than the exact contributing rows; step 5 must implement
that governance behavior. No row-level evidence graph or reader lock was added.

Corrections append rows with `supersedes_id`; existing values remain immutable.
Internal display helpers select the newest visible usable value. If the head is
unavailable, they retain that value with `stale=true`, `superseded=true` and
`last valid value; newer result unavailable`. These are local correctness
fixtures, not an end-user authorization/delivery API. Step 5 rights and mandatory
deletion take precedence over displaying retained values.

### Real output and repeated feature target

The exact step-3 ObjectStore bytes were verified and re-normalized into a fresh
scratch database. This setup is separate from feature timing and is not another
network-ingestion benchmark. No synthetic correction was applied to real sources.
The report pins source hashes, snapshot clocks/IDs, all job identities, snapshot
lineage and three representative audit examples (sample strata 2–4, 5–8, 9–16).
All reconstructed records carry `historical-availability-unverified`.

| Season | Candidates | Usable features | Usable labels | Usable pair |
|---|---:|---:|---:|---:|
| 2021 warm-up | 1,916 | 780 | 655 | 507 |
| 2022 | 1,838 | 1,204 | 633 | 595 |
| 2023 | 1,812 | 1,380 | 663 | 632 |
| 2024 | 1,867 | 1,482 | 664 | 644 |
| 2025 | 1,948 | 1,536 | 663 | 633 |

Totals: 9,381 candidate player-games, 6,382 usable features and 3,278 usable labels.
There are 3,011 usable pairs including warm-up; the 2022–2025 evaluation population
currently has 2,504 usable pairs. No scoring or evaluation has run. Candidate
inventory includes roster QBs with no outcome evidence; its unavailable labels
are intentional. Counts and reason frequencies remain in the report. Wilson's
2025 Week 1 participation gap remains unavailable; no zero was invented.

Strict mode generated 1,948 unavailable 2025 features and zero usable features,
as expected from today's ingestion clocks. The real-data SQL leakage check
returns zero target-game or kickoff-at/after-cutoff history entries across all
materialized feature versions. Reconstruction does not establish observed
historical availability or a prospective product.

The largest candidate season (2025, 1,948 examples) was recomputed in three
fresh-process cold trials and six warm trials. Cold and initial warm trials
alternate; the final three warm trials follow all other season feature/label
jobs to exercise sustained connection reuse. Cold time includes Node startup
and restricted connection establishment; no database/OS disk-cache flush is
claimed. Every call executes a new job, not an idempotent no-op.

- Cold: **3.513–3.556 seconds**.
- Warm: **3.388–3.577 seconds**, including sustained warm calls.
- All nine use eight statements and produce content digest
  `315806925202863e226a4a93f5d477b8a6d32cd38c5a4977a1d98f889bf242a9`.
- Verdict: **pass** for the one-season feature target, ≤120 seconds and ≤84
  seconds with required headroom, on this local fixture.
- Other seasons' feature qualification took 2.821–3.264 seconds; labels took
  1.524–1.686 seconds. These are qualification observations, not separate
  repeated-capacity claims.

The repeated append-only matrix exceeded main's 512 MiB disposable filesystem.
The passing fixture explicitly uses [a 2 GiB spike-only override](../compose.feature-store-spike.yml),
on Docker with 8,319,238,144 bytes of memory and 12 CPUs. Final trial database
size is about 200 MB, plus PostgreSQL cluster/WAL/temp overhead. Cumulative
`temp_bytes` counts bytes written over the run (about 2.45 GB), not simultaneous
disk usage. Peak Node RSS is 570,867,712 bytes (about 544 MiB). These measurements
are local capacity evidence, not demonstrated Neon/GCS readiness.

### Failed attempts and diagnosis

Failures remain visible; no speedup ratio or optimization-comparison acceptance
claim is made. Only the final absolute cold/warm target is accepted. An ABBA
comparison would be needed for a comparative performance claim.

1. The initial client timeout was 20 seconds while the SQL ceiling was 84
   seconds. Timed-out backend work continued; attempted rollbacks timed out and
   later calls overlapped. That matrix is invalid for latency comparison. The
   affected scratch queries were cancelled, execution disabled there and the DB
   dropped. Transport now allows 90 seconds around the unchanged 84-second SQL
   ceiling. An interrupted connection is flagged for replacement and receives
   no further query; a unit probe enforces that contract.
2. Corrected timeout handling exposed a real 84-second SQL-ceiling miss. The
   plan estimated single rows and chose nested loops. Typed tie-aware head
   selection plus ANALYZE corrected some of that, but passing initial calls did
   not establish sustained readiness; later calls still timed out.
3. Inlining alone also failed. Isolated profiling found the context SELECT took
   about 2.6 seconds, while the final plan nested history/gap aggregation below
   target joins. Materializing those cohort aggregates once fixed repeated work.
   The actual-plan regression now requires one execution of each aggregate.
4. The 512 MiB fixture ran out of filesystem space after retaining many full
   versions. The explicit 2 GiB fixture completes the same sustained workload.
5. The first `EXPLAIN ANALYZE` loop-count probe exceeded its 15-second harness
   default. Per-node clocks were disabled; the deterministic probe now uses the
   same 84-second statement/90-second transport ceilings as the job. No CI
   assertion depends on elapsed time. The first failure is retained.
6. A connection-cold matrix passed, then was explicitly superseded because the
   approved cold contract requires a fresh process. The final artifact includes
   distinct process IDs and the startup boundary.

### Correctness evidence and reproduction

Nine new PostgreSQL probes cover both-mode event filtering and target exclusion,
missing/zero labels, clearly synthetic corrections and historical replay,
ambiguous/superseded/stale output, equal-time rivals, pipeline permissions/clocks,
constant work from 8 to 260 examples, actual aggregate execution counts and
publication rollback. The eight existing ingestion/as-of and eight schema probes
also run against the completed proposal. Fifteen focused unit tests, typecheck
and changed-file lint form the remaining focused checkpoint. See the final
validation receipt for exact results and source hashes.

- [Checkpoint verdicts and hashes](evidence/feature-store-138/step-4-checkpoint.json)
- [Final real cold/warm evidence](evidence/feature-store-138/step-4-real-derived.json)
- [Final focused validation](evidence/feature-store-138/step-4-validation.json)
- [Derived PostgreSQL probes](evidence/feature-store-138/step-4-integration.json)
- [Ingestion regressions](evidence/feature-store-138/step-4-ingestion-regression.json)
- [Schema/permission regressions](evidence/feature-store-138/step-4-schema-regression.json)
- [Unit tests](evidence/feature-store-138/step-4-unit-tests.json)
- [Isolated SQL plan profile](evidence/feature-store-138/step-4-query-profile.json)
- [Initial invalid timeout matrix](evidence/feature-store-138/step-4-real-derived-initial.json)
- [SQL-ceiling miss](evidence/feature-store-138/step-4-real-derived-plan-timeout.json)
- [Sustained-plan failure](evidence/feature-store-138/step-4-real-derived-warm-plan-failure.json)
- [Inlining-only failure](evidence/feature-store-138/step-4-real-derived-inline-failure.json)
- [512 MiB fixture failure](evidence/feature-store-138/step-4-real-derived-storage-failure.json)
- [Superseded connection-cold run](evidence/feature-store-138/step-4-real-derived-connection-cold.json)
- [Initial timed plan-count probe](evidence/feature-store-138/step-4-plan-probe-timing-failure.json)

Reproduce with Node 24, locked dependencies and only the disposable
`TEST_DATABASE_URL` from step 2. No `.env` or application credentials are loaded.

```sh
docker compose --env-file /dev/null --project-name dfs-ev-demo-test -f compose.test.yml -f compose.feature-store-spike.yml up -d --wait
npm run test:feature-store:db
npm run feature-store:derived:spike
docker compose --env-file /dev/null --project-name dfs-ev-demo-test -f compose.test.yml -f compose.feature-store-spike.yml down --volumes
```

The proposal/harness applies main and proposal SQL only in registered scratch
databases. Raw bytes remain in the private ObjectStore directory from step 3;
the scratch DB is dropped after each proof. Durable receipts and audit examples
are retained, while full ephemeral DB outputs are reproducible from pinned bytes
and code. The correction fixture changes 9999 to 350, then introduces ambiguity;
these are fabricated test values, not an observed nflverse correction.

### Remaining acceptance boundary

| Target | Step-4 verdict |
|---|---|
| Ingest ≤60 s, ≤42 s headroom | Qualification passes; required repeated network cold/warm trials still pending |
| Season features ≤120 s, ≤84 s headroom | Pass on the 2025 full-season fixture, three fresh-process cold and six warm trials |
| Five-season dataset ≤30 s, ≤21 s headroom | Not measured; step 5 pending |
| Prediction p95 ≤300 ms, ≤210 ms headroom | Not measured; step 6 pending |

Rights authorization/delivery, mandatory deletion/invalidation, orphan/temp
cleanup, datasets and recompute audit remain step 5. No user-facing prediction
or statistical quality claim is made. Schedule license-chain qualification,
historical availability, the participation gap, main integration and external
GCS/Blaze/dedicated-account plus Neon checks remain as recorded at step 3.
No held legacy branches or hosted databases were changed. Stop for owner review
before further implementation, keeping the approved about-one-week timebox.


## Step 5 Design basis (owner-approved scope)

**Pattern:** immutable materialized training datasets with explicit version pins;
source-level batched authorization; tombstone-and-sweep deletion; lineage-driven
invalidation/recomputation and garbage collection of unpinned nonlatest values.

**Alternatives:** per-read evidence reconstruction repeats ingestion work and
missed prior capacity targets; reader table locks block writers through file
I/O; keeping all recomputable versions indefinitely causes unbounded growth.
Immediate byte removal races already authorized readers and is rejected.

**Targets:** full 2021–2025 input fixture; 2021 warm-up excluded from membership,
2022–2025 evaluation. Dataset join/write/hash ≤21 s against 30 s, three fresh
process cold plus three warm trials. Fixed SQL statement count and exactly two
batched rights/status queries per successful build/read. Absolute trials alternate
cold/warm; no optimization comparison or ABBA claim.

**Requirement reasons:** pin IDs, versions, separate feature/label selection
clocks and inclusion policy to prevent historical drift or silent mixing of
retrospective and strict evidence. Reject unavailable labels rather than invent
zero. Check current rights/deletion before I/O and before returning buffered
bytes because those states can change. Legal deletion overrides last-valid
display. Immediate tombstones invalidate dependents; ObjectStore cleanup waits
configurable grace, default 300 s. Short writer-only row locks serialize
publication with deletion; readers take no table or row locks. Governance APIs
check role membership and qualify references to prevent unauthorized erasure.

Pruning keeps the latest head and every dataset pin; only older unpinned values
are removed, with their lineage. Audit retains IDs/counts, not erased values.
Lineage is conservative within the seasons actually queried: features use
2021 through the target season; labels use the target season only. A shared
all-season schedule snapshot remains a genuine shared dependency. Restrict both
the context query and its snapshot inventory to that scope, so future-season
sources cannot invalidate earlier values. Compact receipts hash the exact ID
sets; full diagnostic files remain outside Git.

Object publication follows upload-then-publish: upload outside any transaction,
then briefly lock active inputs and the object address, HEAD-check existence,
digest metadata and size, and publish references. Cleanup takes the same address
lock. A cleaner winning before publication causes a missing-object refusal,
preventing dangling references. Recreated mandatory-deletion addresses are
requeued on failure so completed tombstones cannot strand newly uploaded bytes.
No upload holds database locks. ANALYZE runs after derived materialization, not
inside dataset builds. Normalization refreshes its own bulk-loaded table at
job end so the first derived job also starts with useful statistics. A separate natural-key/value hash excludes UUIDs and
knowledge clocks to distinguish logical reproducibility from exact-file identity.

**Assumptions:** trusted pipeline, untrusted app callers, trusted database owner;
bounded local files and short transactions; eventual hosted storage behind the
same interface. No hosted/GCS commands or scoring in this step. Future same-day
team/opponent features require **final stats known before cutoff**, not merely
kickoff before cutoff; those features are not implemented here.



## Step 5 owner checkpoint (review corrections)

Step 5 passed owner review and received local commit approval. Step 4 is
committed at `d07f42c`; nothing pushed. Evidence receipts retain the state at
measurement time, before owner approval. All SQL stays in mutable proposals. Ordered migrations
and generated artifacts match that approved checkpoint byte for byte.

### Review corrections

Feature jobs inventory snapshots containing normalized data from 2021 through
the target season; label jobs inventory only snapshots containing the target
season. Context and input selection share that scope helper. Lineage remains
conservative within those seasons, including rival and unavailable evidence.
Mixed-season files, including the all-season schedule, remain shared dependencies.
Future-season stats/roster/participation snapshots no longer invalidate earlier
values. This is season-level snapshot lineage, not row-level provenance.

Raw and dataset jobs upload through ObjectStore before BEGIN. Publication then
locks active inputs (datasets), takes the address lock, checks HEAD existence,
digest metadata and size, and inserts references. Cleanup uses the same address
lock. A cleaner winning before publication causes a missing-object refusal with
no dangling reference. Recreated mandatory-deletion addresses are refused and
requeued, including after a completed cleanup. Readers hold no table locks.

The exact-file SHA-256 covers IDs, selection clocks, source/rights pins, code and
values. The new content SHA-256 covers natural player/game/stat keys, algorithm
versions, evidence mode, event cutoff, sample size, ordered numerical history and
label value. It excludes UUIDs, knowledge clocks and freshness flags. Both hashes
are stored in the manifest/receipt; the content hash is also in the file. Tests
prove independent derived IDs/clocks keep the content hash, while changing a
label changes it. Re-materialized exact-file hashes differ.

ANALYZE is absent from dataset builds. Ingestion refreshes its bulk-loaded typed
table and metadata at job end; derived jobs refresh statistics after
materialization. This supplies statistics before the first derived job and
before subsequent dataset joins. Ingestion uses 12 statements, derived jobs 8,
dataset builds 8 and dataset reads 3. Successful builds/reads use two batched
rights/status checks regardless of row count. Benchmark counters measure those
checks in both cold and warm trials.

Only compact receipts remain in the worktree. Verbose reports, plans, code copies
and UUID sets are archived in the private sibling data directory; receipts retain
paths, byte counts and hashes. All new step-5 JSON receipts are under 32 KiB.
Existing committed evidence is preserved. Full datasets and scratch databases
are removed after tests; original raw objects survive.

### Repeated real-file dataset target

The exact 16 step-3 files were copied into an isolated ObjectStore root, normalized
and derived before measurement. 2021 is warm-up only. All included examples are
flagged historical-availability-unverified. No statistical evaluation has run.
Cold includes fresh Node startup, a restricted connection, ObjectStore open and
the complete build. Warm still performs the full join/write/hash. OS/DB caches
were not flushed. These are alternating absolute trials, not a speedup comparison.

| Trial | Cold ms | Warm ms | <=21,000 ms |
|---|---:|---:|---|
| 1 | 851.75 | 519.16 | Pass |
| 2 | 600.89 | 463.93 | Pass |
| 3 | 628.19 | 458.61 | Pass |

All six builds produce 2,504 examples and 3,527,908 bytes,
using eight statements and two measured rights queries. Exact-file hash:
`9db8868df7d807b43ba9514b63762455bbd29ca7300d824e11cf16cff075dc05`.
Natural-key/value content hash:
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
Both hashes agree across the six trials. Event-time leakage: zero.

| Season | Usable pairs | n=2–4 | n=5–8 | n=9–16 |
|---|---:|---:|---:|---:|
| 2022 | 595 | 62 | 67 | 466 |
| 2023 | 632 | 50 | 81 | 501 |
| 2024 | 644 | 25 | 51 | 568 |
| 2025 | 633 | 39 | 34 | 560 |

Exclusions: {"feature-unavailable": 1863, "label-unavailable": 3098, "warm-up-only": 1916}. They are evaluated
in order: warm-up, unavailable features, unavailable labels, flag policy.
Participation/identity gaps stay explicitly unavailable, never zero.

### Scoped deletion and retention proof

Deleting the isolated 2025 stats snapshot invalidates exactly
1,948 features,
1,948 labels and
6 datasets. The exact sorted ID
sets are checked against pre-deletion lineage and hashed in the receipt.
No earlier-season feature/label ID appears in those deletion sets.

Before any recomputation, all 5,517
2022–2024 features and 5,517
labels survive with identical IDs and every column value. Their complete-row
hash before and after deletion is:
`ed25fcad5e5478db4debffd9937ad6b2539aeee284e23f43abf27511f6c567f3`.
Zero 2022–2024 jobs reran. Only 2025 jobs rerun; missing stats keep all 2025
labels unavailable while features can still use surviving prior history. The rebuilt dataset contains
1,871 surviving 2022–2024 usable pairs.

Tombstones invalidate delivery immediately, then ObjectStore cleanup waits its
grace (default 300 seconds, one second in tests), starting after invalidation work.
Tests cover revocation/deletion during I/O, crash/resume, shared addresses and
publication races. Pruning preserves latest heads, last usable values and all
dataset pins; only other versions/lineage are removed. No automatic schedule is
installed for these local jobs.

### Failures and validation

Earlier timeouts and the grace-clock failure remain as compact receipts with
archived full diagnostics. The first review-correction setup also timed out at
the unchanged 84-second derived limit before dataset trials. Its plan severely
underestimated normalized populations and chose nested loops. The correction
keeps snapshot season scoping without redundant discovery row-season filters,
and places statistics maintenance in producing jobs. The single-job profile is
diagnostic evidence, not a repeated feature-capacity claim. No target or timeout
was relaxed. The final integrated setup completed before the dataset matrix.

Final focused validation: 40 PostgreSQL probes (13 dataset, 10 ingestion, eight
schema, nine derived), 15 unit tests, typecheck, ESLint and whitespace pass. Schema
probes verify pipeline-only writes, proposal rollback and unchanged main catalog
and frozen migration hashes. Full application/remote CI is not claimed.

- [Checkpoint and per-target verdicts](evidence/feature-store-138/step-5-checkpoint.json)
- [Dataset matrix and deletion survival](evidence/feature-store-138/step-5-real-dataset.json)
- [Dataset/governance probes](evidence/feature-store-138/step-5-integration.json)
- [Focused validation](evidence/feature-store-138/step-5-validation.json)
- [Retained setup failure](evidence/feature-store-138/step-5-real-dataset-review-statistics-failure.json)
- [Planner diagnostic](evidence/feature-store-138/step-5-producer-statistics.json)

| Overall #138 target | Status |
|---|---|
| Ingest <=42 s headroom | Repeated network cold/warm gate pending |
| Season features <=84 s headroom | Prior step-4 repeated pass; revised setup measured, no fresh repeated season matrix claimed |
| Dataset <=21 s headroom | Pass: all six cold/warm trials |
| Prediction p95 <=210 ms headroom | Not measured; later step |

Reproduce with the disposable Compose fixture, Node 24 and the local
TEST_DATABASE_URL: `npm run test:feature-store:db` then
`npm run feature-store:dataset:spike`. Remaining acceptance includes scoring,
predictions, other capacity gates, scheduled integrity/recompute audits,
operations, external qualification and main integration/independent review.
Future same-day team/opponent features require final stats known before cutoff.

Stop for review. GCS testing remains gated on the owner's Blaze upgrade, budget
and dedicated pipeline service account. No hosted writes, Production commands
or app Firebase admin credentials were used.


### Accepted carry-forward decisions after step-5 review

- **Lineage granularity:** season-scoped snapshot lineage is accepted for this
  spike. Deleting an earlier season can invalidate later-season features that
  cite it, even when an individual selected 16-game history uses no row from
  that file. This is conservative invalidation, not an exact-row dependency
  claim. Per-row lineage is deferred unless deletion breadth warrants it.
- **GCS adapter contract (gated, not implemented):** save `sha256` as custom
  object metadata on upload; HEAD compares that metadata and byte size with the
  expected object. GCS does not supply the application's SHA-256 itself.
  `putIfAbsent` uses `ifGenerationMatch=0` for atomic create-only publication.
  Missing or mismatched metadata refuses publication. The live test still waits
  for the owner's Blaze, budget and dedicated pipeline-account decision; the
  app Firebase admin key is outside this pipeline's credential boundary.
