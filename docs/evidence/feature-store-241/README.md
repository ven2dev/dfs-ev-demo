# #241 evidence

Step 1 qualifies the shared completion relation and derived feature/label
display changes. Final dataset, producer and #163 speed qualification belongs
to step 4; no step-1 timing is presented as that proof.

`step-1-validation-20261107T214813Z.json` records the base commit, source SHA-256
and Git blob identities, completed validation commands, nine probe verdicts and
one-statement/inlining observations. Its exact full validation record and the
new DB probes are retained in `step-1-full-records-20261107T214813Z.tar.gz`.
The bundle also retains the initial sandbox-denied setup attempt: no probe
executed in that attempt. It is not counted as a passing test.

Audit from the repository root with Node 24, without a database or local cache:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-241
```

The existing TypeScript auditor checks each named member's SHA-256 and byte
size before parsing, then reconstructs the receipt's exact generic projection.
It does not rerun the database checks or independently derive their verdicts.
The archive has sorted regular-file members, fixed timestamps/owner IDs and
`gzip -n`; two constructions produced identical bytes. Records are durable
in-tree bytes, independent of `node_modules/.cache` and disposable sources.

| Member | SHA-256 | Verdict |
| --- | --- | --- |
| `step-1/job-visibility.json` | `394f8b5ce016ed7d99c6549ab86eda143c7e518d8dae1e9e36a1b2737de298ae` | Nine DB probe groups pass. |
| `step-1/sandbox-setup-attempt.json` | `9a688f8482fc2c872804b788c29d5a2218638d0fa56751b88f9dfe3e80154a4b` | Setup denied; zero probes executed. |
| `step-1/validation.json` | `c7189664874fd0842c4c4a7b09b84b2a727d059826d90cb5fa046819ce58cda8` | Completed validation passes. |

Step 1 uses synthetic revisions with actual insertion/finish/COMMIT clocks and
real restricted LOGINs on the loopback PostgreSQL 18.6 fixture. No stored clock
is altered. Both feature and label probes record the accepted terminal-UPDATE
to-COMMIT visibility gap. The generic evidence projection is a receipt of
executed assertions, not an independent plan or temporal proof engine.

Future runs add new receipts and bundles; a rerun produces a new record hash.
Existing #166/#167/#231 evidence remains unchanged.

## Step 2 stopped work gate

`step-2-stopped-20261107T2208Z.json` and its uniquely named bundle retain the
first live CI plan failure, test output, disk observations and source SHA/blob
identities. The receipt is **stopped-not-qualified**. A passing hash audit of
these records does not turn the failed work gate into a success.

The first dataset plan uses 4 hits for `current_jobs` against the approved 3.
Its root uses 8,631/10,349, `current_f` 2,656/3,190 and `current_l` 691/825;
both heads execute once with 9,381 rows. No later plan case was run and no
ceiling was changed. The portable loader batches all job inserts before their
terminal updates; this likely changes heap layout relative to normal producer
preparation, but no rerun has established that diagnosis.

The database run reports 43 passing results from the existing dataset/#163
suites and two failures: the work gate above and the new behavior test's
noncanonical temporary ObjectStore path. The latter fails before any probe or
database setup. TypeScript and touched-file lint pass. No artifact-cleaner test
or speed qualification ran. The earlier administrator-terminated preparation
and the successful fresh preparation are both retained; no failed attempt is
counted as a qualifying sample.

The new portable work fixture is a 5,003,909-byte gzip containing the exact
relational graph captured from the sixteen retained files. Its manifest binds
the compressed/uncompressed hashes and cardinalities. It reproduces the 2,504
retrospective/zero strict cohorts without a workstation cache. Ordinary writer
triggers supply new clocks on restore; captured clocks are not temporal proof.
The original receipt remains unchanged. The owner subsequently approved the
fixture lifecycle and temporary-path corrections, and replaced only the
`current_jobs` ceiling as described below.

## Step 2 resumed budget policy

The fixture now inserts each running job, writes its outputs in a publication
transaction, performs ANALYZE and its terminal UPDATE, then commits before
starting the next job. This matches real producer ownership; it is not a layout
adjustment to fit a numeric ceiling. The ObjectStore test uses a canonical
temporary directory.

Only `current_jobs` uses a relation-size formula: Actual Loops=1 and measured
hits+reads <= heap pages + pages of indexes actually used by the subtree. The
observer records `pg_relation_size`, `pg_class.relpages`, block size, measured
hits/reads and the resulting ceiling after ANALYZE in the EXPLAIN transaction.
Unused indexes add no allowance. A two-page baseline with a 20% margin gave
only one spare page, so it did not meaningfully express the intended one-pass
work bound. Root/current_f/current_l retain 10,349/3,190/825 unchanged. Negative
controls require repeated materialization and an extra page to fail.

The 5,003,909-byte pinned gzip under the test fixtures is an owner-accepted
in-tree dependency for independent CI work measurements; the final PR body
will disclose that size. It is separate from the compact evidence bundles.
Each resumed run is appended with new names; the stopped receipt above and its
bundle remain byte-for-byte unchanged.

## Step 2 resumed validation

`step-2-resumed-20261107T221412Z.json` and
`step-2-resumed-full-records-20261107T221412Z.tar.gz` retain the passing work,
behavior and compatibility checks, source SHA-256/Git blob IDs, command logs
and disk observations. All three plans (retrospective, strict and active
corrections) use 8,624 root hits, 2,657 current-feature hits and 686 current-label
hits, below their unchanged ceilings. Each materializes `current_jobs` once,
using 2 hits and zero reads against the measured two-page heap allowance; no
index is used. Both heads execute with 9,381 rows, and negative controls reject
repeated materialization or an extra page.

The seven new behavior groups pass (eight Node test results including their
parent). The 43 existing dataset/direct-reader results and 45 compatibility
results also pass. Dataset build/delivery retain 8 SQL / 2 checks and
3 SQL / 2 checks / 1 GET respectively; direct #163 reads retain 3 SQL / 2 checks
and exactly 2P rights calls for every n=2–16. Model-only reads remain at 2 SQL.
Typecheck, lint, 11 import-boundary checks and five focused unit tests pass.

The first resumed behavior setup failed before any probe with `42P08` (a test
INSERT parameter inferred as both text and a SHA-256 domain). Explicit test-only
text casts corrected it. Its empty probe record, log and telemetry remain in the
new bundle; the successful rerun does not erase that attempt. Final speed
qualification remains step 4. No full-suite or artifact-cleaner run is claimed.

The hash-first audit passes all 24 named records across step 1, stopped step 2
and resumed step 2. As above, the generic audit verifies the retained records
and receipt projections; the live DB checks enforce current plan/work budgets.

## Step 3 disk stop: not qualified

`step-3-stopped-20261107T223140Z.json` and
`step-3-stopped-full-records-20261107T223140Z.tar.gz` retain the source SHA/blob
identities, six passing behavior groups, two prior test-identity assertion
failures, the initial sandbox denial, non-DB validation logs, PostgreSQL failure
log and last saved gate-boundary telemetry.

The fixed-version full-materialization EXPLAIN hit a PostgreSQL PANIC at
22:28:53.257 UTC on 2026-11-07: writing `pg_wal/xlogtemp.1176876` failed with
no space left on device. The server terminated its backends and recovered.
The client observed connection termination, not a returned `53100` code. The
gate was stopped and not retried; settings and targets remain unchanged.

The restart also killed the parent telemetry connection before it flushed the
work record and in-flight disk observations. The last durable boundary is
before fixture preparation; neither a peak-disk figure nor numeric work-gate
qualification is claimed. After recovery WAL measured 218,103,808 bytes and
tmpfs usage was 384,752/524,288 KiB. The verified probe database was deleted;
zero scratch databases/connections remained and usage fell to 244,640 KiB.
Four throwaway roles without shared dependencies were left untouched because
the interrupted run had not recorded which role names it owned.

The new behavior suite passes seven Node results (six groups plus parent).
Typecheck, lint, eleven import checks and one focused unit test pass. Existing
DB suites, compatibility and final qualification remain pending. The hash-first
audit passes all 40 retained records; that verifies bytes/projections and does
not convert this stopped work run into a success.

## Step 3 resumed validation: standard CI and opt-in capacity tiers

`step-3-resumed-20261107T225754Z.json` and
`step-3-resumed-full-records-20261107T225754Z.tar.gz` retain the passing new
runs separately, including the exact plans, durable disk JSONL, validation logs,
runner source and 18 current source SHA-256/Git blob identities. The historical
stop above stays unchanged. The hash-first audit passes all 65 retained records;
it verifies bytes/projections, while live DB tests enforce current work budgets.

| Tier / proof | Actual mount bytes | Sampled peak bytes | Verdict |
| --- | ---: | ---: | --- |
| Fresh standard container: read-only producer gate, 28 behavior and 44 compatibility results | 536,870,912 | 466,530,304 (86.898%) | Pass |
| Fresh standard final read-only gate, after test-helper whitespace cleanup | 536,870,912 | 465,317,888 (86.672%) | Pass |
| Opt-in full-season materialization plan/parity | 2,147,483,648 | 538,312,704 (25.067%) | Pass |

The CI producer gate consumes 1,659,581 hits + zero reads, below the unchanged
1,745,394 ceiling, with all nine named CTEs executing once. Snapshot/target/
context counts stay 16/1,948/119,515. Negative controls reject repeated work or
excess buffers. The cost is about 14.1% above the original candidate diagnostic,
within the existing 20% allowance; no ceiling was raised. Normalized parity
matches all 103,468 selected rows in one statement. The existing small-cohort
producer tests retain eight statements and one histories/gaps execution.

Full-season materialization is outside the CI `*.check.mts` glob in
`job-visibility-producer-plan.mts`. It runs only with explicit opt-in and the
measured 2 GiB mount prerequisite. Its 1,948 outputs and 31,168 snapshot links
match, with histories/gaps executing once. The 513.375 MiB sampled peak exceeds
the standard mount's total capacity. max_wal_size=1 GB, shared_buffers=128 MB
and work_mem=4 MB match both tiers; only the existing Compose mount override is
used. One-second/boundary snapshots disclose sampled peaks rather than exact
allocation peaks. No new gate failed and no failed sample was replaced.

The container is restored to the standard 512 MiB configuration. No scratch
database, connection or throwaway LOGIN remains. Typecheck, lint, eleven import
checks, one focused unit test and the #166/#231 evidence audits pass. No full
suite or artifact-cleaner run is claimed here. Final producer speed qualification
remains step 4 on the 2 GiB override: four fixed-version-only samples, unchanged
84 s/120 s target and eight statements. Dataset/#163 speed gates remain unchanged.

The separate unfiled disk-follow-up draft is narrowed to early safe failure,
standard WAL budgeting and documentation of workloads needing the override;
it is not a #241 blocker. Combined forecast is now 7.75–8.5 h, including remaining
step 4; the hard cap remains 8.5 h.

## Step 4 disk checkpoint: stopped at owner cap

`step-4-cap-checkpoint-20261108T001101Z.json` and
`step-4-cap-checkpoint-full-records-20261108T001101Z.tar.gz` append the main and
reduced-branch complete feature-store DB logs, one-second disk observations,
runner and source identities. Existing stopped and passing records are unchanged.
The checkpoint full record has SHA-256
`198ad944a05019f7a9c9cffac605fc245f350963ee2cf4c81d2d0d7054befdbd`.
The hash-first audit passes all 74 retained records; it checks retained bytes
and receipt projections, without independently rerunning database assertions.

| Full feature-store DB lane | Tests | Sampled peak bytes | MiB used | Free |
| --- | ---: | ---: | ---: | ---: |
| Main `dc0050a` | 253 | 108,912,640 | 103.867 | 79.713% |
| Branch `441aaf9` plus uncommitted CI reductions | 280 | 245,841,920 | 234.453 | 54.208% |

Both run under Node 24.18.1 on separate fresh standard 536,870,912-byte
containers and pass the owner's minimum 25% sampled free-space bar. The
branch's suite-level peak is 130.586 MiB above main; the earlier 86.898% branch
result covered targeted suites rather than this complete lane. Both suites
pass without an artifact-cleaner failure. Disk samples include WAL, temp files,
database sizes and tmpfs use; they do not establish absolute allocation peaks.

The producer CI fixture omits unrelated derived outputs while retaining its
full context graph. Dataset CI uses the pinned 2025 derived slice, omitting
unneeded normalized tables; active correction branches still execute. All
buffer ceilings, loop/plan assertions and the current_jobs relation-page rule
are unchanged. The original portable gzip is unchanged, and final speed
qualification still uses the full 2,504-row fixture. No server setting or
standard mount changed. Zero scratch databases, connections or throwaway
LOGINs remain; the disk follow-up is not a blocker from this result.

Step 3 is committed as `441aaf9` (16 files, no attribution lines, no push).
The added disk work raises the combined forecast to 8.25–9 hours, exceeding
the owner's 8.5-hour cap. This checkpoint is
`stopped-at-owner-cap-before-speed-qualification`, not final qualification.
The step-4 CI changes are uncommitted. Producer/dataset/#163 speed runs, full
non-DB validation and the final independent speed audit remain pending; no
step-4 speed benchmark has started.

## Step 4 final-source qualification

The owner extended the hard cap to 9 hours. New final records supersede the
checkpoint's pending-qualification status; the checkpoint and earlier stopped
runs remain unchanged.

- `step-4-final-benchmark-20261108T011159Z.json` binds 1,216 raw observations in
  `step-4-final-full-records-20261108T011159Z.tar.gz#final-speed/full.json`.
  Uncompressed SHA-256:
  `e8841fa90f31d6030ed8792676821fe32c29ed7ae1b24117a3df8fe97a76e981`.
