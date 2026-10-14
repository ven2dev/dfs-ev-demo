# #118 guarded evidence checkpoint

## Provisional audited invalidation (reserved 0019)

The owner allocated 0018 to #106 normalization/consumer/retention and 0019 to
#118 audited invalidation. The SQL draft remains outside the ordered migration
chain in `db/migration-drafts/`; tests apply it transactionally without recording
0019 in `db_migrations`. Relay's frozen/generated prefix remains 0001–0016.
#106's latest checked remote is `9d8fde7`, ending at 0017. Final ordered migration,
schema/contracts/readiness generation and combined integration validation wait
for its frozen prefix18. This checkpoint does not activate a persistent database.

The local store wraps seven immutable run/dataset operations. Eligible evidence
refusals roll back before a separate guarded audit attempt and remain withheld
regardless of audit success, absent installation or failure. The error exposes
the canonical failure and sanitized audit status; private exception text is never
persisted. Current rights still precede bytes. SQL certifies only conditions it
can observe; file damage/inaccessibility is a reader diagnostic. Retention hooks
append removal/expiry receipts atomically using existing authorization, without
copying the shared retention procedure or changing prior counts/digests.

Four pure cases cover payload/privacy restrictions, failure classification,
stable event identity and bounded continuation. Nine mandatory PostgreSQL cases
cover backfilled and newly sealed digest addresses, exact hash refusal, database
clocks, execute-only non-superuser access, no access grant from a diagnostic,
automatic damage/missing-file refusal after rollback, retry deduplication,
successful repair without changing the manifest, request/overflow errors not
audited, failed preparation without a partial manifest/pin, failed audit still
withheld, current rights before zero file reads, fixed-upper-ordinal pagination,
late deletion rollback, retention-only removal with surviving digest history,
concurrent retry deduplication, quota bypass for mandatory deletion, expiry at
the exact 90-day boundary and explicit `not-installed` behavior on prefix16.

Recovery copies all original synthetic predictive rows, timestamp precision,
identity-sequence progress and exact managed blob bytes to a separate registered
disposable database. Test-only replica mode is confined to a verified disposable
superuser transaction and restored before readers; production interfaces gain
no override. Original inventory/manifest hashes replay before deletion. Reapplying
the actual retention event matches legacy and supplemental counts/digests and
stable audit event hashes, permitting fresh audit recording clocks. Recreating
fixtures would not establish this: manifest hashes include their original clocks.

The focused nine-case PostgreSQL run passes. Final provisional gates pass **760
Node tests**, **75 Node DB checks + 205 PostgreSQL tests** (180 mandatory predictive
cases), all **17 catalog contracts**, typecheck and affected-file lint. The full
database gate took 331 seconds for its PostgreSQL portion. The 36 frozen/generated
prefix files match `86c141d` byte for byte; all 12 local documentation links and
whitespace checks pass. Logs use
`/private/tmp/dfs118-invalidation-final-{node,db,types,lint}.log`.
No usable real feature or label is established. Remaining #118 work is final
prefix integration, deadlines/cancellation, representative capacity and independent
review. #54 Part B retains its real-source and population qualification blockers.

## Complete fitting-run evidence checks

`readFittingRunReadiness({ version: "qb-training-read-v1", fittingRunId,
inventorySha256 })` derives every dataset assignment from the sealed inventory.
The caller cannot request a successful subset. One guard covers SQL membership,
all current protected uses, every sealed shard's byte reconstruction and final
delivery. All manifests are authorized before the first protected file. Exact
shared files are verified once within the transaction, then reverified on a later
call; the 20 MB unique-wire and 8 MB response ceilings apply to the complete read.
No numerical body is returned and no transaction remains open between requests.

The report lists every assigned dataset and its sparse global ordinals, manifest
hash, current pin state and independently reconciled counts. Unsealed datasets
remain `missing` / `dataset-not-sealed`. `datasetsComplete`, `durablyPinned` and
`usableEvidenceComplete` answer separate questions: all assignments verified,
all verified manifests actively pinned, and every requested slot having both a
usable feature and label. Missing/unavailable/expired components remain counted.
Even a fully usable fixture run keeps `fittingReady: false` and population
unqualified; #106/#107 still supply real/population qualification. Later matching
consumers cannot alter the inventory or this report's stable digest. Pin releases
change durability, while an access clock or verification metric does not change
the digest.

