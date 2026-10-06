# Database migration intake and catalog evidence

Issue #60 establishes versioned SQL delivery. The approved roadmap is at
[the issue](https://github.com/ven2dev/dfs-ev-demo/issues/60#issuecomment-6006046013).
Step 0 supplies catalog evidence. Step 1 adds candidate SQL files and a runner
for harness-owned disposable databases. Step 2 supplies complete catalog
contracts and transactional verification. Owner-run remote execution and
adoption remain pending. Step 3 adds read-only fingerprint-bound plans and
verified adoption on registered scratch databases. The owner approved developing
and testing the candidate locally while Production evidence is pending.

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

Steps 0–3 are intermediate commits within one migration-delivery PR.
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
The advisory lock excludes other participating runners. Manual schema changes
do not take this lock; a remote rollout must control concurrent DDL separately.
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
time. The original scratch bootstrap writes only `executed` records. The reader
rejects empty existing ledgers, version holes, missing fields, checksum mismatches and unsupported
runner versions. The original bootstrap refuses an unversioned nonempty schema
without mutation; the approved-plan engine can adopt an exactly verified prefix
as described below.
Existing valid prefix history can receive pending files in scratch tests;
reruns preserve ledger timestamps and application rows.

The verifier compares the complete managed `public` catalog against the reviewed
contract for the target version plus the exact ledger contract before commit,
including a no-op rerun. It collects definitions inside the runner's existing
transaction without opening or committing another transaction. Any mismatch
rolls back pending SQL and ledger writes; it never repairs drift. A nonempty
unversioned database cannot receive application SQL until the approved-plan
engine has verified and recorded its recognized prefix. This guard protects
the byte-preserved `IF NOT EXISTS` statements from masking drift.
`db:migrate up` currently refuses before connecting while owner rollout
evidence is pending; only the registered scratch engine can mutate a target.

Use Node 24, no application credentials and the existing Compose service:

```bash
docker compose --env-file /dev/null --project-name dfs-ev-demo-test \
  -f compose.test.yml up -d --wait --wait-timeout 60
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run db:migrate:dev
npm run test:db:down
```

The dev command creates a randomly named, registered scratch database, checks
the connected database/role/PostgreSQL major, computes and approves a local
install plan, applies it, then computes and applies a fresh no-op plan. It
closes and removes the scratch database in finally. It
reports versions only after scratch cleanup. It does not migrate the shared
`dfs_ev_test` database. The container lifecycle above is manual: run
`test:db:down` even if the dev command fails. The #45 test harness now uses this
runner's guarded empty/prefix bootstrap and full catalog verification on its
fixed disposable primary database.

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
not connect to any database. The mandatory disposable DB command runs this
artifact check in CI before the database cases.

## Generated catalog contracts

`db/catalog-contracts/0001.json` and `0002.json` describe the application catalog
after each migration prefix. `ledger.json` independently describes the ledger
DDL. Each artifact has a SHA-256 catalog fingerprint and binds the exact catalog
query plus its migration-prefix checksums or ledger-DDL checksum/runner version.
The local dev command validates these bindings before connecting. Adding a
migration requires its new prefix contract; a missing, stale, edited or extra
contract is refused. Runtime verification cannot regenerate or bless artifacts.

With the disposable Compose service running and the fixed test URL:

```bash
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run db:contracts:generate
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run db:contracts:check
npm run test:db:contracts:unit
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run test:db:contracts
```

Generation builds each migration prefix and the ledger directly from reviewed
SQL in separate registered scratch databases, independently of the verifier it
is generating. It rolls back the scratch transactions and removes all databases
before writing any artifacts. Review the complete generated diff with the SQL;
generation deliberately rewrites contracts, while the migration-manifest guard
continues refusing edits to known migration bytes. The check rebuilds the same
catalogs, reports every missing/changed/unexpected artifact and exits nonzero on
drift without writing. The mandatory disposable DB command runs this independent
contract drift check in CI as well as the verifier cases.

Comparison includes column positions/types/nullability/defaults, identity and
generation state, collation, PK/unique/check/FK definitions, validation and
enforcement, internal FK-trigger enable states, index definitions/validity/
readiness, sequence configuration and column ownership, relation options,
inheritance, view/partition definitions, RLS policies and their target roles,
custom triggers/rules/routines, enum/domain definitions and domain constraints,
and extensions. All missing/unexpected objects and changed fields are reported.
Extension members identified by `pg_depend.deptype = 'e'` are excluded from
individual object comparison; the extension's name, version and relocatability
form its reviewed catalog entry. Children of an extension-owned relation or
domain are excluded with their parent. An unreviewed extension still produces
an unexpected extension mismatch; this does not authorize adding an extension
or adopting a Production schema. The owner must resolve it from the snapshot
through an explicit contract/migration decision.
The ledger is included by its exact catalog objects; no name-prefix exemption
can hide a similarly named unexpected table, index or trigger.

Environmental owner roles, OIDs, actual server minor version, target identity,
capture time, row data and mutable sequence counters are excluded from
contracts. Policy target roles and FK-trigger states are semantic definitions
and are retained. PostgreSQL-major changes require updating the explicitly
supported major, regenerating every contract and reviewing the SQL/deparser
differences and real-Postgres proofs before adopting or migrating that major.
No automatic normalization erases a major-version difference.

`collectCatalog` verifies that the effective search path is exactly
`pg_catalog, public` before running the inventory. `public` with implicit
`pg_catalog` is equivalent. Other paths, including shadow or temporary schemas,
fail with `catalog-search-path-refused` rather than producing false definition
differences. Callers must configure the supported path within their own
transaction; the collector does not change session settings or transaction
boundaries. The read-only exporter pins a transaction-local path and restores
the inherited session path at commit/rollback.

The supported contract scope is the managed `public` schema, not cluster
privileges or other schemas. Standalone composite/range/base types, custom
collations/operators/operator classes/families/conversions, text-search objects
and extended statistics are inventoried as `unsupported`; aggregates also lack
a complete definition contract. Their presence fails comparison, and generation
refuses to bless them. Add complete definition coverage with proofs before a
migration introduces one of these classes. This keeps unexpected objects from
silently falling outside the comparison.

The strengthened Step 2 inventory adds fields to the Step 0 export. Re-export
any older snapshot with this checkout before deciding mismatch disposition;
do not erase absent fields from older evidence to make a comparison pass.

Raw column positions and one full contract per migration prefix remain explicit
candidate limitations. A Production snapshot with dropped-column history may
show a position-only mismatch; record it for an approved normalization decision
before adoption. Contract storage grows with cumulative schema size and can be
revisited separately. The plan artifact exposes the complete readable mismatch
list to the owner while operational CLIs retain fixed-code logging.

## Fingerprint-bound plans and local adoption

After verifying the same direct endpoint used for the catalog export, the owner
can generate a read-only plan in their own terminal:

```bash
npm run db:migrate -- plan --environment production \
  --expected-host-fingerprint HOST_FINGERPRINT --expected-database DATABASE_NAME \
  --output "$HOME/.config/dfs-ev-demo/db-snapshots/production-plan-60.json"
```

Use explicit `MIGRATION_DATABASE_URL`; no `.env` or application `DATABASE_URL`
fallback is available. The command uses a bounded `REPEATABLE READ READ ONLY`
transaction and never creates a ledger. The destination must be outside the
repository, including symlinked parent directories. It is created exclusively
with mode 600 and is never overwritten. Definitions and complete readable
differences remain in this private artifact. Stdout reports only hashed target
identity, the fingerprint, operations, mismatch count and fixed refusal code.
A non-executable catalog plan still writes its evidence and exits nonzero;
invalid ledger history fails without repair.

The plan identifies the observed schema and ledger versions separately:

| Observed state | Planned operations |
| --- | --- |
| Empty managed catalog, no ledger | Execute all migrations |
| No ledger, exactly one matching migration-prefix catalog | Adopt that prefix, execute only later files |
| Valid ledger and matching full prefix plus ledger catalog | Execute only pending files, or verify a no-op |
| Unrecognized/ambiguous unversioned catalog or recorded catalog drift | No operations; readable differences and refusal |
| Existing empty/corrupt ledger | Refusal without repair or adoption |

The deterministic SHA-256 fingerprint binds the declared environment, full
host/database/role/port identity, PostgreSQL major, observed catalog, complete
ledger history including timestamps/provenance, immutable migration checksums,
runner version, catalog-query/ledger-contract bindings, target version and
ordered operations. Displayed identity hashes are shortened; the fingerprint
also binds a full composite identity hash. Passwords, row data and mutable
sequence counters are excluded. Local source bytes and contracts are validated
and frozen before connecting; they cannot change between planning and execution.

The scratch engine requires an explicit approved fingerprint. Inside one
transaction it acquires the shared fail-fast lock, reads history/catalog and
recomputes the plan before any ledger DDL, application SQL or insert. Changed
target, source, schema or history refuses the old approval. Adoption inserts
`adopted` rows for a verified prefix without replaying its SQL; later files run
with `executed` provenance. Final verification checks the full application and
ledger catalog, complete target history, unchanged prior ledger rows and each
new row's planned provenance before commit. Any failure rolls back both adoption
and pending SQL. Even a no-op needs a fresh matching plan and final verification.

```bash
npm run test:db:plans:unit
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run test:db:plans
```

This iteration exposes owner-run read-only `plan`, not remote adoption.
`up` requires `--approved-plan-fingerprint` but still refuses Preview/Production
with `owner-rollout-evidence-pending`; test CLI `up` refuses `scratch-up-only`.
Local mutation proofs use registered random scratch databases through the same
approved-plan engine. Production snapshot comparison/disposition, actual Neon
transport evidence and recovery prerequisites remain pending. Their owner
approval and a separately reviewed remote activation must precede rollout and
the complete migration PR's merge. A matching local plan is not Production
acceptance evidence.

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
ledger contents, hostnames or owner role names into the exported artifact. Policy
target roles are part of their definitions and remain visible. Definitions
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

`test:db:contracts:unit` checks source/fingerprint binding, artifact drift,
unsupported-class refusal and safe CLI guards. `test:db:contracts` proves both
prefix contracts against independent historical fixtures, complete multi-field
drift reporting, unvalidated/unenforced constraints, disabled internal FK
triggers, naturally invalid concurrent indexes, upgrade rollback observed by a
second connection, ledger-definition drift and deterministic regeneration.

`test:db:plans` proves deterministic read-only plans, seeded current adoption
without application SQL replay, baseline adoption/upgrade and recorded-prefix
upgrades, readable drift, ambiguous-prefix refusal, stale fingerprints,
corrupt-ledger refusal, SQL/verifier rollback, prior/new ledger-result integrity,
independent-client lock/concurrency behavior, private CLI artifacts and scratch
target guards. Data, sequence state and prior ledger rows survive adoption or a
failed upgrade. It uses the same registered scratch lifecycle.

`test:db:migrations` uses the same fixed disposable service and a separately
registered scratch database per scenario. It proves empty installation against
the authentic current catalog, data/ledger-preserving no-op reruns, read-only
status, refusal of unversioned schemas, two-file failure rollback, verification
rollback, independently connected lock contention and concurrent runners,
corrupt-ledger rejection and scratch target/cleanup guards. The committed
`tests/db/fixtures/` schemas retain source-object provenance and SHA-256 anchors;
tests use those immutable independent copies without needing Git history. Run it with
the explicit `TEST_DATABASE_URL` while the Compose service is running.
`npm run test:db:local` now requires all catalog/contract/migration/plan unit and
integration cases through a static named-case JSON report gate, both artifact
checks and all 13 #45 lease cases using the shared runner bootstrap. Repeat this
complete pipeline with `npm run test:db:repeat -- 3` to check isolation. See the
[database test guide](database-testing.md) for lifecycle and CI enforcement.

Keep dated results and snapshot/mismatch dispositions on #60. Actual remote
Neon transport and Production schema remain unverified until the owner runs the
export. [#86](https://github.com/ven2dev/dfs-ev-demo/issues/86) separately owns
Neon-console, branch and point-in-time restore access.
