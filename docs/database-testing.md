# Disposable PostgreSQL tests

Issue #45 runs the shared live-prop refresh SQL against a real disposable
database. Production continues to use Neon; `pg` and `@types/pg` are exact-pinned
development dependencies. Issue #60 supplies the shared migration bootstrap,
catalog contracts and isolated migration proofs.
Issue #52 adds the synthetic predictive persistence proof and additive migration
v3. Application readiness still requires only v2; v3 is the maximum-known schema.

## Local commands

Use Node 24 and a running Docker Desktop (or a local Docker Engine with Compose).
From the repository root:

```bash
nvm use
npm run test:db:guard
npm run test:db:local
```

`test:db:local` starts `compose.test.yml`, waits up to 60 seconds for health,
runs migration/reference/readiness artifact checks, all mandatory Node database
checks, an independent catalog-contract drift check and the lease/readiness/
predictive suite. It removes the
service and its network even
if startup or tests fail. It preserves failure exit codes. SIGINT/SIGTERM also
request cleanup; a forced kill or machine shutdown can prevent cleanup. To
remove any resources left by an interrupted run:

```bash
npm run test:db:down
```

All lifecycle commands are scoped to Compose project `dfs-ev-demo-test`.
They do not remove other Docker projects or cached images. The fixed project
and port mean only one database suite should run at a time on a machine.

## Environment boundary