- `step-4-final-validation-20261108T011159Z.json` names that same bundle's
  validation record and exact command logs, plans, disk telemetry, original
  producer comparison/owner exception and unexplained-query record. Its
  uncompressed SHA-256 is
  `1e29596700bddfc89a37ffdd13a43b54d2537d365e4ea59f0abb7214788d265e`.
- `step-4-audit-20261108T011318Z.json` and its uniquely named bundle retain the
  final five evidence-control results, typecheck/lint, historical audits and a
  clean export audit without node_modules or cache. Record SHA-256:
  `c1750213d494fa5cb2867aab451c6039df23475d602a1615f99d730def9b2db0`.

The audit command above passes all **120 named records**. After checking each
member's SHA-256/size, the TypeScript verifier independently reconstructs the
four producer gates, twelve dataset observations, request pin hash, per-request
work and six separate #163 p95s. The clean export reconstructs all 108 records
that preceded the last audit bundle, including every final sample. The last
bundle adds twelve audit members. No database or cache is needed. Recorded
behavior/plan verdicts retain their generic projection; current live tests own
plan/buffer enforcement. A rerun produces new bytes and a new sample hash.

| Gate | Final candidate result | Verdict |
| --- | --- | --- |
| Producer, fixed version only | Four samples 10,929.504–10,946.627 ms, 8 SQL each; worst 90.878% headroom under 120 s | Pass ≤84 s |
| Full dataset builds | Six samples 467.146–504.940 ms, 8 SQL / 2 checks, original 2,504-row content hash | Pass ≤21 s |
| #163 cold-connection p95 | 20.124 / 19.722 / 22.516 ms, separate 100-request cohorts | Pass ≤210 ms |
| #163 warm p95 | 6.327 / 6.311 / 6.588 ms, separate 100-request cohorts | Pass ≤210 ms |
| Full standard DB lane | 280 tests; 229,068,800-byte sampled peak on 512 MiB, 57.333% free | Pass ≥25% free |

