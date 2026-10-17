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

Step 1 is prepared locally: [sources](feature-store-spike-sources.md),
[inventory evidence](evidence/feature-store-138/source-inventory.json), and
[scoring preregistration](feature-store-spike-preregistration.md). No evaluation,
proposal SQL, database operation or new commit has run. Only documents,
JSON inventory evidence and the archived inspection recipes are changed.
Commit approval is required by the owner's workflow; pushing needs fresh consent. Owner-run Codex
review remains required.

GCS live tests pause for owner confirmation of Blaze, budget and a dedicated
bucket-scoped pipeline service account. Never use the app Firebase admin key,
because that would cross the approved credential boundary. Neon configuration
verification remains read-only and uses only an owner-designated non-production
connection if actual configuration is inspected.
