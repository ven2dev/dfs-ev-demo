# Database migration intake and catalog evidence

Issue #60 establishes versioned SQL delivery. The approved roadmap is at
[the issue](https://github.com/ven2dev/dfs-ev-demo/issues/60#issuecomment-6006046013).
Step 0 supplies catalog evidence. Step 1 adds candidate SQL files and a runner
for harness-owned disposable databases; owner-run remote execution, deep
catalog verification and adoption remain pending. The owner approved developing
and testing this candidate runner locally while Production evidence is pending.

The roadmap and these instructions use the same step numbers:

| Step | Deliverable |
| --- | --- |
| 0 | Read-only catalog evidence |
| 1 | Candidate runner, ledger, lock and guards |
| 2 | Full catalog verifier and generated contracts |
| 3 | Fingerprint-bound plan and verified adoption |
| 4 | Isolated proofs, shared #45 bootstrap and required CI |
| 5 | Protected database readiness |
| 6 | Release/recovery documentation and acceptance handoff |

Steps 0 and 1 are intermediate commits within one migration-delivery PR.
Do not merge/deploy this intermediate state: remote `up` is still unavailable,
and the generated reference header is not an operational rollout instruction.
Complete the remaining steps and approved schema prerequisites before merge.

## Candidate migrations and local runner

`db/migrations/0001_pre_41_baseline.sql` preserves the authentic eight-table
historical schema byte for byte. `0002_market_observation_history.sql` adds the
nine #41 tables; concatenating these files preserves the original current SQL
and its comments. These are source candidates, not an assertion about what was
deployed to Production. A comparison may require a separately reviewed appended
reconciliation migration before adoption can be implemented.

The repository-owned core uses one dedicated client and one transaction for
all pending files, ledger inserts and verification. It takes a transaction
advisory lock with `pg_try_advisory_xact_lock`; contention fails immediately.
This provides mutual exclusion with a fail-fast policy rather than queueing and
automatically serializing competing invocations. The operator must retry with a
freshly approved plan once the other transaction finishes.
Transaction-local timeouts bound lock waits to three seconds, statements to
15 seconds and idle transactions to 15 seconds. Whole multi-statement files
execute directly through the client. Migration files cannot issue transaction
or session-control statements; the runner owns those boundaries and settings.

For a future hot-table ALTER requiring different timeouts, first deliver a
separately reviewed runner extension for bounded per-migration `lockTimeoutMs`
and `statementTimeoutMs` metadata. The runner would validate explicit limits,
apply the options through transaction-local settings immediately before that
file, and restore its defaults before the next file and final verification.
Those options must be covered by the committed manifest and approved-plan
fingerprint, with real-Postgres timeout/rollback tests. This extension is not
implemented yet; embedded `SET LOCAL`, broad session-control exemptions and
unbounded timeout overrides remain refused. The migration author must add the
supported option before writing the first migration that needs it.

`public.db_migrations` records ordered versions, filenames, non-null SHA-256
checksums, runner version, executed/adopted provenance and application
time. Step 1 writes only `executed` records. The reader rejects empty existing
ledgers, version holes, missing fields, checksum mismatches and unsupported
runner versions. An unversioned nonempty schema is refused without mutation.
Existing valid prefix history can receive pending files in scratch tests;
reruns preserve ledger timestamps and application rows.

The initial verifier checks the exact candidate table set and ledger history
before commit. Step 2 will replace this minimum check with complete generated
catalog contracts. A table-name check alone does not qualify an existing schema
for adoption. Step 3 owns fingerprint-bound plans and owner-run remote `up`;
`db:migrate up` currently refuses before connecting.

Use Node 24, no application credentials and the existing Compose service:

```bash
docker compose --env-file /dev/null --project-name dfs-ev-demo-test \
  -f compose.test.yml up -d --wait --wait-timeout 60
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run db:migrate:dev
npm run test:db:down
```

The dev command creates a randomly named, registered scratch database, checks
the connected database/role/PostgreSQL major, installs the candidates, reruns
them as a no-op, then closes and removes the scratch database in finally. It
reports versions only after scratch cleanup. It does not migrate the shared
`dfs_ev_test` database. The container lifecycle above is manual: run
`test:db:down` even if the dev command fails. The existing #45 test harness still
uses the generated schema reference until the shared-bootstrap work in Step 4.

## Migration artifacts and immutability

`db/migration-manifest.json` commits the SHA-256 checksum for every SQL file.
`.gitattributes` enforces LF for SQL and the manifest. Files must use ordered,
contiguous four-digit versions starting at 0001; down files, symlinks, invalid
UTF-8, CRLF and empty content are refused.

```bash
npm run db:migrations:check
npm run test:db:migrations:unit
```

The check verifies SQL against the complete manifest and verifies `db/schema.sql`
against commented migration-file concatenation. The reference is generated;
edit ordered migration files rather than the reference. Append a reviewed file,
then run `npm run db:migrations:generate`. Generation preserves the checksums of
all previously recorded files and refuses edited/deleted history. Applied files
are immutable; corrections require a new forward migration. These commands do
not connect to any database. Step 4 adds their required CI execution.

## Read-only migration status

With the same owner-verified target identity used for catalog export:

```bash
npm run db:migrate -- status --environment production \
  --expected-host-fingerprint HOST_FINGERPRINT --expected-database DATABASE_NAME
```

The owner runs this with explicit `MIGRATION_DATABASE_URL` in their own terminal.
The command shares the catalog export's direct-endpoint and target guards, does
not load `.env`, and has no `DATABASE_URL` fallback. It checks local migration
artifacts before connecting and reads ledger metadata inside a bounded
`REPEATABLE READ READ ONLY` transaction. It never creates a ledger. An absent
ledger reports version 0; existing invalid history fails with a safe fixed code.
Status is ledger information, not readiness or deep schema verification.

Actual Neon transport remains **pending owner evidence**. CI exercises the `pg`
path only; the first owner-run Production `status` is the smoke test for Neon
Client's WebSocket connection, read-only transaction and transaction-local
settings. Record its date, commit, Node/driver versions, exit code and sanitized
status (or fixed failure code) on #60. Verify the hashed target identity without
posting URLs, credentials or raw driver errors. A local pg pass is not a Neon
transport pass; no successful remote outcome is claimed here.

## Owner-run Production snapshot

Run these commands in your own terminal, outside an agent-attached shell, using
Node 24. Set `MIGRATION_DATABASE_URL` through your existing secure procedure to
the **direct, non-pooled Production Neon endpoint**. Never paste that value into
chat, a command argument, an issue or a log. The exporter does not load any
credential file, `.env`, or Vercel session, and cannot fall back to `DATABASE_URL`.

From this checkout, inspect only the hashed URL identity:

```bash
npm run db:catalog -- --environment production --identity
```

This does not connect to the database. Verify the URL's resource against your
Production-only Vercel integration and note the returned `hostFingerprint`.
`production` is an owner-supplied label, not independently verified environment
classification. Both Preview and Production may have the same database name;
the database name alone is insufficient identity evidence.

Create a private output directory, then replace `HOST_FINGERPRINT` and
`DATABASE_NAME` below with the verified hash and actual database name:

```bash
umask 077
mkdir -p "$HOME/.config/dfs-ev-demo/db-snapshots"
npm run db:catalog -- --environment production \
  --expected-host-fingerprint HOST_FINGERPRINT \
  --expected-database DATABASE_NAME \
  --output "$HOME/.config/dfs-ev-demo/db-snapshots/production-before-60.json"
```

The output file must be outside this repository and is created exclusively with
mode 600. An existing file is never overwritten. The command prints only a
table count and catalog fingerprint; failures print fixed codes rather than
connection strings, driver errors or private filesystem paths. Missing output
directories must be created before connecting. A successful snapshot includes
the actual PostgreSQL version and hashed URL identity; the connected database
and role must match the supplied connection configuration. Only PostgreSQL 18
is supported by this initial catalog format.

The transaction is `REPEATABLE READ READ ONLY`, with transaction-local lock and
statement timeouts and a fixed search path. It reads catalog definitions for
relations, columns/defaults, constraints/validation state, indexes, sequence
configuration/ownership, custom triggers, policies, routines, types and
extensions in `public`. It never reads application rows, sequence progress,
ledger contents, hostnames or role names into the exported artifact. Definitions
can contain SQL constants or routine bodies: inspect the artifact before sharing.
This is a schema inventory, not a complete PostgreSQL privilege/cluster dump.

The snapshot is prerequisite evidence, not permission to mutate Production.
In particular, determine whether all nine #41 tables are present:
`odds_observations`, `odds_quote_sets`, `odds_observation_markets`,
`odds_observation_book_markets`, `odds_quotes`, `odds_free_pilot_selections`,
`odds_priority_targets`, `odds_collection_checkpoints`, and `odds_api_request_log`.

## Candidate comparison and mismatch disposition

The eight-table candidate comes from
`68c65f6e918730b0d8b22a761a482a79225347b6:db/schema.sql`, the parent of the first
#41 schema commit. Current source defines 17 tables. Neither is assumed to match
Production: earlier `CREATE TABLE IF NOT EXISTS` applications may have preserved
older definitions. Local candidate exports use the same exporter on synthetic
scratch databases; dates, target hashes, minor versions, rows and sequence
progress do not affect their normalized catalog comparison.

Compare two explicitly selected catalog JSON files:

```bash
npm run db:catalog:diff -- --expected /path/to/current-candidate.json \
  --actual /path/to/production-before-60.json
```

Every missing/unexpected object and every changed definition field is printed;
differences return exit code 1. PostgreSQL-major differences require regeneration
and review, rather than erasing the version difference. This comparison reports
evidence; it does not choose an adoption baseline or create a migration ledger.
Resolve each mismatch on #60 through an approved contract correction or an
explicit reconciliation migration before adoption logic is implemented.

## Local verification

No real credentials are needed. `test:db:catalog:unit` verifies target/argument
guards, fingerprinting, private output placement, safe errors and complete diff
reporting. `test:db:catalog` requires the existing fixed `TEST_DATABASE_URL` and
a running service from `compose.test.yml`. It creates random, registered
`dfs_ev_test_*` scratch databases within that guarded container, verifies its
database/role/major before any fixture setup, then closes and removes each
scratch database in finally. It does not reset #45's shared schema. These tests
must fail without the disposable target; they never skip or use DATABASE_URL.

`test:db:migrations` uses the same fixed disposable service and a separately
registered scratch database per scenario. It proves empty installation against
the authentic current catalog, data/ledger-preserving no-op reruns, read-only
status, refusal of unversioned schemas, two-file failure rollback, verification
rollback, independently connected lock contention and concurrent runners,
corrupt-ledger rejection and scratch target/cleanup guards. The committed
`tests/db/fixtures/` schemas retain source-object provenance and SHA-256 anchors;
tests use those immutable independent copies without needing Git history. Run it with
the explicit `TEST_DATABASE_URL` while the Compose service is running. Step 4
owns the aggregate named-case/report gate and shared #45 migration bootstrap.

Keep dated results and snapshot/mismatch dispositions on #60. Actual remote
Neon transport and Production schema remain unverified until the owner runs the
export. [#86](https://github.com/ven2dev/dfs-ev-demo/issues/86) separately owns
Neon-console, branch and point-in-time restore access.