Every candidate reader succeeds at 3 SQL / 2 checks, every n=2–16 appears in
each cohort, and no refusal counts as success. All twelve dataset deliveries
use 3 SQL / 2 checks / 1 GET and match their file SHA-256. Cold includes connect
through serialization, with setup share reported separately; it is not a
fresh-process or flushed-cache claim. Full gates use the measured 2 GiB mount;
sampled peak is 608,952,320 bytes. Other settings and targets are unchanged.

The slice is calibrated on the standard fixture: maxima root/current_f/current_l
2,080/607/145 give ceilings **2,496/729/174** using ceil(measured ×1.2).
Its content hash is pinned beside the constants. The opt-in full 9,381-key graph
passes **10,349/3,190/825**, unchanged; current_jobs keeps its measured page rule
and the producer context keeps 1,745,394. Both modes and active correction plans
actually execute. The full gzip remains unchanged.

Readiness/type generation, TypeScript, lint, eleven import checks, 942 jsdom
and 618 Node tests pass (one optional live test skipped); the newly assembled
bundle also passes all five focused evidence controls. Sandbox loopback EPERM
attempts are retained before the permitted runs. Artifact-cleaner passes with
no failure/retry. The final validation binds 34 source SHA-256/Git blob pairs;
the 27 qualification hashes still match after packaging.

Nothing rewrites #166/#167 evidence. The terminal-UPDATE/COMMIT gap, unexplained
668.225666 ms historical sample, comparison-side baseline 53100 and owner
exception remain explicit limitations. No baseline producer was rerun. The
standard container is restored and free of scratch DBs/connections/LOGINs.
Step 4 remains uncommitted for owner review; no push is authorized.