Damage, expired eligible evidence, revoked rights or removed inventories refuse
the entire read. There is no partial successful report for an inaccessible shard.
Every file and delivery recheck the complete run's current uses and eligibility,
including previously checked and unsealed assignments; scheduled expiry is not
stopped by DML locks. The report is ephemeral, not a durable verification grant or
invalidation event. Audited invalidation still needs a coordinated forward
migration; frozen 0001–0016 and all shared artifact interfaces remain unchanged.

Three pure cases use explicit expected counts and ordinals to check complete
assignment, missing states, durability versus usability, access-independent
digests and malformed/mismatched manifests/proofs. Three mandatory PostgreSQL
cases exercise the replay-only login, zero/partial/full shard preparation,
shared-file deduplication, later publication, pin release, wrong addresses,
damaged later shards, revocation/deletion and direct SQL writer exclusion.
Scheduled-rights expiry is tested against its recorded database boundary before
further bytes or delivery. The first focused run caught a test timestamp with
microsecond precision; the fixture now uses the contract's millisecond precision.
No production timestamp rule was changed.

Final complete-run validation passes **756 Node tests**, **75 Node DB checks +
196 PostgreSQL tests** (171 mandatory predictive cases), typecheck, affected-file
ESLint and all **17 catalog contracts**. The final gate includes all three new
database cases. The 36 frozen/generated prefix files match `986bfed` byte for
byte; documentation links and whitespace pass. Logs are
`/private/tmp/dfs118-run-readiness-final-node.log`,
`/private/tmp/dfs118-run-readiness-final-db.log`,
`/private/tmp/dfs118-run-readiness-final-types.log` and
`/private/tmp/dfs118-run-readiness-final-lint.log`. The pure fixture's reuse count
was aligned to its optional one-slot population after the full run; all 53 focused
training cases pass again. Only disposable databases were used; no persistent or
hosted database was migrated. #118 still needs audited invalidation,
deadlines/cancellation, representative capacity and independent review.

## Numerical pages and label readers

`readDatasetPage` accepts the owning run/inventory/dataset, sealed manifest hash,
cursor and `{ rows, bytes }` limits. It validates the address before protected
files, then reconstructs the entire fixed shard and conservative closure under
the existing SQL guard. Returned rows preserve sparse global ordinals and all
missing/unavailable slots. Usable feature bundles and selected label outcomes
are separate members; unusable components have no numeric payload. The page
digest fixes rows, cursor, counts and manifest identity, excluding the access
clock and verification metrics. Later matching records cannot replace the
inventory's selected IDs or change its supersession-at-snapshot metadata.

The canonical base64url cursor binds dataset, manifest, last global ordinal,
version and limits, with a corruption checksum. It is an address, not an access
capability or cryptographic authorization: a permitted caller can seek to any
valid ordinal of the same manifest, while every request rechecks current access
and bytes. No transaction or process-wide verification cache survives a page.
Each response contains at most 64 rows and is measured against its complete
canonical-byte budget (maximum 8 MB, including metadata). Overflow refuses the
whole response; it never truncates the requested population or advances a
cursor. Existing 20 MB unique-wire verification limits still apply separately.

`readCurrentLabels` takes one guarded database-clock cutoff for its entire
bounded batch. `readLabelsAt` uses an explicit non-future millisecond cutoff.
Both accept exact market/stat/version/profile scope and canonical player/game
keys, with optional exact label references. Global lineage heads are selected
before profile/version matching, so a changed-profile successor cannot revive
an old outcome. Exact wrong/future references refuse. Numeric zero with verified
positive participation remains zero; missing/unqualified final labels retain a
null outcome, `not-established` participation and `not-recorded` finalization.
These readers do not infer DNP, absence, void or sportsbook settlement from a
missing final label. Current/head supersession and historical supersession are
separate; an earlier cutoff never includes a later outcome value.

Requested scope and each selected consumer's use rights precede files, including
missing-label batches. Damage, revocation or deleted dataset closure withholds
the whole page/batch. Missing exact label references disclose
`label-reference-missing-or-removed`; a relevant source-retention event makes
unrecorded heads conservatively `retained-evidence-removed`. Those labels have
no fallback outcome. Reads do not append a durable invalidation event yet; that
belongs to the next audited-invalidation checkpoint.

