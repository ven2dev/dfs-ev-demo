# Database migration intake and catalog evidence

Issue #60 establishes versioned SQL delivery. The approved roadmap is at
[the issue](https://github.com/ven2dev/dfs-ev-demo/issues/60#issuecomment-6006046013).
This first step supplies catalog evidence; migration execution and adoption
are not implemented yet.

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

Keep dated results and snapshot/mismatch dispositions on #60. Actual remote
Neon transport and Production schema remain unverified until the owner runs the
export. [#86](https://github.com/ven2dev/dfs-ev-demo/issues/86) separately owns
Neon-console, branch and point-in-time restore access.
