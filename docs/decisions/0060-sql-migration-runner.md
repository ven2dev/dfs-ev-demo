# #60 SQL migration runner decision

Status: selected for the approved roadmap. The owner approved the Step 1
candidate runner on disposable local databases while Production catalog
evidence is pending. Production reconciliation, adoption and remote execution
still require that evidence and its mismatch decision. Scope is transactional,
forward SQL migrations, not a general migration framework.

## Decision

Use a small repository-owned runner over an injected, dedicated query client.
Retain the existing `pg` dev client locally and Neon Client for owner-run direct
remote sessions. Add no migration package dependency.

## Bounded comparison

The comparison covered Postgrator 8.0.0's README and implementation plus the
minimum operations a small custom core would require:

| Required responsibility | Postgrator with wrapper | Repository-owned core |
| --- | --- | --- |
| Ordered plain SQL execution | Provided | Validate names, iterate files |
| Lock plus atomic multi-file SQL/ledger commit | Wrapper owns it | Core owns it |
| Read-only status/plan without ledger creation | Wrapper queries directly | Shared reader |
| Complete ledger prefix and non-null checksums | Wrapper validates it | Shared validator |
| Verified adoption and adopted/executed provenance | Wrapper inserts adoption metadata | Explicit ledger inserts |
| Approved-plan fingerprint and recomputation | Wrapper owns it | Shared planner |
| Deep catalog verification, generated contracts | Wrapper owns it | Shared verifier |

[Postgrator's source](https://github.com/rickbergfalk/postgrator/blob/master/postgrator.js)
calls `ensureTable` during migration, executes SQL and its ledger insert
separately, and validates MD5 only when both compared values are present.
An outer transaction can make those operations atomic, but does not supply the
other required guarantees. Its filename parser and execution loop are the
remaining benefit once this issue's wrapper is implemented.

The custom core should remain approximately 100 lines for transaction/lock,
pending-file execution and ledger insertion. CLI safety, planning, verification
and tests are separate modules and are not claimed to fit that estimate.
Avoid SQL splitting: execute each reviewed multi-statement file through the
session client. The project owns maintenance of this core and its meaningful
real-Postgres failure/rollback tests. This decision is about responsibility
overlap, not an assertion that Postgrator is unsafe or unmaintained.

Both alternatives require LF-enforced SQL, a committed MD5/SHA-256 manifest,
immutable applied files, complete history validation, transaction-scoped
advisory locking, `SET LOCAL` bounded timeouts, and a test where the second of
two migrations fails and rolls back the first. Those remain acceptance work;
the catalog exporter does not implement them.

[Neon's driver documentation](https://github.com/neondatabase/serverless#pool-and-client)
supports interactive sessions through Client and native WebSockets on Node 24.
Local pg success does not prove the actual Production transport; the owner-run
catalog export records that evidence without changing the database.

Because Postgrator is not being added, no new dependency pin or Dependabot group
is needed. Existing pg/@types/pg remain in test-tooling; future updates must pass
the migration suite once delivered.