Eight mandatory PostgreSQL cases cover fixed sparse page membership, later
publication, response/address bounds, corruption on retry, current rights and
deletion, inclusive historical heads, exact/future references, observed numeric
zero, provider-scope changes, frozen historical dataset labels and concurrent
direct SQL revocation/deletion. Five pure cases cover independent pagination
expectations, cursor binding, response bytes, zero/missing values and malformed
requests/ambiguous metadata. The first focused run caught synchronous limit
errors in the new asynchronous readers; all three entry points now consistently
return rejected promises on invalid input.

This increment needs no SQL migration. Frozen 0001–0016, binary artifact reads,
gzip inspection and cleanup interfaces remain unchanged. Full-shard work is
repeated per page; representative capacity/deadlines, audited invalidation and
independent review remain outstanding. Numeric access
does not make `fittingReady: false` or unqualified population disappear.

Final reader validation passes **753 Node tests**, **75 Node DB checks +
193 PostgreSQL tests** (168 mandatory predictive cases), typecheck, affected-file
ESLint and all **17 catalog contracts**. The 36 frozen/generated prefix files
match `2f57d12` byte for byte. Documentation links and whitespace checks pass.
Logs are `/private/tmp/dfs118-readers-final-node.log`,
`/private/tmp/dfs118-readers-final-db.log`,
`/private/tmp/dfs118-readers-types.log` and
`/private/tmp/dfs118-readers-final-lint.log`. Only disposable databases were used;
no persistent or hosted database was migrated.

## Dataset/pin increment

Migration 0016 adds immutable assigned manifests, independent append-only pins,
database-clock releases and conservative evidence closure. `prepareDataset`
verifies the saved shard then asks SQL to compute the manifest, associations and
quota charge. It verifies every closure file before committing. `pinDataset`
requires an existing manifest and repeats protected verification; it cannot
create an unassigned dataset. `readDatasetManifest` verifies files on every call.
Direct SQL can establish/check metadata, but never certify private filesystem
bytes; manifests require verification on every access and remain `fittingReady:
false`, population unqualified. SQL accepts no supplied rows or byte certificate.

The closure includes selected consumers and label ancestors, complete conservative
binding/decision history, native context, captures, raw rows/revisions, identity
links, rights, ingestion runs and exact blob addresses. It is bounded at the
original inventory snapshot. Protected uses also include ancestor providers when
label corrections change scope. Fresh rights checks precede closure reads and
delivery, and mandatory deletion of an ancestor provider erases the affected
dataset and corrected descendants. Each dataset charges complete distinct blob bytes
plus canonical manifest bytes. Shared blobs are charged to each dataset; multiple
pins on one dataset are charged once. Quotas are 32 active datasets, 256 MiB per
dataset and 1 GiB total, with 1,024 lifetime pins per dataset. Initial safety
ceilings are not benchmarked capacity.

Active pins preserve eligible source features beyond day 90 under current rights.
Later inventories explicitly record which features were pinned at their clock.
Releasing the last independent pin restores expiry at the original recording
time; preparation/re-pinning cannot resurrect an already-expired feature. Rights
revocation still refuses before protected bytes, and release remains available
after revocation. Mandatory deletion erases dataset/pin closure even for narrow
source scopes. Unprotected expired shards can be removed without blocking an
unrelated active shard of the same inventory.

The forward migration installs literal, checksum-guarded extension seams into
the known retention/prepare functions, without copying the multi-ledger
procedure. Any unexpected prefix refuses. Authorized per-dataset hooks compose
with existing inventory deletion and add deterministic supplemental audits;
restore/reapply includes them. Legacy events unaffected by datasets retain their
exact old result. This deliberate seam requires #115 coordination before future
retention decomposition. Existing 0001–0015 SQL/contracts remain unchanged.

Thirteen mandatory database cases cover restricted roles, exact A despite newer B,
missing slots, immutable retries, closure charging, independent release, corrupt
files before/after sealing, failure after the SQL insert, rights expiry during
that late read, concurrent SQL writers/preparations, the exact 90-day boundary,
pin eligibility in later inventories, expiry of an unpinned sibling, quota
rollback, deletion rollback, restored supplemental audit, ancestor-provider
rights/deletion and v15 upgrade/no-op preservation. The future-clock test recompiles access/expiry functions only in a
disposable superuser database; it never backdates evidence and installs no
production clock override. Two pure tests cover exact pin requests and the
independently authorized pin exception to unchanged expiry.

The first complete database run passed all thirteen new cases and 184 of 185
PostgreSQL tests. An existing revocation fixture used a host timestamp after a
sleep; Docker's clock can trail that clock by 1–2 ms, leaving the revocation
temporarily in the future. The fixture now takes its timestamp from the database
and asserts it is later than the historical binding. Its focused regression
passes; no production clock or rights rule was relaxed.

