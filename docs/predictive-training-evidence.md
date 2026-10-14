# #118 guarded evidence checkpoint

## Immutable run-inventory increment

Migration 0014 adds database-enforced run preparation and guarded metadata
replay. `prepareFittingRun(request)` independently validates the complete
request in SQL, fixes every assigned shard's consumer IDs/missing states and
reserves run/plan/fold identity at the database clock. `readFittingRun(id)`
checks immutable body/slot/event/profile closure, cited consumers and fresh
rights. Requests cannot extend the run after preparation. Same-request retries
return the original inventory even after newer consumers are recorded.

Run-wide target-event exclusion is enforced across players and shards. Exact
references must match approved candidate/version/history, target and clocks.
Fixed-holdout plans refuse cross-run event reuse; walk-forward plans expose
reused event/player-target counts as correlated evidence. The recorder has only
function execution and must also hold replay membership. Concurrent preparation
uses publication/retention's advisory-lock order, then evidence/inventory guards.
The extended read guard preserves its public signature without copying the
old evidence lock list.

These APIs return metadata, not byte-backed training data: `inventory-sealed`,
`fittingReady: false`, population unqualified. Preparation opens no artifact
file and creates no pins. It limits pending inventories to 32 and enforces
1,024 slots/run, 256/shard, 32 shards, 16 protected profiles and an 8 MB body.
Context outside the selected feed scope counts toward that profile ceiling,
including when consumers are missing.
These are initial ceilings rather than benchmarked capacity.

An authorized-retention trigger erases the full pending inventory for named
protected profiles, including missing slots and narrow capture windows. It
also removes inventories citing expired source features. The hook runs in the
existing retention transaction and leaves legacy removal counts/digest intact.
Optional `trainingRetention` audit adds inventory counts/digest, participates
in restored-backup matching, and exposes no raw run IDs in digest-only mode.
Digest-only run/plan/fold identities remain to prevent erased-history reuse.
Failure rolls back both ledgers and their audits together.

Seven mandatory PostgreSQL cases cover restricted-role preparation/replay,
exact/latest selections and immutable retries, SQL forgery and split leakage,
concurrency, missing-slot mandatory deletion, rights/association refusal,
failed deletion and restored audit parity, and v13 upgrade preservation. The
next increment must verify fixed shard bytes, seal dataset manifests and pin
the complete evidence closure. Paging, current-label API, release/quotas,
durable expiry/invalidation, deadlines and real-source capacity remain open.
Gzip staging from #106 is integrated; qualified gzip publication and guarded
binary reconstruction remain unimplemented.

Final inventory checkpoint: **736 Node tests**, **75 Node DB checks + 158
PostgreSQL tests** (133 mandatory predictive cases), typecheck, affected-file
ESLint, migration/catalog/readiness artifacts, frozen-prefix verification,
whitespace and local documentation links pass. The final full DB run includes
the tightened total-profile guard and all seven new inventory cases. Frozen
0001–0013 SQL and catalog contracts match `da24ab9` byte-for-byte. Readiness
remains minimum v2, maximum known v14. Logs are
`/private/tmp/dfs118-inventory-node.log`,
`/private/tmp/dfs118-inventory-db.log` and
`/private/tmp/dfs118-inventory-profile-limit-db.log`. The migration ran only in
disposable local databases. #118 is still incomplete and not training-ready.

## Run-selection preview increment

`previewFittingRun(request)` now connects the structural request and SQL selector
to guarded evidence verification. It takes one post-guard database clock and
retains the complete normalized training/evaluation/shard inventory. The
database selects exact/latest consumer references once. The pure selector uses
those fixed IDs and full-lineage supersession flags; it does not infer heads
from a smaller returned subset or replace a missing selection with another
slot's matching record.

The adapter independently verifies each asserted target kickoff against the
cutoff-visible schedule chain. It expands corrections that route away from the
game, detects raw-game aliases, validates any reconciliation decision and
requires the asserted observation, season/type and kickoff to match the selected
head. Kickoff dependencies may belong to profiles outside the selected source
feature's profile set. Their historical and current internal-research/model-input
rights pass before any file is opened, including when every consumer is missing.
Current gates still run before each unique file and delivery.

The result contains exact references, dependency hashes/clocks, missing/expired/
unavailable/usable states, label supersession, request and snapshot-selection
digests and reconciled per-partition counts. It returns no numeric feature or
label bodies. It is **preview-only**, not a persistent training dataset:
`fittingReady` is false, population is unqualified, and no run identity,
membership or pin is recorded. A future database recorder must enforce the
complete request independently and establish its own snapshot. Preview retries
can have different snapshot/selection digests, so they are not durable retries.

Five additional mandatory database tests use real files, restricted logins,
hand-specified selected IDs/counts and concurrent SQL. They cover old/new/exact
feature selection with missing slots, incorrect/late/corrected schedule claims,
rights refusal before bytes even for a missing consumer, corrupted context,
historical label clocks/supersession and input mutation/publication during a
guarded snapshot. Six pure cases cover fixed-subset semantics, malformed
metadata and detached preview digests/counts. This increment changes no SQL
migration or byte format. Durable run/dataset enforcement, pins, release,
invalidation, retention recovery, deadlines and representative capacity remain
unfinished.

The preview checkpoint passes **706 Node tests**, **75 Node DB checks + 147
PostgreSQL tests** (122 mandatory predictive cases), typecheck, affected-file
ESLint, migration/readiness artifacts and whitespace. Logs:
`/private/tmp/dfs118-preview-{node,db,focused-db}.log`. The prefix is still
0001–0012 at this checkpoint; #106's newly declared 0013 will be integrated next.

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

Initial guarded checkpoint gates: **700 Node tests**, **75 Node DB checks + 142 PostgreSQL
tests** (including 117 mandatory predictive cases), TypeScript, affected-file
ESLint, whitespace and local documentation links pass. Catalog contracts and
migration/readiness checks pass; readiness remains minimum v2, maximum v12.
Only disposable local databases ran 0012. Logs are
`/private/tmp/dfs118-guard-{node,db}.log`. This verifies the evidence increment;
the outstanding training APIs and retention requirements above still prevent
#118 closure.
