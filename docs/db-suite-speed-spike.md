# #153: one-hour DB-suite feasibility spike

> **Hosted follow-up supersedes the local go recommendation below:** full DB jobs took **155 s and 118 s** on 4-CPU runners. Stop before A/B pending the owner’s target/sharding decision. A/B are now capped commit steps on #153, not new issues. See [hosted report](db-suite-speed-hosted-check.md).

**Recommendation: proceed with a narrower implementation, subject to approval of the two capped issues below.** The technical direction now has strong local evidence. The ≤150-second CI job target remains unproven; no optimized code has been pushed or run in CI.

The approved spike started October 17, 2026 at 7:41 p.m. PDT. It uses fresh `origin/main` commit `12290d8e4c2aa87567bf422b58097b2ef28e7f89` in `feature/dfsEV-153-db-suite-speed`. Initial intake had inspected a feature branch with more tests/migrations; all measurements here use fresh main: 11 migrations, 75 Node cases and 136 Vitest cases, including 79 source-claims and 32 predictive cases.

## Measurement before changing fixture behavior

Timing-only instrumentation records every `withProof` invocation, its exact case name, requested migration prefix, fixture phases, test body and cleanup. Assertions and case declarations were preserved. A verifier timer is nested inside migration time, so it is not added twice. Instrumented runs add a small unquantified measurement overhead; both variants use the same timers.

| First baseline measurement | sourceClaims | predictive |
|---|---:|---:|
| Passing tests in file | 79 | 32 |
| Profiled helper invocations | 115 | 30 |
| Artifact/contract loading | 9.18 s | 2.33 s |
| Database creation + connection | 3.30 s | 0.94 s |
| Migration replay, including catalog verification | 37.15 s | 10.55 s |
| Catalog verification portion of the preceding row | 7.63 s | 2.14 s |
| Session, roles, temporary directory and cleanup | 4.91 s | 1.40 s |
| Test bodies inside helper | 86.74 s | 21.98 s |
| Entire file, including cases outside helper and global hooks | 142.33 s | 43.09 s |

The 30 predictive helper calls cover 29 cases; three other cases use their own setup and are included in the full-file timing. The raw JSON contains every profiled invocation, not just averages. Historical prefix requests include 3–10 and latest (11). Several named cases create multiple fresh databases.

The key finding is that repeated setup is expensive, but most source-claims time is in test bodies. Templates alone cannot deliver the target. Parallelizing only the existing files would also leave sourceClaims as the dominant single-file critical path.

## Results

All times below measure `node scripts/test-db.mjs run` against an already-running disposable PostgreSQL service with dependencies preinstalled. They include Node checks, catalog verification, all Vitest cases and existing report validators. They exclude CI checkout, installation, service startup and teardown.

| Variant | Local elapsed time |
|---|---:|
| Baseline, interleaved repeated runs | 216.96 / 207.30 / 191.69 s |
| Verified per-prefix templates + cached artifact/contract loading; serial files | 157.43 s |
| Three balanced source-claims groups + bounded file workers; no templates | 109.75 s |
| Templates + groups, with Node/catalog/primary lane preceding scratch lane | 82.68 / 81.54 / 80.06 s |
| Same fixtures/groups, overlapping the independent lanes | 56.96 s |

Final fresh-service repeat results are recorded in the accompanying evidence JSON and appended below after completion.

The combined grouping variant improves the median from 207.30 s to 81.54 s (60.7%). The overlapping-lane result is about 72.5% below that baseline median, but is a separate candidate measurement, not an interleaved three-run CI result. The final repeat exercise tests repeated isolation; it is not a replacement for CI timing evidence.

Each completed full-suite variant passed all **75 Node + 136 Vitest** cases. The unchanged validators report 75 Node, 13 lease, 4 readiness, 111 predictive/source and 8 corpus required cases. Separate inventory comparison verifies all 136 Vitest names appear exactly once and pass. All 79 source-claims declarations and 31 predictive declarations (32 cases, including a parameterized declaration) have byte-identical test bodies. The required-case contract file is unchanged. Zero scratch databases remained after the overlapping-lane warm run.

## CI comparison and limits

