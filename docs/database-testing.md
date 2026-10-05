# Disposable PostgreSQL tests

Issue #45 runs the shared live-prop refresh SQL against a real disposable
database. Production continues to use Neon; `pg` and `@types/pg` are exact-pinned
development dependencies. Issue #60 can reuse the full-schema bootstrap for
migration tests.

## Local commands

Use Node 24 and a running Docker Desktop (or a local Docker Engine with Compose).
From the repository root:

```bash
nvm use
npm run test:db:guard
npm run test:db:local
```

`test:db:local` starts `compose.test.yml`, waits up to 60 seconds for health,
runs the separate database suite, and removes the service and its network even
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
The harness refuses an environment containing `DATABASE_URL`, `ODDS_API_KEY`,
Firebase Admin variables, Google application credentials, or ambient
`POSTGRES_*`/`PG*` configuration. Run it from a shell without those variables.

The service exposes only `127.0.0.1:54329`, with database, username, and password
all set to `dfs_ev_test`. These public throwaway values belong only to this test
container. The schema bootstrap verifies the database, role, and PostgreSQL 18
major before executing DDL.

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
manifest digest, verified against the official registry. Production reported
PostgreSQL 18.6 during intake on 2026-10-04; matching major 18 replaces the
issue's original major 17 proposal. The same definition supports Apple Silicon
locally and Linux AMD64 in CI.

PostgreSQL 18 uses `/var/lib/postgresql/18/docker`; the parent
`/var/lib/postgresql` is a 512 MiB tmpfs mount. No database data volume survives
service removal. See the [official image's storage documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata).
Dependabot maintenance for the image and driver is added with step 4's CI work.

## Suite contract

`vitest.db.config.mts` selects only `tests/db/**/*.test.ts`, runs files serially,
and uses real Node timers. The jsdom suite excludes `tests/db/`. Setup applies
the complete `db/schema.sql` twice and truncates only `live_prop_inputs_cache`
between cases. Tracked database clients close after each case and suite.

The runner also validates Vitest's JSON report: required cases must execute and
pass, and skipped/todo or missing cases fail. Step 2's required case verifies
full-schema bootstrap; step 3 extends the contract with all lease scenarios.
This bootstrap check alone does not establish concurrent lease correctness.

Connection timeouts, statement timeouts, and bounded test hooks prevent a
broken server or blocked query from waiting indefinitely. An explicit cleanup
command remains available after exceptional process termination.

To check failure propagation and cleanup without changing a test:

```bash
npm run test:db:local -- --testNamePattern=deliberately-no-matching-case
```

That command must exit unsuccessfully and remove the disposable container.
It is validation evidence, not a passing integration run.