No real application credentials are needed. The relay worktree's `.env.local`
can stay fixture-only; database tests never read it. Compose explicitly uses
`--env-file /dev/null`, and the DB Vitest config disables `.env` loading.
The harness refuses an environment containing `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `ODDS_API_KEY`,
Firebase Admin variables, Google application credentials, or ambient
`POSTGRES_*`/`PG*` configuration. Run it from a shell without those variables.

The service exposes only `127.0.0.1:54329`, with database, username, and password
all set to `dfs_ev_test`. These public throwaway values belong only to this test
container. The schema bootstrap validates the full connection configuration and
verifies the connected database, role, and PostgreSQL 18 major before DDL.

For an already running disposable service, `test:db` requires an explicit URL:

```bash
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test npm run test:db
```

It accepts only `postgres:`/`postgresql:`, a loopback host (`127.0.0.1`,
`localhost`, or `::1`), port 54329, the exact `dfs_ev_test` database and throwaway
credentials, and no query options or fragment. `localhost` is connected through
127.0.0.1; IPv6 requires a separately provisioned loopback listener. The default
Compose service binds IPv4 only. Errors never include the supplied URL.
Missing or unsafe configuration fails before connecting; it never falls back
to `DATABASE_URL` and never skips tests.

These are harness checks, not a filesystem sandbox restriction. Application credential
files outside the worktree remain unopened by the agent. Production lookups
are run by the owner; agent use of a Production Vercel session requires explicit
approval for that action.

## Image and storage

The single Compose definition pins `postgres:18.6-alpine3.24` to its multi-platform
manifest digest, verified against the official registry. Major 18 matches the
production major confirmed during intake, replacing the issue's original
major 17 proposal. The same definition supports Apple Silicon locally and
Linux AMD64 in CI.

PostgreSQL 18 uses `/var/lib/postgresql/18/docker`; the parent
`/var/lib/postgresql` is a 512 MiB tmpfs mount. No database data volume survives
service removal. See the [official image's storage documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata).
Dependabot maintains the image through its weekly `docker-compose` entry and
the driver pair through its npm test-tooling group. Major PostgreSQL upgrades
remain deliberate; see the [dependency review guide](dependency-updates.md).

## Suite contract

`vitest.db.config.mts` selects only `tests/db/**/*.test.ts`, runs files serially,
and uses real Node timers. The jsdom suite excludes `tests/db/`. Setup installs
ordered migrations through the repository runner, then verifies a no-op rerun;
both calls verify the full application and ledger catalog before commit. The
generated `db/schema.sql` remains a checked reference and is never executed by
the bootstrap. An existing unversioned nonempty schema is refused without repair
or adoption. Setup truncates only `live_prop_inputs_cache` between cases.
Tracked database clients close after each case and suite.

The runner also validates Vitest's JSON report: all 13 required #45 cases,
four readiness cases and 12 predictive persistence cases must execute and pass.
Skipped/todo or missing cases fail. The #45 contract
covers full-schema bootstrap, including ledger/data-preserving reruns, plus
these lease scenarios:

- Plain 25-way acquisition races for both an absent row and stale cached data.
  Each contender has its own connected client and distinct `pg_backend_pid()`.
- Cold and stale acquisition transactions held open while all 24 competitors
  are observed blocked through `pg_stat_activity`, ungranted `pg_locks`, and
  `pg_blocking_pids()` chains reaching the holder. Only then does it commit;
  all competitors must return false.
- Renewal of a forced-expired lease restores exclusivity and prevents takeover;
  without renewal, its empty, expired row would be eligible for takeover.
  Forced expiry uses `UPDATE ... refresh_lease_until = now() - interval '1 second'`.
  A separate 25-way race produces exactly one takeover winner.
- Explicit characterization cases: expiry alone permits the current owner to
  renew or publish until replaced. Changing this policy requires deliberately
  changing these tests and production behavior.
- After takeover, the previous owner cannot renew, write, or release the new
  owner's lease.
- Both write/takeover orderings under real overlapping transactions. A held
  former-owner write commits fresh data, defeating every blocked takeover;
  alternatively a held takeover commits first, causing the blocked old write
  to throw the lease-lost error. Pending queries settle after commit or rollback
  before cleanup.
- Full `getOrRefreshLivePropInputs` orchestration across 25 database-backed
  consumers. A fake fetch stays deferred until every initial acquisition
  returns and all 24 followers enter a controlled wait. Followers resume after
  the owner publishes; all receive the same JSON payload with cleared ownership.

All five operations come from the production SQL factory. The provider wrapper
is untouched; these tests make no Odds API, weather, or Neon calls. The refresh
orchestration retains autocommit queries and real lifecycle timers. Explicit
transactions are limited to tests that control and observe lock ordering.
Freshness fixtures use the database clock; expiry never depends on sleeps.
Lock polling has a 7.5-second deadline and emits backend/lock diagnostics on
failure. See [PostgreSQL's lock view](https://www.postgresql.org/docs/18/view-pg-locks.html).

Migration, plan, catalog and contract scenarios each use a registered random
`dfs_ev_test_<20 hex>` database in the same service. They never drop/reset shared
`public` or depend on #45's file ordering; their scratch target guards continue
to refuse the primary `dfs_ev_test` database. Only #45's explicitly guarded
bootstrap installs into that fixed primary target. It does not broaden scratch
cleanup permissions. The two independent historical fixtures have committed
provenance and SHA-256 anchors; tests require no runtime Git history and work in
a shallow checkout. The four readiness cases use their own registered scratch
databases and the actual runtime SQL. They preserve synthetic rows and history,
refuse missing/behind/corrupt states and view substitutes, accept supported
ahead history with a warning, and prove the read-only/timeout/history bounds.

The predictive cases also use registered scratch databases; they never publish
to the primary test target. They cover PostgreSQL A/B cutoff replay, corrections
moving out of an indexed scope, former-team membership gaps and unrelated
schedule isolation, exact retries and changed-byte recaptures, atomic visibility
and concurrent retries, partial/refused diagnostic quarantine, conflict/lineage
rollback, typed evidence and append-only SQL constraints, missing/tampered source
bytes, indexed read-only membership queries, and journal restoration into fresh
databases. Each case uses a private temporary artifact root and removes its own
test files after closing clients and deleting the registered database. The
[predictive ingestion guide](predictive-ingestion.md) also provides a manual
proof command that preserves its artifact root for later restoration.

Migration/catalog/plan checks retain independent immutable v1/v2 fixtures and
contracts while validating the v3 tip. Genuine v2 remains application-ready.
Synthetic pending/ahead migration scenarios now append v4 to the current tip;
they do not redefine the historical v2 adoption evidence.

`scripts/db-test-contract.mjs` contains the reviewed static list of required
cases. The mandatory Node suite covers target/bootstrap/report guards and every
catalog, contract, migration, plan and readiness-artifact unit/integration case.
A custom reporter
consumes Node's documented test events and emits JSON alongside normal console
output. Its gate requires the complete successful summary and each named case
exactly once in its original file, with no skipped/todo/failed/cancelled results.
Deleting or filtering a test cannot remove its requirement automatically. New
mandatory cases need an explicit list update. The Vitest JSON gate independently
retains all lease, readiness and predictive requirements and also refuses
duplicate or incomplete results.
Reports are written into a unique temporary directory and removed in finally.

## Repetition check

Run 20 complete suites with the same disposable service, preserving per-case
reset and client cleanup:

```bash
npm run test:db:repeat -- 20
```

The default count is 20; an explicit integer from 1 through 100 is accepted.
Filters are refused in repetition mode. Every iteration must satisfy the full
Node, lease, readiness and predictive report contracts, plus both artifact drift checks. The
runner stops at the first failure and removes the
service after the run, including on failure or normal interruption.

Connection timeouts, statement timeouts, and bounded test hooks prevent a
broken server or blocked query from waiting indefinitely. An explicit cleanup
command remains available after exceptional process termination.

To check failure propagation and cleanup without changing a test:

```bash
npm run test:db:local -- --testNamePattern=deliberately-no-matching-case
```

That command must exit unsuccessfully and remove the disposable container.
It is validation evidence, not a passing integration run.

## CI enforcement

On PRs to `main` and pushes to `main`, `App checks` and `DB integration` run
independently on Linux. The database job runs a clean Node 24 `npm ci`, the
target/bootstrap/report guards, and `npm run test:db:local`. The local command
requires migration/reference integrity, all named database cases and freshly
rebuilt contract equality to succeed. This uses the same Compose file,
image digest, health check, loopback port, throwaway credentials, and tmpfs as
the laptop command. An additional `always()` cleanup step runs
`npm run test:db:down`; no production credentials or external database access
are configured in either CI job.

The sole job named `CI` depends on both jobs and uses `if: always()` with
`permissions: {}` and no checkout. It fails unless both dependency results are
exactly `success`, including when a dependency failed, was cancelled, or was
skipped. This retains the existing ruleset's required `CI` check without a
settings change. Workflow cancellation can cancel the gate itself; cancellation
does not provide a successful required check. GitHub documents these results
in the [needs context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context).

`npm run test:ci-gate` extracts and executes the actual inline gate shell script
against all 16 combinations of GitHub's four job results. It also rejects empty
or unexpected results and checks the gate's always-run condition, dependency
list, unique check name, empty permissions, and absence of checkout. This runs
inside `App checks`. The extraction checks the current YAML block layout;
`actionlint` remains the workflow syntax validator.

### Hosted gate validation

Local script tests cannot prove GitHub schedules the gate correctly. When
changing the gate, verify failure propagation on a separate, unmerged
validation branch with separately approved commits and pushes:

1. Change only the database test command to
   `npm run test:db:local -- --testNamePattern='^bootstraps'`. Open a draft PR to
   `main` so the actual workflow runs. The one-case suite must be rejected by
   the mandatory-report guard, `DB integration` must fail, and `CI` must run
   and fail with its database result shown as `failure`. Record the run URL,
   commit, job results, and cleanup evidence on #45.
2. Restore the database command in a follow-up commit without rewriting
   history. Obtain a complete successful run showing both upstream jobs and
   `CI` passing and record it. Close the validation PR without merging it, then
   delete its temporary local and remote branches.
3. Obtain passing checks on the final feature PR before the owner merges it.
   Record GitHub's acceptance of the new Dependabot Compose configuration and
   discovery/grouping evidence after merge; local schema validation is only
   preparatory.

Keep dated local validation results, tool versions, suite counts, audit
dispositions, and hosted run URLs on #45 rather than in this guide. The initial
hosted failure and passing proofs are recorded in the
[completed validation evidence](https://github.com/ven2dev/dfs-ev-demo/issues/45#issuecomment-5989637479).
Do not treat local truth-table coverage as hosted failure-propagation evidence.