Final checkpoint validation passes **748 Node tests**, **75 Node DB checks +
185 PostgreSQL tests** (160 mandatory predictive cases), typecheck, affected-file
ESLint, migration/readiness checks and all **17 catalog contracts**. Frozen
0001–0015 SQL/contracts, the ledger contract and the existing manifest prefix
match `84945bf`; schema changes are appended. Documentation links and whitespace
checks pass. Logs are `/private/tmp/dfs118-datasets-final-node.log` and
`/private/tmp/dfs118-datasets-final-db.log`. No persistent or hosted database was
migrated. The complete next prefix is 0001–0016; 0017 only is reserved for #106.

Stable numerical paging, complete-run readiness, label APIs, audited
invalidation, end-to-end deadlines and representative capacity remain open.
This increment does not complete #118 or qualify #106/#107 evidence for #54.

## Assigned-shard verification increment

`verifyDatasetShard({ version: "qb-training-read-v1", fittingRunId,
inventorySha256, datasetId })` verifies the exact shard already assigned in a
database-created inventory. It validates the saved body/request hash and slot
ordinals, then reconstructs the assigned kickoff and fixed consumer evidence.
It never reruns latest-match selection. The result preserves global ordinals,
missing/unavailable/expired/usable states, original history/version identity and
label supersession at the inventory snapshot. Later labels do not replace the
selected historical label or disclose future values.

Every protected inventory use and selected kickoff/consumer profile passes fresh
rights before files open, before each unique file and at delivery. Unpinned
features becoming 90 days old after inventory preparation refuse at the exact
boundary. Already-expired slots remain explicit. Table guards block direct SQL
rights writes and mandatory retention during verification; scheduled rights
expiry still stops subsequent access/delivery. Each retry verifies the files
again; a previous successful proof cannot authorize damaged bytes.

The proof contains metadata, per-partition counts, a stable selection hash and a
clock-bound proof hash. It is `verified-only`, `fittingReady: false`, population
unqualified. It creates no dataset or pin and returns no numerical bodies.
Future sealing must perform verification in the recording transaction rather
than accept this proof from a caller. Shared `readWireBytes`, compressed inspection
and cleanup interfaces from integrated #106 `4f1ad06` remain unchanged. No DDL
is added; frozen 0001–0015 remain fixed, with 0016 reserved for dataset/pin DDL.

Six mandatory PostgreSQL cases use restricted logins, actual files and concurrent
SQL to test fixed A despite newer B, explicit missing shards, identity refusal
before files, damaged context/consumer retry, historical labels, input detachment,
direct-writer/deletion exclusion and scheduled expiry during paused file I/O.
Four pure cases check exact request fields and the hand-computed 90-day boundary
across October/November/December into January. These tests assert independent
expected IDs/states/counts and mutate real files/rights, not only output hashes.

Durable manifests, atomic evidence pins, stable paging/current-label reads,
release/quotas, expiry/invalidation, recovery, deadlines and representative
capacity evidence remain open. Qualified compressed publication and full
compressed-consumer reconstruction remain #106 work. #106, #107 and #118 still
gate validated #54 Part B.

Final shard checkpoint passes **746 Node tests**, **75 Node DB checks + 172
PostgreSQL tests** (147 mandatory predictive cases), typecheck, affected-file
ESLint, migration/readiness checks and the full gate's 16 catalog contracts.
The initial focused run caught an expected-count assertion that omitted the
empty evaluation partition; the full gate includes the corrected assertion.
Typecheck also prompted narrowing the expiry helper's input type instead of
casting partial fixtures to complete SQL inventories. Frozen 0001–0015 SQL,
catalog contracts and generated manifests are unchanged from `4f1ad06`.
Logs are `/private/tmp/dfs118-shards-node.log` and
`/private/tmp/dfs118-shards-db.log`. No persistent/hosted database was migrated.

The 0016 retention design must exclude actively pinned source features during
expiry selection. A foreign key that merely aborts the entire sweep is
insufficient. Mandatory deletion must remove dataset/pin closure before parent
run inventory, preserve unaffected legacy counts/digests and compare the
supplemental training audit on restore/reapply. The existing 0014 authorization
hook operates after 0010 has selected expiry candidates; that hook alone cannot
implement expiry protection. Keep this distinction explicit in the forward
migration and coordinate any procedure decomposition with #115.

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
