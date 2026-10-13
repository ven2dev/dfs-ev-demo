# #118 guarded evidence checkpoint

`replaySourceConsumers(ids)` is a local, restricted evidence primitive. It
reproduces recorded source features and final labels, returns `null` for missing
IDs, and preserves input ordering and repeated references. It does not select
training examples, verify caller-supplied kickoff assertions, seal membership,
enforce durable run splits, create pins or authorize model fitting.

## Protection and lock order

Migration 0012 is fixed for #106/#118 branch integration, as recorded in the
[integration handoff](predictive-106-118-integration.md). Its role-checked
`SECURITY DEFINER` guard explicitly locks the predictive evidence, rights,
association and retention tables in `SHARE` mode. Only `predictive_replay`
members may execute it; `PUBLIC` receives no execution privilege. The application
uses a READ COMMITTED transaction and acquires the guard before taking its clock
or selecting protected records. No evidence/rights write is performed.

These deliberately coarse local locks exclude direct SQL INSERT/UPDATE/DELETE,
TRUNCATE, publication and mandatory retention while verification is active.
Changes committed before the guard is acquired are visible; historical snapshot
permission cannot override them. Competing readers can coexist. Bounded lock
and statement waits refuse contention, rather than returning a partial result.
This is not a scalable hosted locking design.

The reader never acquires a blob digest lock. Its table locks keep committed
blob references and their dependent records stable. Cleanup, which holds the
digest lock, rechecks the exact storage reference and cannot unlink referenced
bytes. Publication continues to acquire digest locks before database writes.
Avoiding table-lock → digest-lock ordering in the reader prevents that inversion.
An owner manually modifying private files can still cause integrity refusal.

Every selected consumer passes the existing SQL association, current use rights
and calculation checks before the first protected file opens. Its verified rights
associations identify the complete protected profile/use set. Fresh, uncached
checks against the database clock run before each unique file and before
delivery; table locks cannot prevent a scheduled decision or expiry from taking
effect. The application independently reconstructs CSV projections, normalization
history, witnesses, decisions and numerical features/final labels. Hashes and SQL
plans do not substitute for source-byte verification.

## Shared work and limits

Transaction-local promise caches share identical queries, source reconstruction,
JSON file reads and CSV parsing, including concurrent requests for the same
dependency. Independent internal SELECTs can share a parameterized statement,
with at most 16 components. Parameter values remain bound, not interpolated.
Only internal JSON-compatible SELECT projections use this adapter.

Limits are 64 consumer references per call, 8 MB serialized selected records,
20 MB unique verified file bytes, 4,096 distinct metadata queries/verification
keys, 131,072 returned metadata rows and 20 MB cached metadata. Existing stricter
source lineage, row and artifact limits also apply. These are safety ceilings,
not demonstrated real-source capacity. A failed branch is drained along with
all other work before rollback; no pending query escapes into another operation.
Caches and locks end at commit/rollback, and later calls reverify their files.

The primitive retains the existing 10-second statement and 3-second lock waits.
End-to-end deadline/cancellation, sealed run/dataset APIs, invalidation, durable
pins/quotas and retention/restore integration remain #118 work. It must not be
advertised as a training-ready read API. Source receipts retain their actual
database times; no historical availability is inferred from a download today.

## Verification boundary

Mandatory PostgreSQL cases cover non-superuser replay, mixed feature/label
reconstruction, missing/repeated IDs, bounds, shared files at 1/16/64 distinct
consumer IDs, concurrent direct SQL rights changes and retention, committed and
scheduled revocation before further byte access, damaged files/associations and
guard release after failure. The pure dispatcher cases cover ordinal routing,
parameter offsets, shared in-flight failure, malformed responses and metadata
bounds. Frozen migrations 0001–0011 are unchanged.

The 1/16/64 fixture uses separate recorded IDs with identical producer bodies
and shared context. It demonstrates reuse, not independent examples or
multi-season real-source throughput. Report the distinct query/verification
counts, file reads, bytes, elapsed time and `EXPLAIN (ANALYZE, BUFFERS)` work for
the SQL preflight. Per-record SQL validation still grows with record count,
even when file verification is shared. Representative source populations,
peak-memory measurements, indexed selection plans and final numeric capacity
thresholds remain outstanding before #118 final review.

One local PostgreSQL 18 run on 2026-10-13 measured:

| Consumers | Distinct metadata SELECTs / statements | Unique files / bytes | Batch wall time | One SQL preflight execution |
| --- | --- | --- | --- | --- |
| 1 | 73 / 73 | 3 / 16,503 | 0.35 s | 0.06 s |
| 16 | 73 / 73 | 3 / 16,503 | 1.21 s | 0.94 s |
| 64 | 73 / 73 | 3 / 16,503 | 4.69 s | 3.86 s |

All three batches performed 24 distinct shared verification operations and
returned 94 metadata rows (98,035 serialized bytes). These statement counts
describe reconstruction metadata only; transaction/target/guard setup, one
per-record SQL preflight statement, rights-profile discovery and fresh file/
delivery access checks are additional. The preflight performs 1/16/64 full
consumer checks, with approximately 2,900 / 46,476 / 184,296 shared buffer hits.
Those costs show the remaining linear server work despite constant shared
reconstruction. The separate EXPLAIN probe is outside the timed batch. These
figures are a fixture observation, not a service-level or throughput guarantee.

Final checkpoint gates: **700 Node tests**, **75 Node DB checks + 142 PostgreSQL
tests** (including 117 mandatory predictive cases), TypeScript, affected-file
ESLint, whitespace and local documentation links pass. Catalog contracts and
migration/readiness checks pass; readiness remains minimum v2, maximum v12.
Only disposable local databases ran 0012. Logs are
`/private/tmp/dfs118-guard-{node,db}.log`. This verifies the evidence increment;
the outstanding training APIs and retention requirements above still prevent
#118 closure.
