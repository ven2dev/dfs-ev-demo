# #250 roadmap — shorten the database CI critical path

Roadmap approved. Checkpoint 1 starts from `origin/main` at `9ef323e`.

## Design basis

- **Pattern.** Run the core DB and feature-store suites as independent CI jobs on separate runners and disposable PostgreSQL servers. Measure the hosted setup and test phases with the split. If those measurements justify template reuse, build a clean, sealed feature-store template once per selected run and use a private database clone per test fixture. Reuse the existing guarded scratch and template lifecycle. Retain fresh migration paths for tests that exercise migrations or need a different schema.
- **Alternatives.** Raising feature-store concurrency on a shared 512 MiB server would contend for disk, WAL and cleanup. A migrated container cache would add cross-run invalidation and provenance. Bigger runners would add cost while leaving repeat migrations in place. Sampling or moving tests would reduce PR coverage.
- **Targets.** On full runs, the DB critical path must finish within 30 seconds of App checks. Aim for at most 25 seconds of feature-store setup, measured separately from test bodies. Retain every test in the current baseline and all assertions, budgets and buffer ceilings. Require at least 25% sampled disk headroom on the standard 512 MiB fixture. Report at least three comparable full GitHub CI runs, including aggregate wall time and job durations. If either target misses, take the result to the owner before changing it.
- **Requirement reasons.** A content fingerprint and catalog verification prevent a clone from hiding stale schema. Sealing and registering clones under the existing lane lease prevent mutation or accidental cleanup by another process. The aggregate check must account for each job's affected-selection decision, suite and cleanup result so skips, cancellation and missing outputs cannot silently pass. Preserve the current CI check name.
- **Assumptions.** GitHub-hosted Ubuntu, PostgreSQL 18.6 and #247's loopback-only standard fixture. Per-file feature-store execution stays serial within its job. Independent jobs can duplicate runner setup, so measure aggregate wait time and total runner time separately. Use only lane-2 standard for local DB work and keep #169 timing windows clear.

## Baseline and cheap qualification

