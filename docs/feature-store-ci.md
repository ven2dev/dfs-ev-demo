# Feature-store PostgreSQL CI coverage

Issue #185 closes the CI gap identified while triaging #177. The feature-store
suite already has a serial Node test command, but the DB integration job has not
executed it. The evidence-graph retirement stays in its own branch and PR.

## Design basis

- Pattern: reuse the standard disposable PostgreSQL lifecycle, with a sequential
  feature-store step inside the existing DB job and its aggregate CI gate.
- Alternatives: local-only tests leave rights/deletion regressions unchecked;
  a separate job duplicates setup and needs another aggregate-gate dependency;
  changing the general DB orchestrator couples a small CI repair to a larger
  harness change.
- Targets: all 77 current tests pass, with zero skipped/cancelled cases, on the
  unchanged `compose.test.yml` database. Retain the current 10-minute DB job
  deadline and every existing guard/lifecycle/catalog step. Local elapsed time
  is supporting evidence; hosted CI establishes the hosted deadline.
- Requirement reasons: run suites sequentially so their disposable lifecycle
  operations cannot interfere; use `--env-file /dev/null`, the public throwaway
  test URL and existing target guards so no application configuration is used;
  run cleanup unconditionally so failures do not leave test resources behind.
- Assumptions: an isolated CI Docker host, serial feature-store fixtures, no
  production/hosted/GCS access, and unchanged runtime/SQL/test fixtures.

## Resource boundary and validation

The standard compose file mounts PostgreSQL data on a **512 MiB tmpfs** and sets
shared memory to 128 MB. It does not set a 512 MiB container-RAM limit. The spike
compose override raises data storage to 2 GiB for repeated append-only benchmarks;
that override is not part of this CI step.

Before commit approval, run the existing suite on a fresh standard container,
then run the combined DB job sequence and the affected gate/lifecycle checks.
Record counts, runtime, compose/code hashes and actual data mount size in a
compact receipt. Do not increase storage, skip cases or alter the fixture if the
suite fails; bring that evidence to the owner.

#177 remains on hold until this coverage PR lands. Existing dependency PRs are
owner-merged first when ready; refresh the final integration baseline afterward.

## Local checkpoint (2026-10-18)

All 77 PostgreSQL tests passed on a fresh standard fixture in
56.844 seconds, with zero failures, skips or cancellations.
The exact CI command passed again in the combined sequence. The data mount was
confirmed as 524,288 KiB; container inspection confirmed no spike override.

The combined gate, guards, lifecycle, migration/catalog/database behavior,
feature-store step and cleanup completed in 136.818 seconds locally. All 75
required Node DB cases, 12 catalog contracts and existing PostgreSQL suites
passed. The four CI gate checks and lint of the changed JavaScript passed.
All 11 frozen migrations, catalog/schema/readiness artifacts, runtime SQL,
fixtures and package dependencies are unchanged.

The [compact receipt](evidence/feature-store-185/standard-ci-validation.json)
records counts, stage timings, source hashes and resource boundaries. Full logs
stay outside git. Hosted CI remains pending and is the evidence for the hosted
10-minute deadline; local timing excludes dependency installation and runner
setup. Commit, push and merge gates remain with the owner.
