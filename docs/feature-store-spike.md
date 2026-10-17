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
`13ac8ce`. Step 3 implementation and evidence are ready for owner review, but
remain uncommitted. Real-source ingestion qualification has run; no evaluation
or complete capacity gate has run. Pushing needs fresh owner consent;
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

Status: implementation and qualification complete on the step-2 base, pending
owner review and commit approval. Stop here before step 4 for the approved
progress/risk checkpoint. No evaluation has run and no feature, label, dataset,
model or app prediction has been produced.

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