The actual [baseline CI run](https://github.com/ven2dev/dfs-ev-demo/actions/runs/39031183750) at the same commit took **361 s** for DB integration. Its suite step took 329 s, Node checks 33.86 s, source claims 211.10 s, predictive 52.47 s, and Vitest overall 280.88 s. Dependency installation was 22 s. This confirms that local suite seconds cannot be treated as full CI job seconds.

The local machine is macOS arm64, Node 24.21.0, Docker with 12 CPUs and approximately 8.3 GB of memory, PostgreSQL 18.6, and the repository's unchanged Compose service. Runner contention, Linux/x86 behavior, cold installation/startup and scheduling remain unmeasured for the optimized variant. No optimized CI runs were dispatched.

Confidence is **high that the measured setup and serial critical paths can be removed**, and **moderate that the complete CI job reaches ≤150 s**. The large local reduction supports implementation; it does not justify guaranteeing CI acceptance or quoting an exact completion estimate.

## Design basis

**Pattern.** Run-scoped verified database snapshots, a fresh cloned database for each test, bounded file workers, and fork/join orchestration of independent test lanes. Shared-primary and lease tests retain their serial semantics. This follows the issue's template-and-parallelism direction. The narrower route keeps one CI job; a matrix is a fallback, not an initial deliverable.

**Alternatives.**

- Templates/caching alone: measured at 157 s locally; insufficient even before CI overhead.
- File grouping/workers alone: measured at 110 s locally, but retains repeated setup SQL and does not meet the issue's setup work budget. It also leaves less margin for slower CI hardware and installation.
- Transaction rollback/shared-schema resets: do not preserve the behavior exercised by multi-connection, commit, permission and migration-history tests.
- CI matrix shards: technically viable fallback, but duplicate job startup/installation and require artifact aggregation and all-shard gating. The lane-overlap spike shows that this extra machinery is not yet justified.
- Skipping tests or buying larger runners: rejected per issue scope; selection loses coverage and larger machines retain the repeated setup work.

**Targets.** Preserve the issue's complete DB job ≤150 s across three consecutive CI runs, all 75 Node and all Vitest required cases, repeat mode three passes, and setup migrations once per suite/shard. The project benchmark standard asks for ≥30% headroom, corresponding to 105 s against 150 s; local suite measurements provide evidence only for their stated boundary, not proof of CI headroom. No target is relaxed.

**Requirement reasons.** Fresh clones prevent cross-test state leakage. Verified historical prefixes preserve upgrade/idempotency behavior. Unchanged named-case gates and exact inventory checks prevent dropped, duplicated or skipped coverage. A registered template/database lifecycle prevents operating on unrelated databases and accumulating resources. Child tracking and cleanup on failure/interruption prevent orphan processes and databases. Complete report validation prevents missing or stale shard output from passing. Preserving serial primary/lease operations avoids fixture interference.

**Assumptions.** Tests use disposable loopback PostgreSQL 18, local create-database privileges, fixed migration inputs for one run and bounded workers. No application or hosted credentials are accepted. Scratch-only tests do not rely on the primary database's reset hooks; primary/bootstrap/lease cases remain in their original serial lane. Cluster-wide roles are coordinated before use.

**Prototype deviations.** The feasibility prototype builds templates per file and requested prefix, caches input validation per worker, and uses generated balanced test files. It does not yet build one run-scoped incremental snapshot chain or prove the final setup work budget. Explicit migration calls inside upgrade/idempotency assertions remain intact and need to be distinguished from fixture setup in that budget. Interruption/failure cleanup, worker-source registration, stable maintainable test organization and negative report tests require production hardening. There are no ordered migration or application changes.

## Proposed implementation roadmap — approval required

The remaining estimate is **4–6 engineering hours**, with moderate confidence. This is a narrower scope than the initial unmeasured 8–10 hours because general worker-primary isolation and CI matrix infrastructure are avoided. This is not a promise to finish acceptance within six hours. If a cap is reached, stop and propose remaining scope; do not silently extend the issue.

| Proposed issue | Hard cap, including validation/review fixes | Scope and completion evidence |
|---|---:|---|
| A: verified run-scoped template fixtures | 3 hours | Build an incremental migration-prefix snapshot chain once per run; catalog-verify requested prefixes; clone registered targets; preserve all upgrade assertions; own template lifecycle/cleanup; deterministic setup-work budget and unsafe/stale-target checks. All existing tests and repeat isolation pass. |
| B: bounded scratch shards and overlapping harness lanes (#153 delivery) | 3 hours | Organize all existing source-claims cases into stable balanced files sharing helpers; run scratch workers concurrently with the Node/catalog/serial-primary lane; retain fail-closed unchanged global required-case validators and exact inventory; track/terminate all children and clean up; run repeat mode, benchmark, owner-run review and three real CI timing runs after separately authorized push. |

Each proposed issue is below the five-hour L cap. Total authorized implementation is zero until owner approval. If optimized CI still misses 150 s, a matrix or other expansion is a new decision and, if needed, a separately approved issue. The final migration-budget interpretation explicitly excludes migration executions that are the behavior under test; otherwise the unchanged upgrade cases and a literal once-only rule conflict.

No commits without approval of the concrete step; owner runs Codex review; fresh consent before pushing; no merge and no attribution trailers. The spike ends with production/test source restored and only evidence artifacts pending review.

## Final repeat and disposition

Fresh-service `npm run test:db:repeat -- 3` passed with the prototype: **59.54 / 58.35 / 58.92 seconds per suite**. Every repetition verified 75 Node + 136 Vitest cases. The complete command took 179.45 seconds including PostgreSQL startup and teardown. This is the modified feasibility runner, not an unchanged production harness or a CI acceptance run.

Spike completed in approximately 29.1 minutes, within the one-hour cap. Production/test source is restored to the baseline commit; only this report and evidence artifacts remain untracked. No commits, pushes, issue mutations or merges were made. The disposable Compose service was removed by repeat mode.

Artifacts: [measurement JSON](evidence/db-suite-speed-spike-2026-10-17/evidence.json), [source-case body hashes](evidence/db-suite-speed-spike-2026-10-17/source-body-hashes.json), and [exact disposable prototype and reproduction scripts](evidence/db-suite-speed-spike-2026-10-17/reproduction.tar.gz). Reproduction scripts record the fixed worktree and `/tmp/dfs153-spike` paths used for this experiment; adjust them if replaying elsewhere.