GitHub baseline run [42458405318](https://github.com/ven2dev/dfs-ev-demo/actions/runs/42458405318) recorded App checks at 168 seconds and DB integration at 302 seconds. Core DB took 82 seconds and feature-store 173 seconds at the step boundary. The Node feature-store summary was 169.6 seconds with 291 passing cases. Removing the core step from the feature-store runner leaves roughly 220 seconds under the same overhead assumptions, against a 198-second target. Independent runner startup and setup make this a planning estimate.

The local standard-lane spike built a fresh migrated fixture in 441 ms and a template in 405 ms. Five serial clones took 21–48 ms each, with at least 433 MiB free at the clone sample boundaries. The measured feature-store catalog fingerprints matched the fresh fixture. This was a schema-only clone probe. It does not establish full-suite disk headroom or hosted time savings.

The current local feature-store baseline passed all 295 cases across 34 files in 139.3 seconds on a fresh 512 MiB lane-2 server at concurrency 1. The 27 instrumented harness calls spent 17.3 seconds in setup, 113.7 seconds inside test callbacks and 0.9 seconds in cleanup. The remaining 7.4 seconds cover work outside those intervals, including the files using other fixture paths. The slowest callback was derived (28.2 s), followed by removal queue (15.9 s), mandatory recovery races (11.7 s) and producer work (10.2 s). Lane-2 teardown was verified.

The local harness setup accounted for 12% of suite time, with 82% inside test callbacks and 6% in cleanup and other work. The issue's original estimate of about 80 seconds of setup came from subtracting summed test durations from the hosted suite total. That subtraction includes work inside callbacks. The local setup cost and clone probe imply a best-case local savings of about 16 seconds. The hosted setup share remains to be measured.

## Checkpoints

1. **Split the CI jobs, prove accounting and measure hosted timing.** Keep one affected-selection contract and evaluate it inside each DB job using that runner's existing install, avoiding a serial plan job that adds a dependency install to the critical path. Require the two plans to agree. Bind selection and raw outcomes to the correct suite and cleanup. Extend the aggregate negative matrix for selected failure, cancellation, incomplete or contradictory output, unselected execution and cleanup failure. Preserve lifecycle and guard coverage. Emit harness setup, test callback, cleanup and suite timing to CI logs or a run artifact. Wall-clock timings are observations only and never CI assertions, so runner variability cannot cause a false failure. Include the four intake files (`baseline-summary.json`, `setup.jsonl`, `tests.jsonl` and `template.json`) under `docs/evidence/ci-250/` in the first commit, with metadata identifying the base SHA, lane-2 and standard tier. After the first pushed full CI run, report the hosted split and propose whether checkpoint 2 or 3 goes next. Report the shared-harness sample count and account for other fixture paths before treating the measured setup total as the suite total. If hosted setup is at or under 25 seconds, pause template work for the owner's decision.
2. **Reuse a verified feature-store template if the hosted data justifies it and the decision gate clears.** Build the current migrated schema plus the exact default feature-store proposal chain once. Fingerprint the ordered migration and proposal bytes and catalog contract identity. Verify the build before sealing it. Reuse the existing template manifest, target check, advisory lease, registration and interruption cleanup where they apply. Prove stale and changed inputs refuse a clone and that fresh and cloned fixtures have equivalent schema, functions, triggers and grants. Retain fresh paths for schema-sensitive tests. Use one clone at a time and verify headroom under the full workload.
3. **Profile the slow checks and validate.** Break down #138 derived, removal queue, #229 recovery races and #241 producer work into fixture preparation, waits required by the assertions and measured SQL. Include candidate selection and dataset current-head if the first profiles leave a gap. Bulk-seed where repeated round trips dominate, starting with #138's 63 added quarterbacks. Keep natural rows, insertion dependencies, transaction and clock semantics, sizes, cases and assertions identical. Shorten a race check's wait only if the revised check demonstrates that the same race still occurs. If that is unclear, leave the wait in place and report it. Keep a slow-check change only when the median improves by at least three seconds over the same isolated check. Interleave at least three runs of each version on the same lane and tier and commit the evidence JSON. Run the full original inventories, disk sampling and aggregate tests, then measure at least three comparable full CI runs after push authorization. Complete this final validation after the last implementation checkpoint, regardless of checkpoint order.

**LOE** 4–5 active hours, excluding hosted runs and owner review waits. Split the CI job change from template work if the estimate exceeds five hours. Start after roadmap approval and after the owner creates `feature/dfsEV-250-db-ci-critical-path`. Report before every commit, use no attribution trailers, and obtain fresh approval before each push.

## Checkpoint 2 qualification

The [first full hosted run](https://github.com/ven2dev/dfs-ev-demo/actions/runs/42557982456)
passed with the DB jobs finishing 32 seconds after App checks. Shared
feature-store harness setup took 31.1 seconds across 27 calls. This put both
timing metrics above their targets and moved template reuse ahead of slow-check
profiling.

The guarded feature-store runner holds the existing lane lease through template
and clone cleanup. It seals one migrated database after applying the ordered
four-proposal chain. The manifest binds the source to the migration bytes,
catalog contract fingerprints and proposal bytes. The CI parity probe compares
fresh and cloned catalogs and grants. The schema-specific suite and the direct
local feature-store command still support fresh fixtures.

Local lane-2 standard qualification passed all 295 existing feature-store
cases and the new parity probe. The template build took 0.63 seconds and the
27 shared-harness setups took 7.19 seconds. Minimum sampled free space was
273.7 MiB, or 53.5% of the 512 MiB fixture. These observations support local
qualification. A hosted run is still required to evaluate both timing targets.
See the [qualification receipt](evidence/ci-250/checkpoint-2-template-qualification.json).

## Checkpoint 3 slow-check profile

The lane-2 profile covered all four checks listed in the issue and the two
additional queue/recovery checks highlighted by intake. The derived test spent
26.29 seconds in feature publication and its required EXPLAIN. All identity,
stats and participation inserts together took 1.81 seconds. The producer and
dataset fixtures already use bulk SQL and retain their per-job transaction and
ANALYZE sequence. Recovery candidate selection already uses set-based inserts
in bounded transactions. Its five measured EXPLAIN calls took 82 ms combined.

The removal queue and recovery race files each spent about eight seconds
writing a cohort of independent fixture files before database publication.
Batching those writes in groups of eight keeps the same file contents and
ordered inputs, and all writes complete before the database work starts.
The comparison used the same lane and tier with a fresh scratch database per
check. Three interleaved runs per variant produced these medians.

| Check | Sequential seed | Bounded seed | Saved |
| --- | ---: | ---: | ---: |
| #174 removal queue | 17.29 s | 12.02 s | 5.27 s |
| #229 recovery races | 13.05 s | 7.86 s | 5.19 s |

The measured check includes harness setup and cleanup. Only these two
changes cleared the three-second gate. The real storage adapter, SQL,
assertions, workload sizes and lock-ordering waits are unchanged. The
[profile and validation receipt](evidence/ci-250/checkpoint-3-slow-checks.json)
records the trials and the local full-suite check. Final hosted qualification
still needs three comparable runs.
