# Predictive data platform v2: feature-store design

Status: approved by owner, 2026-10-16; spike amendments approved 2026-10-17
(see [#138 roadmap](feature-store-spike.md)). Supersedes the per-record
evidence-graph design of #106/#118 and the #127 verify-on-write roadmap. This
document is written to the #126 standard (AGENTS.md "Project engineering
standards").

## 1. Goal

The product needs an **independent, calibrated, reproducible probability** for
each supported player prop, to replace the interim `computeEV` hit-rate
heuristic. The model contract is #54: over, under and push probabilities, fair
price, cutoff, versions and uncertainty, with walk-forward evaluation, no
look-ahead, and explicit unavailable states.

This document designs the **data layer** that feeds that model. It covers
getting source data in, turning it into features and labels, and building
point-in-time-correct training and evaluation datasets. It is delivered first
as a **thin end-to-end slice**: QB passing yards, from raw nflverse files
through to a calibrated baseline shown in the app.

## 2. Design basis

### Pattern

This is the industry-standard ML training-data architecture, the feature-store
/ ELT pattern:

1. **Immutable raw snapshots.** Every downloaded source file is stored once,
   content-addressed by SHA-256. Each snapshot records its timestamps, and its
   source carries per-source license and rights metadata.
2. **Deterministic, versioned jobs.** Jobs turn raw snapshots into normalized
   tables, then features, then labels. **Only jobs write derived data.**
   Callers request derived data; they never submit it.
3. **Point-in-time training datasets.** A dataset is built by one join that
   selects each example's features as of its cutoff and its label as of the
   label cutoff. The result is materialized as a file and hashed, so it is
   reproducible.
4. **Governance by lineage.** Rights are evaluated per source when a dataset
   is built and when it is read. A deletion follows lineage to invalidate and
   recompute everything downstream.
5. **Audits, not continuous re-proof.** Data-validation checks run at
   ingestion. Scheduled recompute audits catch code and storage errors.

### Alternatives considered

| Option | Verdict |
|---|---|
| A. Per-record evidence graph, re-proven on every read (current #106/#118) | Rejected. Each policy is implemented twice (SQL and TypeScript) and still fails: #127 certified a forged feature. 16-row datasets exceed 30 s. It needs 58-table locks. |
| B. Verify on write with certificates (#127 roadmap) | Rejected. The recorder accepts caller-computed values, so a trustworthy certificate needs a trusted computing job anyway. That job is option D without the certificate machinery. |
| C. Periodically refreshed materialized views over the current tables | Rejected. Keeps the per-record model's cost, and results are stale between refreshes. |
| D. Feature store / ELT (chosen) | Standard, simpler, and meets every real requirement below. |
| E. All transformations in SQL only (in-database ELT) | Viable for rolling stats. Rejected as the default because the parsers and policies already exist in tested TypeScript, and later model features will likely need application code. SQL remains the tool for the point-in-time join. |

### Requirement reasons

Every hard rule states the risk it prevents.

- **No look-ahead.** A feature or label may use only data available at its
  cutoff. Otherwise backtests overstate accuracy and the model is
  miscalibrated in production.
- **Database-stamped knowledge time.** "When we learned it" is stamped by the
  database, never by the caller. Caller-supplied times can be backdated and
  silently change historical answers (a known defect today: `decided_at`).
- **Only jobs write derived values.** Otherwise a buggy or compromised caller
  can store wrong numbers that look valid. #127 showed this happening.
- **Rights are checked when a dataset is built and again before delivery.**
  Licenses can be revoked. This is the industry norm; no current source
  license requires in-flight revocation.
- **Legal deletion removes the affected source's data and invalidates its
  dependents.** This is a provider or rights obligation.
- **Superseded and stale data is shown with a flag, never silently and never
  as a blank** (owner policy, 2026-10-16). Users get the most information
  available, honestly labeled.
- **Reproducibility.** Every dataset and model run records its snapshot set,
  code version and content hash. Otherwise results can't be audited or
  compared over time.
- **Honest retrospective versus prospective evidence.** Historical seasons
  backfilled today were not captured at the time. They are flagged
  `retrospective` and are never presented as a live record.

### Assumptions

- Threat model: application bugs and outsiders, not the database owner.
- Hosted-compatible design, deployed locally for now: short transactions, no
  per-connection state, no long locks, file access only through a storage
  interface.
- Sources for the thin slice: nflverse public releases (weekly player stats,
  schedules, rosters, participation). They are under open licenses, to be
  confirmed per file in the spike.
- Scale for the slice: QB passing yards for the 2021–2025 regular seasons, so
  about 32 teams × 17–18 weeks × 5 seasons, giving about 3,000 QB-games for
  training and evaluation. Then the live current season.

### Targets

The spike measures these before anything is frozen.

| Operation | Target |
|---|---|
| Ingest one nflverse file (download, validate, store snapshot, normalize) | ≤ 60 s per season file |
| Feature job, one full season of QB passing-yards features | ≤ 2 min |
| Build a 5-season training/evaluation dataset (point-in-time join, write and hash the file) | ≤ 30 s |
| Serve one prediction to the app | ≤ 300 ms p95 |
| Headroom | ≥ 30% under every deadline, across repeated cold/warm runs; ABBA when comparing optimizations |
| Work budgets (CI) | Dataset build is a fixed number of SQL statements regardless of row count. Rights/status: 1 batched query at authorization + 1 before delivery, 2 total per build/read. No per-row verification calls. |

## 3. Architecture

### Layers

```
nflverse release files ──► [ingest job] ──► raw snapshots (object storage + snapshot rows)
                                              │
                                    [normalize job, versioned]
                                              ▼
                       normalized tables (player-game stats, schedule, identity, participation)
                                              │
                         [feature job, versioned]      [label job, versioned]
                                              ▼                 ▼
                                      feature_values      outcome_labels
                                              └────────┬────────┘
                                      [dataset build: point-in-time join]
                                                       ▼
                                 dataset manifest (DB) + dataset file (object storage, hashed)
                                                       │
                                  [model fit + walk-forward evaluation, #54]
                                                       ▼
                                 model_runs / predictions ──► app API ──► UI
```

### Tables (sketch; names are provisional)

- **`source_profiles`**: provider, feed, parser version, license and
  attribution, allowed uses. Reuses the existing 0003 concept.
- **`rights_decisions`**: allowed uses, effective interval, and `recorded_at`
  set by the **database** (`now()`), the fix for the backdating defect.
- **`source_snapshots`** (append-only): profile, SHA-256 of the bytes, size,
  media type, decoded digest (gzip), header digest, row count. Timestamps:
  `captured_at` (download time), `available_at` (provider publication time,
  for example the release asset's `updated_at`), and `ingested_at` (database
  clock). Also a validation status, and `evidence_basis`
  (`prospective`/`retrospective`). The bytes live in object storage, keyed by
  SHA-256.
- **Normalized tables**, keyed by
  `(snapshot_id, normalizer_version, natural key)`: `norm_player_game_stats`,
  `norm_schedule`, `norm_identity`, `norm_participation`. Each row carries a
  `state` (usable / refused / ambiguous) and a reason. An **as-of view** picks,
  for each natural key, the row from the latest valid snapshot with
  `available_at` and `ingested_at` ≤ cutoff.
- **`job_runs`**: kind, code version (git SHA), policy digest, input snapshot
  set hash, started and finished times, status and counts. Jobs are idempotent
  on `(kind, input hash, code version)`.
- **`feature_values`**: player, game, cutoff, feature version, history
  policy, values (JSON), state, reasons, input set hash, job run, computed at,
  evidence basis. Lineage goes in `feature_inputs(feature_id, snapshot_id)`.
- **`outcome_labels`**, the single label store: player, game, stat, label
  version, value or null, state, `known_at`, `supersedes_id`, `superseded`
  flag, input set hash. It replaces both the legacy `predictive_outcome_labels`
  and the consumer-label path.
- **`dataset_manifests`**: spec (markets, partitions, cutoffs, policies),
  snapshot set, code versions, rights decision IDs, row count, file SHA-256,
  status, and whether superseded-flagged examples were included.
- **`model_runs` / `predictions`**: per #54. Model identity, parameters,
  training and evaluation windows, metrics, and served predictions with their
  versions and cutoff.

### Trust boundary

- A dedicated `pipeline_writer` role is the **only** role allowed to insert
  into normalized, feature, label, dataset and model tables.
- The app's API role is read-only on them.
- Callers can only *request* a job.
- Data-validation checks run inside the jobs: schema and header checks, row
  counts, value ranges, the gzip CRC, and complete ordinals. These reuse the
  existing parsers.

### Time and as-of semantics (bitemporal)

- **Valid time** is the game and event time.
- **Knowledge time** is `ingested_at`, set by the database, plus
  `available_at` (when the provider published).
- A feature at cutoff *t* uses only snapshots with
  `available_at ≤ t AND ingested_at ≤ t`, except retrospective backfills,
  which use `available_at` alone and are flagged `retrospective`.
- Owner-approved #138 research exception: `retrospective-reconstruction-v1`
  may use today's corrected prior-game facts, with `historical-availability-unverified`
  flags. This is separate from strict point-in-time evidence and does not rewrite
  actual snapshot timestamps. See the [preregistration](feature-store-spike-preregistration.md).
- A label at label cutoff *L* uses the latest valid stats snapshot as of *L*.
- Stat corrections are new snapshots; the earlier label row is marked
  `superseded`.

### Superseded, stale and deleted data (owner policy)

- **Display:** show the last valid value with a visible flag. Examples:
  "original value; correction no longer available", or "data as of Tue
  4:10 PM, update pending". Never show a blank when a once-valid value exists.
- **Training:** use the last valid value, but flag examples that depend on
  superseded data. Each dataset manifest records whether flagged examples
  were included.
- **Legal deletion:**
  1. Remove the affected snapshot's bytes and derived rows.
  2. Follow lineage to invalidate dependent features, labels and datasets.
  3. Recompute from the surviving snapshots.

  Values from other, still-permitted sources are never hidden.
- **Corrupt downloads** are rejected at ingestion and never replace good data.
  The source shows as stale until a valid download arrives.

### Reads and deletion

- Reads use short snapshot transactions. A read checks the dataset's status
  and the current rights in **one** query, streams the file, then rechecks
  before delivery.
- Deletion is two-step:
  1. Mark deleted and invalidate dependents immediately.
  2. Remove the bytes via a cleanup job after a configurable grace period
     (default 5 minutes; tests explicitly use a shorter value).
- No reader table locks.

### Audit

A scheduled job recomputes a sample of features, labels and datasets from
their recorded inputs and code version. Any hash mismatch invalidates the
affected rows and raises an alert.

## 4. Reuse and retire

| Keep (port as-is or nearly) | Simplify | Retire / never merge |
|---|---|---|
| Pure parsers and policies: `sourceTransport`, `sourceHeaders`, `sourceClaims`, `sourceNormalization`, `scheduleContext`, `passingYards`, `participation`, `labels` | 0003 profiles, rights, blobs, artifacts and captures become profiles, rights and `source_snapshots` | 0012–0020 (never on main), the scratch 0021, the `db/proposals/` spike SQL |
| Gzip codec worker and inspection (`compressedSource.ts`, `compressedWorker.ts`) | Bindings, revisions and witnesses become normalized tables plus as-of views | Read guard, memo, read-time reconstruction, certificates |
| 0011 ingestion clock concept; the `ArtifactStore` interface | Decisions and consumers become job-written features and labels | SQL re-implementations of TypeScript policy (0006–0010 recorders and kernels), retired by a later forward migration once confirmed unused |
| #54 Part A projection library (`empirical-integer-v1`, `probabilityAt`, `priceSide`, evaluation) | Datasets become a manifest row plus a hashed file | Row-granular closure associations |
| Run-inventory and partition rules, manifest and cursor contract, unavailable-reason vocabulary (from #118 docs) | Two label stores become one `outcome_labels` | Legacy `predictive_outcome_labels` (resolves #116) |

Migrations on main (0001–0011) stay. New work is forward migrations from
0012, once the #118-era numbers are released. Retiring 0003–0011 objects
happens only after confirming whether Production ever applied them. #95 tracks
this, and Production state is currently unverified (#86).

## 5. Hosting

Researched 2026-10-16 against current vendor docs.

**Object storage: Google Cloud Storage (owner decision, 2026-10-16), behind
our own `ObjectStore` interface.** The interface offers put-if-absent, get,
head, list and delete, with a local-filesystem adapter for development and tests.
Deletion also goes through this interface so cleanup works with both adapters.

- GCS lives in the same Google Cloud project as the existing Firebase app, so
  there is no new vendor, account or bill.
- Atomic create-once writes use the `ifGenerationMatch: 0` precondition, which
  suits SHA-256-keyed snapshots. Retention policies or Bucket Lock can make the
  `raw/` prefix write-once-read-many.
- At our volume (about 1–20 GB) the cost is cents per month. The free allowance
  covers 5 GB of storage in us-east1, us-west1 or us-central1, plus 100 GB of
  North America egress per month. Choose a free-tier region close to Vercel's
  default region (us-east1).
- **Prerequisites:**
  - The Firebase project must be on the pay-as-you-go **Blaze** plan, with a
    budget alert set.
  - The pipeline gets a **dedicated service account** with access to this
    bucket only. It never reuses the app's Firebase admin key.
- **Rejected:**
  - *Cloudflare R2:* free egress and a 10 GB free tier, but a new vendor. Those
    advantages don't matter at this scale.
  - *Neon Object Storage:* attractive because it branches with the database,
    but its docs don't cover create-once writes, and it doesn't enforce object
    lock or versioning.
  - *Vercel Blob:* a proprietary API (the most lock-in), and Hobby suspends
    access when you exceed its limits.
  - *AWS S3:* suitable, but a new vendor.

**Batch jobs: GitHub Actions** (scheduled, plus `workflow_dispatch` for on
demand) running the same Node job scripts used locally.

- Free for this public repo.
- 16 GB RAM runners.
- No 5-minute ceiling.

Vercel stays the app host. An app route can trigger a job through the GitHub
API.

Jobs must be idempotent and must record their last successful run in the
database, because GitHub may delay or drop scheduled runs. Avoid scheduling
at :00.

- **Rejected for now:**
  - *Vercel cron plus functions:* Hobby caps runs at 300 s and cron at once a
    day. Pro allows 800 s, but at a cost.
  - *Neon Functions plus cron:* 15 min and 2 GB limits; newer, with partly
    undocumented retry semantics.
  - *Always-on worker (Fly/Railway):* unnecessary at this job frequency.

**Database: Neon, unchanged.**

- Jobs use short transactions.
- Locking uses `pg_advisory_xact_lock` or the existing lease-table pattern, so
  the pooled URL works. Use the direct URL only if a session lock is truly
  needed.
- `statement_timeout` is set per role or with `SET LOCAL`.
- CI uses expiring branches.

**Vercel plan:** the app is on **Hobby** today, which is restricted to
non-commercial use. The owner will move to Pro before any commercial launch.
This design doesn't depend on Pro, because batch jobs run on GitHub Actions.

**Credentials:** jobs need the database credentials and the pipeline service
account key as GitHub secrets.
That depends on the secrets work in #97–#101.

## 6. Spike plan (before approval)

Prove the thin slice on main-based code, with nothing frozen. Proposal SQL
goes in `db/proposals/` only.

1. **Ingest:** the 2021–2025 `stats_player_week`, `schedules`, `roster` and
   `participation` files into snapshots (local storage interface), with
   validation.
2. **Normalize:** QB passing yards, plus the as-of view.
3. **Feature job:** prior-N-games passing-yards history at the pregame cutoff.
4. **Label job:** final passing yards, including a correction scenario.
5. **Dataset build:** a 5-season walk-forward dataset (point-in-time join),
   with the file written and hashed.
6. **Baseline:** fit `empirical-integer-v1` and evaluate it walk-forward
   (Brier, log loss, calibration, sample counts versus the naive and market
   baselines where available).
7. **Measure** every target in section 2 with repeated cold and warm runs,
   and record the work counts. Use ABBA interleaving only for optimization
   comparisons against the original implementation.
8. **Correctness probes:**
   - a forged-value attempt by a non-pipeline role is refused;
   - a backdated rights insert does not change historical answers;
   - a correction produces a superseded flag;
   - legal deletion invalidates downstream data;
   - a corrupt download is rejected.

**Pass:** all targets and probes pass. **Fail:** findings go back to the owner
with data.

## 7. Delivery plan (after the spike passes)

New issues replace #118's remaining scope, #127–#133 and the #52/#106
re-scope. Each is one branch and one PR, with forward migrations frozen only
after its checks pass:

1. Snapshot ingestion, database-stamped knowledge time, pipeline role.
2. Normalize job plus as-of views (QB passing yards first).
3. Feature and label jobs plus lineage.
4. Dataset build plus manifest plus file store.
5. Baseline model runs plus walk-forward evaluation (#54 Part B).
6. Product integration: the calibrated probability, fair price, freshness and
   version in the app (#53). The interim label from #135 is removed only here.
7. Governance: legal-deletion invalidation and recompute, the cleanup job, the
   audit job.
8. Extend to more markets (#109) and features (#107/#108) as evidence
   supports.

Parallel tracks continue:

- **Product:** #135, #136, #104, #137.
- **Ops:** #95, #97–#101, #86, failing Dependabot PRs.
- **Creator track:** gated until the baseline exists.

## 8. Risks and open questions

- **Retrospective-only history.** Past seasons can't be captured as they were
  at the time, because nflverse files are updated in place. Backtests must be
  labeled retrospective. Prospective evidence starts with live capture.
- **Population completeness (#54).** Zero-opportunity participants and
  roster candidates need the participation feed. Verify its availability and
  coverage in the spike.
- **Hosting.** GitHub scheduled runs can be delayed or dropped, which the
  idempotency rules above mitigate. Preview deployments share one bucket, so
  datasets are keyed by run or branch ID. The spike verifies three unconfirmed
  details: Neon's `statement_timeout` default, GCS retention-policy behavior
  with create-once writes, and the Firebase project's billing plan (Blaze
  required).
- **Production state of 0003–0011 is unknown** until #86 and #95 are
  resolved.
- **License confirmation** is needed for each nflverse file used.
