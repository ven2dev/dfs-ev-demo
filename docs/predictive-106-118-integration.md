# #106 / #118 integration prefix — 2026-10-14

#118 integrates #106's frozen `dae2940` checkpoint with its `a6da525` audited
invalidation implementation on `feature/dfsEV-118-training-reads-retention`.
The combined frozen ordered prefix is **0001–0019**. #106's 0001–0018 SQL and catalog
contracts remain byte-for-byte unchanged; 0019 is #118's only addition. Qualified
compressed publication, binding/consumer reconstruction and dataset closure are
fixture-backed. Combined final validation is recorded at the end of this document.
Neither session has published a usable real feature or label.

## Fixed integration prefix

Use the ordered **0001–0019** prefix in [migration-manifest.json](../db/migration-manifest.json).
Released 0001–0011 and #106's frozen 0012–0018 remain byte-for-byte unchanged.
For branch integration, keep #118's 0012 fixed:

```text
0012_predictive_training_read_guard.sql
sha256 52dbb7400c93d9eb231fa210a4cce859e425ba7f836841ba5743c978efcf2fc3
```

0012 adds two source-consumer lookup indexes and the role-checked training read
guard. It adds no tables, byte encodings, publication format or retention
procedure replacement. It has run only in disposable local databases; it is
not merged to main or activated in a persistent/hosted database. Future changes
to this shared prefix use forward migrations.

**0016 belongs to #118 dataset/pin DDL**, as authorized by the owner after
#106 confirmed its complete prefix through 0015. The owner then confirmed
**0016 is #118's complete integrated range; #106 owns 0017 qualified compressed
publication and the owner subsequently allocated 0018 to #106 normalization,
consumer evidence and retention integration, followed by 0019 to #118 audited
invalidation.** #106 published the frozen 0001–0018 checkpoint at `dae2940`;
Relay now finalizes 0019 against that prefix. Neither session should reserve
a further range silently. Integrate by merge after preserving local work; do not rebase or
cherry-pick duplicate copies of the prefix. Keep #106's binary artifact
implementation when resolving shared files. Regenerate migration/catalog/
readiness artifacts for the combined prefix and validate the final integrated
SHA before merging either PR. These additions have run only in disposable local
databases.

## Shared interfaces

| Surface | #118 change / #106 integration requirement |
| --- | --- |
| `artifacts.ts` | #106's binary addition is integrated: `readBinary`/`writeBinary` preserve exact gzip wire bytes. `read(reference, sha256, byteSize)` remains a UTF-8 JSON/CSV reader. Never route compressed bytes through it. |
| `persistence.ts: readBytes` / `readWireBytes` | Separate private text and binary wrappers cache by exact reference/hash/size within the guarded transaction, charge unique stored bytes and check fresh access before opening a file. Keep compressed bytes out of the text reader. |
| CSV verification | Shared exact-file reads and parsing, then exact stored-row/projection comparison and full normalization/witness/decision/calculation reproduction. Wire hash/size must verify before decompression; decoded content cannot replace the wire identity. |
| `batchEvidence.ts` | New transaction-local metadata-query and verification-promise reuse. Keep binary payloads outside the JSON metadata dispatcher. Decoder cache keys must distinguish wire reference, encoding, feed and parser version as applicable. |
| `replaySourceConsumers(ids)` | New local evidence primitive: at most 64 references; returns snapshot time, ordered verified records/nulls and verification metrics. It does not seal training datasets or pins. Gzip must work through its full reconstruction path. |
| Run preparation | `prepareFittingRun(request)` fixes the entire inventory and SQL-selected IDs; `readFittingRun(id)` reads its metadata with fresh rights. Neither opens files, seals a verified dataset or creates pins. |
| Assigned shard verification | `verifyDatasetShard({ version, fittingRunId, inventorySha256, datasetId })` checks only the inventory's assigned membership, kickoff evidence and selected consumers under guard. Its metadata proof is ephemeral; it creates no manifest/pin and is not a SQL recording certificate. |
| Dataset/pin API | `prepareDataset({ version, fittingRunId, inventorySha256, datasetId, pinId })`, `readDatasetManifest(id)`, `pinDataset(request)` and `releaseDatasetPin(id)` seal/read immutable metadata, create independent pins and append releases. Preparation/pinning verify exact assigned evidence plus closure files inside the recording transaction. No numerical pages or fitting readiness are returned. |
| Retention APIs | `retain` and `retentionEvents` may return optional `trainingRetention: { removedCounts, removedIdsDigest }`; `reapply` compares it too. Legacy counts/digest remain separate. `resumeBlobRemovals` and `sweepOrphanBlobs` signatures are unchanged. Preserve execute-only APIs, exact addresses including `.csv.gz`, digest locks, queued acknowledgement, rollback cleanup and aged-temp recovery. |

## Rights, locks and budgets

The guarded batch takes SHARE table locks in READ COMMITTED before its clock and
record selection. Every selected consumer passes SQL current use rights and
association checks before any file opens. Fresh uncached checks run before each
unique file and before delivery. Cached/historical approval does not authorize
a gzip read now. The ordinary single-record reader retains its existing
repeatable-read path; it does not gain this batch guard automatically.

Publication/cleanup take digest locks before database writes/reference checks.
The guarded reader does not acquire digest locks after table locks: stable
committed blob references keep cleanup from unlinking its evidence. If #106
adds evidence tables or associations, extend the guard in a forward migration.

Current unique verified stored-byte ceiling is 20,000,000 per transaction; the
current filesystem file cap is configurable up to 8,000,000. These text-source
limits do not establish gzip capacity. For gzip, explicitly distinguish wire
hash/size and stored-byte quotas from decoded-output bytes, CSV parsing work,
rows/record sizes and cancellation/time limits. Stop bounded decompression before
unbounded allocation; measure the selected multi-season slice before changing
limits. Do not charge compressed size as decoded work or decoded size as storage.
Training verification now also reports actual transaction-local `decodedBytes`,
`decodedRows` and `peakWorkerRssBytes`. These operational counters remain outside
immutable evidence/page/readiness digests. `verifiedBytes` continues to charge
unique stored wire bytes. See [capacity measurements](predictive-training-capacity.md)
for the current limit: a 16-QB/two-profile case hit SQL/read deadlines before any
bytes opened. The counters and benchmark add no DDL; 0001–0019 remains frozen,
with no later number allocated. #106 should retain explicit interruption recovery
and independently review deadline behavior before adopting the readers.

SQL gzip publication must update blob/removal address constraints and the
role-checked reference guard, CSV media predicates and receipt-clock handling.
In particular, 0011's synthetic exception recognizes only `text/csv` with the
qualification parser: a gzip fixture must not accidentally regain caller-chosen
ingestion time. No frozen migration is edited to add that support.

Existing v1 target-relative three-season schedule coverage, at most 16 numerical
history slots, cutoff rules and absence policy remain binding. Neither checkpoint
has published a usable real feature or label. The initial guarded checkpoint
passed 700 Node tests, 75 Node DB checks and 142 PostgreSQL tests plus
typecheck/lint; those historical counts precede #106's binary integration.
Focus compressed-publication validation on denied
rights before wire reads, damaged/truncated gzip, independent wire/decoded caps,
full consumer reproduction and exact `.csv.gz` rollback/retention/resume/orphan
cleanup before the final integrated gates.

## #106 integration checkpoint: compressed staging

#106 merged the fixed handoff commit `42de9fb` and preserved its binary artifact
implementation. Its next prefix is **0001–0013**, with 0001–0012 unchanged:

```text
0013_predictive_compressed_blob_staging.sql
sha256 b681598ddf0285905041b4120d2ee133306eda5c456377599130969284181813
```

0013 admits `application/gzip` only at the exact wire-hash `.csv.gz` address,
extends the removal queue/reference guard and preserves the existing execute-only
role/isolation/digest-lock contract. Receipt stamping covers every gzip parser,
including synthetic unknown parsers. A new capture guard refuses published
gzip, and the canonical link guard refuses gzip under every profile/parser.
The existing CSV claim check also refuses raw claims on compressed captures.
The complete prefix is represented in generated catalog, migration and readiness
artifacts. It has run only in disposable scratch databases.

This is a staging/storage checkpoint. It adds no codec proof table, runtime
compressed publisher, binary evidence cache or training reader. Existing CSV
predicates intentionally remain text-only until a later forward migration and
reader verify a complete compressed source envelope. The `readBytes` rights gate
must still be extended before any guarded batch opens gzip. Wire/storage quotas
remain separate from the proposed decoded-work budgets; no capacity change or
usable output is established by 0013.

The four new mandatory database cases cover database receipt stamping,
published/raw/canonical bypass refusal, unknown synthetic parsers, exact-address
orphan and interrupted-retention recovery through non-superuser roles, and
v12-to-v13 evidence/ledger preservation with no-op reruns. Runtime rollback
cleanup recognizes the gzip suffix, but compressed publication rollback and
restored-backup parity still need coverage when a runtime writer is introduced.
That checkpoint reserved no later number. The subsequent #118 allocation below
uses 0014 after the owner supplied #106's complete prefix.

Combined local checkpoint checks pass: 730 Node tests, 75 Node database checks
and all 146 PostgreSQL tests, including the mandatory 121 predictive cases.
Typecheck, lint, catalog/migration/readiness artifacts and whitespace checks pass.
The first full database run exposed a stale twelve-entry bootstrap ledger
expectation; after adding the explicit thirteenth entry, the complete mandatory
gate passed. The disposable service was removed. These results validate staging
and the integrated existing readers, not a future compressed publication path.

## #106 complete-file preparation continuation

#106 integrated Relay's `da24ab9` checkpoint and added pure complete-file player/
team claim preparation for the proposed 2025/2026 compressed scope. The existing
text projector stays 2026-only. Full-file ordinals include refused rows; no claims
return before gzip CRC, header, UTF-8 and work-budget verification. The complete
retained 2025 player file has independent Python parity for every prepared claim,
including 22 explicit player-ID refusals. Details and memory measurements are in
the [compressed-source contract](predictive-compressed-source-contract.md).

No migration was allocated or schema changed by this continuation. **0014 stays
with #118.** #106's SQL envelope/guarded binary activation will use **0015 or
later**, coordinated here after Relay publishes its fixed 0014 prefix and
deletion interfaces. The new preparation API is not connected to the current
writer or batch reader. The process memory ceiling is still a prerequisite.
Combined checks pass: 742 Node tests, 75 DB checks, 151 PostgreSQL tests,
typecheck, lint and generated-artifact/whitespace checks.

## #118 integration checkpoint: immutable run inventory

```text
0014_predictive_training_run_inventory.sql
sha256 5a1d4d4d7c8d1f8dd0caa0faea942e26a127fcb024bcd6c627602afeaaca6239
```

0014 prepares complete run metadata in one execute-only SQL call. It reserves
run/plan/fold identity, resolves cutoff-visible kickoff evidence and fixes exact
feature/label IDs or missing states for every assigned shard. Repeating the same
request returns the original snapshot; newer consumers do not replace its
selections. SQL independently enforces the approved version/history matrix,
clocks, target-event exclusion across partitions, duplicate targets across
shards and immutable split/model policy. Fixed-holdout event reuse within a plan
refuses; walk-forward reuse records correlated event/player-target counts.

The public training guard keeps its signature and now also protects the new
inventory/audit tables. Its previous evidence guard is private. Run preparation
holds the existing global publication/retention advisory lock before the guard;
replay takes the guard without digest locks. Both require READ COMMITTED.
Preparation requires recorder and replay membership; inventory reads require
replay membership. Neither role receives direct table access.

A transaction-authorization hook composes pending-inventory deletion with the
existing retention procedure; it does not introduce a seventh procedure copy.
Named protected profiles conservatively erase the entire pending inventory,
including missing selections, even for a narrow capture interval. Feature expiry
also erases inventories citing expired source features. Removed request/slot/
profile/event identifiers are not retained in digest-only audit. Digest-only run,
plan and fold identities remain to refuse reuse of erased history. A supplemental
`trainingRetention` audit preserves legacy counts/digest and is compared on
restoration/reapplication. #115 must preserve this transactional hook/authorization
boundary in any retention refactor.

This is metadata preparation, not dataset sealing. `inventory-sealed` always
carries `fittingReady: false` and unqualified population. No bytes are opened,
numeric values delivered or pins created. Limits are 32 pending inventories,
1,024 slots/run, 256/shard, 32 shards, 16 protected profiles and an 8 MB inventory
body; these are enforced ceilings, not capacity measurements. Next #118 work
must reproduce each assigned shard's fixed selections under guarded rights,
seal immutable dataset manifests and atomically pin their evidence closure.
Qualified gzip publication/binary verification remains #106 work and must
retain the wire-versus-decoded budget distinction above.
The profile ceiling counts context outside the selected feed scope and missing
consumers; a 16-feed request with a seventeenth kickoff profile refuses.

The combined inventory checkpoint passes 736 Node tests, 75 Node DB checks and
158 PostgreSQL tests (133 mandatory predictive cases), typecheck, affected-file
lint, generated artifacts, frozen-prefix and documentation/whitespace checks.
Only disposable databases ran 0014. This checkpoint does not establish gzip
publication, durable training retention or a usable real QB slice.

## #106 codec-inspection envelope and guarded wire checkpoint

#106 merged Relay's `493e9ad` fixed inventory checkpoint, preserving both handoff
sections. Its next prefix is **0001–0015**; 0001–0014 stay byte-for-byte unchanged:

```text
0015_predictive_compressed_inspections.sql
sha256 ab77314b75baddb7793c6c9a1dfe472c4cb9d74b203e8e8403f111158514e255
```

0015 stores one immutable inspection envelope per incomplete capture. An
execute-only ingest API binds its wire identity/size, feed, declared season,
header, complete parsing flags and record count to that capture, stamps database
recording time and checks current/historical research rights. It requires the
existing digest session lock. SQL validates metadata shape; it cannot prove
gzip CRC or decoded hashes from private filesystem bytes. The reader must
reproduce the complete envelope even if SQL accepted well-shaped forged metadata.

The public training guard now wraps the unchanged private inventory guard and
also locks the inspection table. `replayCompressedInspections(ids, options)` is a
local, guarded codec-diagnostic API, not a source consumer or dataset reader. It
uses a separate binary `readWireBytes` cache, checks current rights before each
unique wire file and at delivery, and reproduces hashes/CSV ordinals/record counts.
Transaction-local wire accounting retains the existing 20 MB ceiling. Decoded
work is charged separately, at most 64 MB/160,000 records per diagnostic batch,
with optional downward-only limits. Cache keys include exact wire identity,
feed, season and codec version. Nothing is delivered when any selected envelope,
file, quota or current-rights check fails.

A role-checked BEFORE capture-deletion hook removes the envelope under the
existing transaction authorization. It composes with 0014's pending-inventory
hook without replacing a retention procedure or introducing CASCADE. Capture
tombstones already audit the envelope's sole capture identity; no new independent
retention identity is created. Private helper functions/tables remain unavailable
to replay/ingest callers except through their granted execute-only interfaces.

Eight mandatory PostgreSQL cases cover restricted recorder/reader privileges,
exact replay and within-transaction reuse, rights before corrupt bytes, valid-wire
CRC failure, forged decoded identity, independent decoded/row budgets, concurrent
rights-write blocking, scheduled expiry at delivery, authorized deletion and
fixed-v14 upgrade/no-op preservation. The existing inventory upgrade tests also
run through 0015. This prefix has only run in disposable databases.

0013 still rejects published gzip. This checkpoint adds no qualified raw claim
writer, full consumer reconstruction, dataset sealing or fitting readiness. The
proposed process RSS ceiling remains unenforced; this inspection API is confined
to the local research proof. Production/consumer activation still needs that
ceiling, qualified source/profile/claim checks and compressed restoration tests.
At this historical checkpoint no later migration was allocated. The owner's
subsequent allocation reserves 0016 for #118 and 0017 or later for #106, subject
to coordination before further DDL.

Combined checks pass: 742 Node tests, 75 Node DB checks and all 166 PostgreSQL
tests (141 mandatory predictive cases), typecheck, lint and generated catalog/
migration/readiness/whitespace checks. The bootstrap inventory was extended for
the new table. An existing host/database-clock routing fixture was repaired with
explicit database-clock ordering and passed six isolated repetitions plus the
complete gate. The disposable test service was removed; no hosted DB ran 0015.

## #106 isolated worker continuation

#106 now has an opt-in, local Docker codec worker with a pinned Node image,
kernel-enforced 256 MiB memory allowance, no swap/network, read-only code and no
daemon logging of private payloads. The child verifies its cgroup limits. Input
and request are detached; one active job is admitted per controller, with bounded
execution/output and verified removal before reuse. The existing SQL prefix is
still **0001–0015**. **0016 stays with #118**; this continuation allocates no DDL.

746 Node tests and eight container tests pass, plus typecheck/lint/whitespace.
Native allocation stress was OOM-killed, an 80,000-row resource/output refusal
recovered, and the real 19,422-row file reproduced its independent claim digest
inside the worker (143,142,912-byte peak RSS). Full configuration, cleanup and
validation boundaries are in the [compressed-source contract](predictive-compressed-source-contract.md).

This worker is not yet connected to 0015's guarded reader or a compressed source
writer. Next: integrate it while preserving current-rights gates, downscaled
decoded-work budgets, guard lifetimes and failure cleanup; then qualify full
compressed publication and consumer reconstruction. Coordinate any #106 DDL
at 0017 or later after #118 supplies its fixed dataset/pin prefix.

## #106 guarded worker integration

`replayCompressedInspections` now performs complete-file inspection through the
isolated worker. Its existing guarded transaction still rechecks rights before
opening each unique wire artifact and again before delivery; table guards span
worker execution and cleanup. The compressed path has a 45-second transaction
idle timeout to accommodate the 30-second worker deadline and bounded cleanup.
Wire accounting stays separate from decoded bytes and rows, with each worker
receiving only the remaining downward-bounded batch allowance. Persisted envelope
comparison remains exact after normalizing these temporary work limits.

The database test harness pulls the exact pinned image and requires all nine
container checks before its database suites. Runtime readers never pull images;
missing runtimes/images refuse the read. This integrates diagnostic replay only:
qualified compressed publication, consumer reconstruction and usable real
features/labels remain outstanding. No migration changed; 0016 remains reserved
for #118 and further #106 DDL still requires coordination here.

Validation passes: 746 Node tests, nine Docker worker checks, 75 Node database
checks and 166 PostgreSQL tests, including all 141 mandatory predictive cases.
Typecheck, affected-file lint, catalog/migration/readiness and whitespace checks
pass. The disposable database service was removed after the gate.
## #118 assigned-shard verification continuation

#118 fast-forwarded to #106's `4f1ad06`, preserving frozen 0001–0015 and both
stores' APIs. `verifyDatasetShard` reads the saved inventory, validates its hash
and exact shard assignment, and verifies only its fixed feature/label IDs.
There is no latest-match reselection. Missing/unavailable/expired slots, original
global ordinals, history/version identity and supersession at the inventory clock
remain unchanged. Kickoff verification shares the preview's cutoff-visible
schedule/alias/reconciliation implementation.

All inventory protected uses and selected context/consumer profiles pass current
rights before files open, before each unique file and at delivery. A selected
feature that newly crosses its unpinned 90-day boundary refuses. Concurrent direct
SQL rights changes and mandatory retention wait for the guard. Scheduled rights
expiry can still refuse a paused read. Retries verify actual files again.

The result is metadata only: `verified-only`, `fittingReady: false`, population
unqualified, stable selection identity and a clock-bound proof hash. No durable
manifest or pin is created; no numeric feature/outcome body is returned. Future
sealing must invoke verification within its recording transaction and must never
trust a caller-supplied proof. The shared wire/inspection APIs and exact-address
cleanup interfaces are unchanged. This continuation allocates no migration.

Validation passes 746 Node tests, 75 Node DB checks and 172 PostgreSQL tests
(147 mandatory predictive cases), typecheck, affected-file lint, migration/
readiness checks and all 16 catalog contracts in the complete DB gate. Frozen
0001–0015 SQL/catalog and generated manifests match `4f1ad06`. No persistent or
hosted database was migrated. Dataset/pin DDL remains unimplemented and reserved
at 0016; this is not #118 completion or fitting authorization.

## #106 guarded claim reconstruction continuation

#106 integrated #118's assigned-shard checkpoint `84945bf`, retaining the
isolated worker, `verifyDatasetShard`, frozen 0001–0015 and both handoff sections.
`replayCompressedClaims` now reconstructs complete player/team raw claims through
the same guarded inspection-envelope path. It compares the full regenerated
codec proof, preserves every row ordinal/refusal, binds row IDs to each capture,
and rechecks research rights before wire access and final delivery. No stored raw
claim, normalized fact, feature or label is created. Roster files cannot become
numeric claims through this API.

Wire bytes remain deduplicated within the transaction. Claims must be regenerated
for each capture identity, so decoded-work accounting charges each reconstruction
even when two captures share one wire file. Temporary worker limits use the
remaining decoded-byte/row allowance. Inspection-only replay retains its prior
deduplication and return shape. Failed integrity, budgets, rights or retention
checks deliver no partial claim batch.

The new mandatory database cases cover complete ordinals and explicit refusals,
capture-specific identities through a replay-only login, no raw-claim activation,
wire/work accounting, budget refusal/recovery, forged decoded selection identity,
CRC damage, pre-read revocation, retention erasure, concurrent rights writes and
scheduled expiry after reconstruction. Further #106 DDL still needs coordination
at 0017 or later; 0016 remains with #118. Real-source qualification and explicit
2025 Week 18 participation/absence remain unresolved.

Combined validation passes: 750 Node tests, nine container checks, 75 Node DB
checks and 175 PostgreSQL tests (150 mandatory predictive cases), typecheck,
full lint, catalog/migration/readiness and whitespace checks. The complete gate
includes Relay's assigned-shard verification and the worker-backed inspection
and claim readers. Disposable database cleanup completed.

## #106 publication preparation and next migration dependency

`prepareCompressedPublication` now prepares a detached candidate through the
isolated worker. The new parser/profile contract is
`nflverse-gzip-csv-source-qualification-v1`; its publication request identity uses
`nflverse-gzip-csv-source-claims-v1`. Only complete player/team season assets for
2025 or 2026 qualify for this preparation interface. Feed, exact asset URL/name,
release tag, header digest, selected evidence kind, scope and wire identity must
agree. Legacy CSV qualification remains 2026-only and unchanged.

Historical and preparation-clock research rights must both allow the use.
Future capture, release metadata or registration knowledge refuses. The complete
worker output binds each ordinal and capture ID; no caller-supplied decoded proof
or projected rows enter this API. The result remains `prepared-only` with all
publication/features/labels flags false. Caller-provided rights and a preparation
clock cannot authorize a database write; the writer must validate authoritative
registrations and fresh rights under its publication locks.

**Proposed next #106 allocation: 0017 only, for raw compressed publication.**
This is pending Relay confirmation that its next complete range is 0016 and a
frozen 0001–0016 checkpoint. It is not an applied migration or a reservation of
later numbers. Keep coordination in this chat. No change to #118's DDL is made.

The publication increment must:

- Permit published gzip only for the exact new profile and a complete, immutable
  codec/publication envelope. Existing incomplete diagnostics remain valid;
  unknown/synthetic parser names still cannot bypass qualification or clocks.
- Admit up to 80,000 raw-stat ordinals only for the qualified gzip profile;
  preserve legacy 8,192-row and 2026 scope checks. Generalizing projection shape
  must retain capture/profile-specific season enforcement and refused rows.
- Insert wire artifact, published capture, complete raw claims, codec metadata,
  publication seal and rights audit atomically, with database-clock ingestion.
  Never promote an existing immutable incomplete capture by updating it.
- Verify the stored complete raw claims against regenerated worker output on
  replay, including the publication digest, and preserve separate wire/decode
  accounting, fresh rights gates and exact-address rollback/retention handling.
- Keep canonical observation bypasses prohibited. Raw publication does not
  activate normalization, numerical consumers, training or a fitting-ready flag.
- Pass direct-SQL forgery/profile/coverage probes, restricted-role publication,
  blob/profile lock races, rights expiry/revocation, rollback, authorized deletion,
  restored reapply and fixed-prefix upgrade/no-op tests before freezing 0017.

Consumer/normalization activation remains a later separately coordinated
increment. The missing real participation/absence and other source qualification
requirements remain unchanged. Creator A–C scope changes do not alter #106's
v1 multi-season history policy.

Preparation validation passes 755 Node tests, all 11 real worker checks,
typecheck, full lint and whitespace checks. No database path or schema changed;
the last complete schema-15 database gate remains 75 Node DB checks and 175
PostgreSQL tests. Relay's 0016 is currently an uncommitted dataset implementation,
so SQL publication activation awaits its frozen checkpoint and range confirmation.
## #118 dataset and durable-pin checkpoint

```text
0016_predictive_training_datasets.sql
sha256 fd0e99ae3b3cc5f2dedb019d6d35fe3fe41d27b960179a91599496f8b0492883
```

0016 independently constructs each manifest from the owning SQL inventory. It
fixes assigned global ordinals/states, consumer manifests, clocks, history/model/
split/population identities, partition counts and the conservative replay graph.
Closure includes label ancestors, binding/revision/decision history, native
observations/captures, identity links, rights, ingestion runs and exact blob
references. No caller-supplied rows or verification proof is accepted. The adapter
verifies the fixed shard before SQL recording and every additional closure file
before commit. Failure, current rights expiry or damage rolls back manifests,
pins and identity reservations together. Every later manifest read reverifies.
Protected uses follow the full lineage, including an ancestor label's provider
when a correction changes provider scope. Current rights for those profiles are
checked before their bytes and before delivery; deletion of that ancestor's
provider removes the affected dataset and corrected descendants.

Pins/release events use execute-only functions and database clocks. Additional
pins reserve the same dataset once; last release restores the feature's original
90-day expiry without a renewed lease. Active valid pins preserve feature
eligibility in later inventories through the optional `pinEligibility` member;
historical inventories without that member remain unchanged. Expired selections
cannot be resurrected by preparation/re-pinning. Quotas are 32 active datasets,
256 MiB charged closure per dataset, 1 GiB total and 1,024 lifetime pins per
dataset. Full blobs plus canonical manifest bytes are charged, including shared
bytes separately across datasets. These are enforced ceilings, not capacity proof.

Preparation/pinning acquire the existing global publication/retention lock
before the table guard. Read-only adapters take only the guard. No blob digest
lock is acquired after table locks. The same `readBytes`/`readWireBytes` gates,
wire quota and exact-address cleanup remain unchanged; 0016 does not activate
compressed publication or claim decoded verification for future consumers.

Three checksum-guarded, literal extension seams amend the exact reviewed 0010
retention expiry predicate and 0014 inventory expiry/preparation predicates.
Unexpected function bodies refuse migration. This avoids another complete
retention-procedure copy, preserves unrelated code/grants/audit, and makes pin
eligibility explicit during candidate selection. #115 must preserve/replace
these seams in its ledger decomposition. Per-dataset authorized deletion hooks
remove pin/release/consumer closure before a parent run is deleted. An expired
unprotected shard can be removed while a different pinned shard remains; this
does not make that incomplete run ready. Mandatory source deletion still erases
the full affected run, including missing slots and narrow scopes. Dataset audit
is supplemental; unaffected legacy/training audit results retain exact parity.

This is metadata sealing and retention. `sealed` still carries `fittingReady:
false` and unqualified population. Stable numerical paging, current/historical
label APIs, complete-run readiness, audited invalidation, deadlines and capacity
evidence remain #118 work. No migration after 0016 is reserved by #118. #106 owns
0017 only for qualified compressed publication against this complete prefix;
any further number requires coordination. Do not renumber/edit
0001–0016 after accepting this handoff.

Final checkpoint validation: 748 Node tests, 75 Node DB checks, 185 PostgreSQL
tests (160 mandatory predictive cases), typecheck, affected-file lint and all 17
catalog contracts pass. Frozen 0001–0015 and their contracts/ledger remain
unchanged from `84945bf`. Only disposable databases ran 0016. The evidence
checkpoint records the corrected host/database-clock test fixture and log paths.


## #106 accepted frozen schema-16 base (2026-10-14)

The owner relayed #118's confirmation: 0016 is its complete next migration
range, and **0017 only is reserved for #106**. Relay's frozen checkpoint
`2f57d12` is integrated at `379a095`. Its 0016 SHA-256 matches the recorded
`fd0e99ae3b3cc5f2dedb019d6d35fe3fe41d27b960179a91599496f8b0492883`.
The shared prefix is now **0001–0016**; no migration in that prefix was edited.
This supersedes the earlier pending-prefix statements above.

The only merge conflict was the handoff document; both sessions' sections were
retained. Assigned-shard/dataset/pin behavior and #106's binary, worker,
inspection, complete-claim and publication-preparation interfaces are preserved.
Combined validation passes 757 Node tests, all 11 real worker checks, 75 Node DB
checks, 188 PostgreSQL tests (163 mandatory predictive cases), all 17 catalog
contracts, typecheck, full lint and whitespace checks. The disposable database
was removed after the gate. No hosted database was migrated.

The allocation/base dependency is resolved. The next implementation remains
0017's qualified raw compressed publication and independently verified replay,
following the publication requirements above. It is not implemented or activated
by this integration checkpoint. Canonical/consumer activation, usable real
features/labels and source-evidence qualifications remain outstanding. Any
migration after 0017 requires coordination in this chat.

## #106 qualified raw compressed publication (0017)

```text
0017_predictive_compressed_publications.sql
sha256 5c7dbaec1bc41924c9539a7e65034a6c50a27a0c1a7c95d922b361c372f53305
```

0017 adds execute-only qualified publication and replay against frozen
0001–0016. `publishCompressedSource(bytes, input)` copies input before waiting,
holds the existing digest lock before the global publication lock, and acquires
the shared guard's table sequence in writer mode before registration or worker
execution. It validates the authoritative rights chain before decoding, writes
and rereads exact managed wire bytes, and commits ingestion run, artifact,
published capture, codec envelope, complete claim seal and historical rights audit
atomically. Receipt/seal clocks come from PostgreSQL. Retry rechecks rights,
actual managed bytes and regenerated claims rather than trusting the old seal.

Complete claims live in the private `predictive_compressed_publications` JSON
seal, bounded to 80,000 records and 64 MB serialized claims. Every ordinal,
capture-specific row ID, raw key, projection year/feed and explicit refusal is
checked. The seal includes the versioned request identity and canonical complete-
claim digest. This avoids widening legacy `predictive_source_stats_rows` or its
2026 projection checks. Ingestion counts above 8,192 are allowed only for the new
producer version with a deferred, complete qualified-capture/seal check.

`replayPublishedCompressedClaims` verifies the stored seal and independently
reconstructs full claims from exact wire bytes under the guard. Wire and decode
budgets remain separate; each capture's reconstruction is charged. Current and
historical research rights are checked before bytes and delivery. Scheduled
rights expiry also refuses during SQL sealing and at deferred commit. Matching
executed source-deletion scopes prohibit archive reimport; diagnostic envelope
record/read wrappers use the same scope authorization, preserving v15's original
checks behind private functions. A literal checked function-label adaptation
keeps the renamed v15 recorder's parameter reference correct.

Authorized capture deletion removes the seal and codec metadata through the
existing hook; exact wire cleanup continues through the existing queue. A private
supplemental audit binds the capture digest, removed row count and canonical
row-ID digest, with an execute-only retention reader. No second retention
procedure, decoded spool or automatic cascade is introduced. Existing legacy
and dataset audit results retain their interfaces.

Raw publication does **not** activate canonical observations, legacy source
bindings, numerical consumers, features, labels or training. The blanket gzip
canonical-binding guard remains. A later consumer/normalization increment must
qualify its bridge and include the claim/codec seal in the protected dataset
closure before any fitting path can cite compressed data. No migration after
0017 is allocated here; coordinate the next number before that increment.
Only synthetic data is published by this checkpoint's database tests; real
source rights and participation/completion qualifications remain outstanding.

Checkpoint validation passes **757 Node tests, 11 real worker checks, 75 Node DB
checks, 197 PostgreSQL tests (172 mandatory predictive cases)**, typecheck, full
lint, all 18 catalog contracts and migration/readiness/whitespace checks. The
complete gate exercises both #118 dataset/pin retention and the new publication
path. Every 0001–0016 migration/catalog contract remains byte-for-byte unchanged.
Only disposable databases ran 0017, and the test service was removed afterward.
The frozen integration prefix is **0001–0017**; no further #106 number is reserved.
# Compressed selection checkpoint

Migration allocation: 0018 only is reserved for #106; this selection checkpoint
adds no DDL. Frozen 0001–0017 remain unchanged.

`selectCompressedSourceClaim` selects already verified compressed publications
by profile, season, player/team and game at a cutoff. Publication recording and
ingestion must precede visibility; later imports cannot backdate an archive.
The newest capture time wins, while equal-time different wire hashes remain
ambiguous. Missing rows and refused projections remain explicit and cannot
establish non-participation. Evidence is copied and digested with the compressed
claim version. Inventory limits are 64 captures and 160,000 rows.

This is a pure selector, not a database reader or authorization gate. Its caller
must supply a complete, byte-verified, rights-guarded publication inventory.
Database selection, versioned normalization, consumer closure and retention
integration remain pending under 0018. Existing v1 history policy is unchanged.
# Guarded compressed source lookup

`replayCompressedSourceStats(request)` now supplies the pure selector with a
database-discovered inventory. It runs inside the existing schema-17 shared
read guard and requires the exact compressed profile/feed/season asset. Every
eligible published capture is independently checked through the execute-only
publication reader and isolated byte decoder, including contradictory captures.
The inventory is bounded at 64 captures, 20 MB of unique stored wire bytes,
64 MB decoded output and 160,000 parsed rows; an over-budget inventory refuses
rather than truncating. This first reader conservatively verifies all visible
captures in the requested profile/season, including older snapshots.

Current rights are checked before binary access and again after selection;
historical capture rights and deletion scopes are checked by the existing SQL
publication reader. Missing inventories affected by a recorded source deletion
report `retained-evidence-removed`. A missing player row remains unavailable,
not an inferred zero or participation decision. Requests are copied before the
first await, and each call gets fresh byte verification and access checks.

This adds no schema migration. 0018 remains reserved only for #106. Compressed
normalization bindings, canonical consumer publication and dataset/pin closure
integration remain pending. Existing text readers and v1 history remain intact.

Checkpoint validation: 761 Node tests, 198 PostgreSQL tests, 75 DB checks,
11 isolated worker checks, 18 catalog contracts, typecheck, full lint and
migration-artifact verification pass. Only disposable local databases were used.

## Compressed normalization preview

`planCompressedSourceStatsNormalization(request)` now verifies the qualified
compressed inventory and native JSON context in one schema-17 guarded batch.
Its explicit plan version is `nflverse-stats-normalization-plan-v3`; released
text v1/v2 plans keep their original shape and parser policy. Compressed raw
replay evidence now includes `publications` (capture ID, request hash, complete
claim-array hash and database recording time), all covered by its input digest.
V3 binds that seal metadata as `binding.sourcePublications` alongside exact
wire/capture identities, source ordinals and selected hashes, native bridges,
schedule, identity links, decisions and research-rights decisions.

The planner supports the qualified 2025/2026 raw assets and reuses the existing
identity and payload rules. It preserves missing/refused/ambiguous source states,
requires native game/team/opponent/player/schedule evidence, checks bridge windows
at kickoff, and infers no participation, completion or blank numeric values.
Source and native bytes share the existing unique stored-byte budget. Native
research rights are checked before file access and after planning, with scheduled
expiry withholding the result. The pure planner is not a source authenticator;
only the guarded preview supplies its independently verified publication input.

This checkpoint adds no DDL. The existing recorder rejects v3; it creates no
source binding, research stats revision, consumer, feature, label, dataset or pin.
0018 only remains reserved for #106's independent SQL v3 validation and recorder,
compressed row references, consumer evidence closure and deletion/pin integration.
No compressed parser fallback or changes to the v1 history policy are introduced.

Validation: 774 Node tests, 201 PostgreSQL tests, 75 DB checks, 11 worker checks,
18 catalog contracts, typecheck, full lint and migration-artifact verification
pass. Only disposable local PostgreSQL was used; frozen 0001–0017 are unchanged.

## #118 numerical-reader interface checkpoint

The next increment adds no migration and preserves complete prefix 0001–0016.
0017 remains reserved only for #106; later normalization/consumer DDL needs the
owner's separately confirmed allocation. No #118 migration after 0016 is reserved.

- `readDatasetPage({ version, fittingRunId, inventorySha256, datasetId,
  manifestSha256, cursor, limits: { rows, bytes } })` verifies the same assigned
  shard/closure and returns fixed numeric feature/outcome components, sparse
  ordinals and a deterministic next cursor. It cannot select newer records.
- `readCurrentLabels({ version, selection: { market, stat, labelVersion,
  profileIds }, keys: [{ playerId, gameId, seasonType, labelRef }], limits })`
  selects global heads at one guarded database clock, then verifies their scope,
  current rights and exact bytes. `labelRef: null` selects the head; a string
  requests that exact version without substituting another label.
- `readLabelsAt({ ...currentRequest, labelsAsOf })` selects historical heads at
  the explicit eligible cutoff and returns present-snapshot supersession only
  as metadata, never a future outcome. Limits are at most 64 rows/8 MB returned
  canonical bytes; oversized batches/responses refuse in full.

All calls use `version: "qb-training-read-v1"`; only passing-yards/source-final-
label-v1 is supported. Numeric zero is distinct from missing/unqualified final
labels, which return no outcome and no inferred absence/void/settlement. Pages
and label batches remain `fittingReady: false`, population unqualified. Audited
invalidation, deadlines and representative capacity are
still outstanding. These readers do not change `readBytes`, `readWireBytes`,
gzip publication/inspection or exact-address retention/cleanup interfaces.

The reader checkpoint passes 753 Node tests, 75 Node DB checks, 193 PostgreSQL
tests (168 mandatory predictive cases), typecheck, affected-file lint and all 17
catalog contracts. Frozen/generated prefix files match `2f57d12`; no new migration
or shared artifact interface is introduced. Only disposable databases were used.

## #118 complete-run verification checkpoint

`readFittingRunReadiness({ version: "qb-training-read-v1", fittingRunId,
inventorySha256 })` checks the complete sealed assignment under one guard.
Unsealed datasets remain explicit, every available shard/closure is reconstructed,
shared bytes are verified once per call and all requested counts reconcile.
Current access and eligibility apply to the whole run before files and delivery;
an inaccessible shard refuses the entire result. The report distinguishes complete
verification, active pin durability and usable feature/label pairs. It returns no
numeric bodies and remains `fittingReady: false`, population unqualified.

There is no migration or shared binary/gzip/cleanup/retention interface change.
Frozen 0001–0016 remain unchanged; #106 retains its coordinated allocation.
The next #118 checkpoint is durable, audited invalidation. It requires a confirmed
next number after #106's complete frozen prefix; this checkpoint reserves none.
Deadlines/cancellation, representative capacity and independent review are also
outstanding. The evidence checkpoint records the adversarial tests and final gates.

## #118 provisional invalidation interface checkpoint

The owner confirmed the 0018/#106 then 0019/#118 allocation. On the latest remote
check #106 still ends at `9d8fde7`/0017. Relay's ordered migrations, schema,
manifest, catalog contracts and readiness artifacts stay at 0001–0016. Reserved
0019 lives in `db/migration-drafts/`, not the ordered migration directory. It is
not finalized or ledger-applied. #106 can merge Relay's reader/API checkpoint
without a migration-number collision; neither session should promote the draft
before verifying it against the complete frozen prefix18.

No shared artifact read/binary/hash, receipt-ingestion clock, quota or exact-address
cleanup interface changes in this increment. Current rights and guards remain
mandatory before source bytes; audit reads contain no source bytes. New public
store methods are `recordTrainingInvalidation` and `readTrainingInvalidations`,
using `qb-training-invalidation-v1` (separate from read-v1). Seven immutable
run/dataset read or preparation/pin methods now throw `TrainingReadWithheldError`
for eligible evidence refusals, with a canonical original error and explicit
audit success/not-installed/failure. Older prefixes still withhold output and
report `not-installed`; other error classes retain their existing behavior.

The SQL design adds digest-only immutable addresses and append-only receipts,
database clocks, indexed bounded snapshot history and first-occurrence
deduplication. Authorized dataset/run deletion hooks record invalidation in the
same transaction, including a removed shard's impact on its parent inventory.
They use the existing authorization, preserve legacy retention counts/digests
and avoid another full procedure copy. The diagnostic ceiling cannot block
mandatory deletion. Historical receipts are diagnostics, not repair certificates,
access grants or permanent dataset state; readers continue verifying evidence.

Nine focused PostgreSQL cases pass, including restricted non-superuser reads and
retention, damaged/missing files, audit failure, quota/concurrent retries, exact
expiry, late deletion rollback and actual restoration of original synthetic
database clocks/blobs followed by retention reapplication. Final provisional
gates are in [predictive-training-evidence.md](predictive-training-evidence.md).
Finalization still requires the published prefix18, catalog/readiness/bootstrap
regeneration and integrated checks. Deadlines/cancellation, representative capacity
and independent review remain #118 work. Both issues remain incomplete and
#54 Part B is blocked; no persistent/hosted database was migrated.

Final provisional validation passes 760 Node tests, 75 Node DB checks and 205
PostgreSQL tests (180 mandatory predictive cases), all 17 existing prefix catalog
contracts, typecheck and affected-file lint. The 36 frozen/generated prefix files
match `86c141d`; local documentation links and whitespace pass. These gates cover
the prefix16-plus-draft harness, not a completed prefix19 integration.

Final validation passes 756 Node tests, 75 Node DB checks and 196 PostgreSQL tests
(171 mandatory predictive cases), typecheck, affected-file lint and all 17 catalog
contracts. Frozen/generated prefix files match `986bfed`. No new migration or
persistent/hosted database operation is included.


## Current allocation after reader integration

Relay checkpoints `986bfed` and `86c141d` are integrated for #106. Frozen
0001–0017 remain unchanged. #106 owns 0018 only; #118 owns 0019 only for audited
invalidation, to finalize against the validated 0018 prefix once published.

## 0018 compressed bindings and consumer integration

Migration `0018_predictive_compressed_bindings.sql` implements the explicit v3
SQL plan and execute-only compressed binding recorder. `recordCompressedSourceNormalization`
uses the global writer lock followed by the shared evidence guard, independently
reconstructs the complete plan in SQL, and retains the released binding/revision
IDs, predecessor rules and association graph. The legacy recorder rejects v3;
legacy CSV qualification and read-only repeatable-read paths remain unchanged.

The private materializer copies the complete sealed claim array into existing
`predictive_source_stats_rows`, preserving all ordinals and refusals. Private
transaction authorization blocks direct gzip row insertion. Deferred completion
compares the entire materialized array with the publication seal and clears the
authorization; a later deferred binding trigger rechecks source/native research
rights after this work. Unrelated rows are materialized but receive no canonical
binding or statistical observation. Text bounds remain 8 MB/8,192 records;
compressed rows use only the existing qualified 8 MB/80,000-record namespace.

V3 SQL planning uses indexed immutable rows after full materialization; before
that boundary it reads the immutable publication array. Filesystem authenticity
still comes from independently decoding exact gzip bytes. Publication metadata
and decoded proofs are memoized only inside one guarded transaction; current
rights/deletion gates remain fresh and do not repeat full-array hashing at each
clock check. Source/native bytes share the 20 MB unique-wire budget, and actual
gzip work shares 64 MB decoded output and 160,000 rows across the transaction.

The existing source witness, reconciliation, participation, feature and label
paths recognize v3 explicitly. Source profile routing selects a shared guard for
gzip while retaining legacy CSV isolation. Feature mathematics, label policy and
v1 multi-season history are unchanged. Dataset closure now explicitly includes
compressed publication and codec-inspection references, in addition to existing
row/capture/blob/native/rights references. Existing deletion procedures remove
complete binding lineages, consumers, inventories, datasets and pins; pins never
override mandatory deletion. The binary artifact and cleanup interfaces are unchanged.

#118 owns 0019 only for audited invalidation. No #106 migration after 0018 is
reserved. Relay checkpoints `986bfed` and `86c141d` are included in this combined
checkpoint. Real source/identity/membership/completion qualification remains
required; synthetic consumer success does not establish training readiness.

Frozen migration prefix: **0001–0018**. 0018 SHA-256:
`58f0d5ae8cf11700d64370bf4dfdde8844dd2be6380935e103c84457a538de1e`.
Frozen 0001–0017 SQL and catalog artifacts are byte-for-byte unchanged.
Validation passes: 783 Node tests, 219 PostgreSQL tests (194 mandatory predictive
cases), 75 DB checks, 11 isolated worker checks, 19 catalog contracts, typecheck,
full lint, migration/readiness checks and whitespace checks. Only disposable
local databases were migrated; the final gate removed its service and scratch data.
#118 can finalize 0019 against this prefix; #106 reserves no further DDL.

## 0019 combined integration and frozen checkpoint

Relay integrates `dae2940` by merge, preserving branch history and both sessions'
readers and tests. Migration 0018 matches the supplied SHA-256
`58f0d5ae8cf11700d64370bf4dfdde8844dd2be6380935e103c84457a538de1e`.
The former `a6da525` draft moves into the ordered chain as
`0019_predictive_training_invalidations.sql`. Its failure vocabulary additionally
recognizes the compressed source rights and wire/publication/inspection integrity
errors introduced by the integrated reader. Resource/runtime/cancellation errors
remain outside the evidence-invalidation vocabulary.

Tests now apply 0019 through the actual migration runner and ledger. A populated
prefix18 upgrade backfills exact inventory/manifest addresses, preserves the
previous ledger/evidence and verifies idempotent reruns. Injected failure after
the final catalog verification rolls back all 0019 DDL, addresses and ledger rows;
the original dataset still replays. Fresh installation and every prior upgrade
fixture now target the complete prefix19. The older-installation refusal case
retains prefix18, where audit status stays explicitly `not-installed`.

A new compressed-consumer regression uses the replay-only and retention-only
logins. Damaged wire bytes and a mismatched stored decoded proof append sanitized
reader diagnostics after rollback. Restored bytes/proof replay the same manifest.
Revoked rights refuse before any binary read and yield a database-confirmed
receipt. Mandatory deletion removes compressed bytes and the existing closure,
while its digest-only audit survives. Existing text and exact-backup recovery
cases remain mandatory. No binary storage, quota, codec worker or retention
procedure is replaced by 0019.

The combined final gate passes: **787 Node tests**, **75 DB checks + 229
PostgreSQL tests** (204 mandatory predictive cases), **11 codec-worker checks**,
all **20 catalog contracts**, typecheck and full lint. Logs are
`/private/tmp/dfs118-schema19-db-clean.log` and
`/private/tmp/dfs118-schema19-{node,types,lint,contracts}.log`.
The bootstrap inventory ordering was corrected; three later wall-time timeouts
passed focused rechecks before the clean full gate. No timeout was relaxed.

0019 is now frozen with SHA-256
`4b4502b2b1431faa753ee067a90998f247955437c55edd0db8bc47bfa196e568`.
All 37 frozen SQL/catalog artifacts in #106's 0001–0018 prefix match `dae2940`
byte for byte. No migration after 0019 is reserved by this checkpoint. All databases used here
are disposable/local. #118 still needs deadlines/cancellation, representative
capacity evidence and independent review; both issues remain incomplete and
#54 Part B stays blocked by real-source and population qualification.


## #118 execution-control increment after the frozen prefix

Frozen 0001–0019 integration is pushed at `2aee941`; #106's 0001–0018 artifacts
remain byte-for-byte unchanged. The next #118 increment adds optional execution
controls to the training APIs, with no DDL or new migration reservation. Text and
binary artifact reads now accept an optional fourth `{ signal }` argument; their
existing three-argument behavior and exact-address integrity checks are retained.
Guarded compressed reads receive the parent signal and remaining operation time,
while current rights, wire quotas and decoded-work ceilings remain in force.

Training methods use one cumulative 10/30-second execution budget. Interrupted
sessions are cancelled through a bounded same-login connection that checks the
original PID/start time, database and user, then retired. Reconnect and retry
immutable IDs after interruption; a commit-boundary disconnect can have unknown
commit outcome. Native local file reads are cooperatively cancelled between
syscalls, and codec/session cleanup is drained before settlement. No claims of
hard OS preemption, real-source capacity or training readiness are made.

The increment passes 81 affected PostgreSQL cases, 792 Node tests plus the
focused artifact/controller regression, report-contract checks, typecheck and
lint. It preserves all 39 frozen SQL/catalog artifacts. The 229-case full database
gate belongs to `2aee941`; it is not claimed to have been repeated for this reader
increment.

See [the execution contract](predictive-training-handoff.md#training-execution-deadlines-and-interrupted-recovery)
and [the evidence checkpoint](predictive-training-evidence.md).
Next gates are representative capacity and independent review. No migration
after 0019 is reserved.

## #118 guarded SQL validation increment (0020)

0020 is frozen at this checkpoint for #118's training-validation optimization.
The complete fixed prefix is **0001–0020**. The ordered
file is `0020_predictive_training_validation_memo.sql`, with SHA-256
`fed741f76177ec35e07ac1d1d09f39b33ceb26d406ac06b0e4ecd97e7816ada3`.
All 39 frozen SQL/catalog artifacts through 0019 match `c744ffa` byte for byte;
the earlier #106 prefix remains intact. No migration after 0020 is allocated.

The optimization shares successful reconstruction inside a guarded transaction;
it does not change feature or label definitions, source receipt clocks, v1
multi-season history, byte verification, training requests, cancellation,
wire/decoded quotas or retention interfaces. **No TypeScript byte-reading,
verification or cleanup interface changes are required by #106.**

The final ordered 1/16-width benchmark passes under the original API deadlines.
At 16 rows, run preparation takes 2.27 s, dataset/pin preparation 6.78 s, a 16-row page
5.77 s and labels 7.70 s. This uses one numerical history slot, two profiles and
mixed CSV/gzip in a synthetic 16-QB inventory; it proves no real-source, full
history, opponent or population capacity. Source hashes, migration hashes and
raw measurements are retained in
[the capacity artifact](evidence/predictive-training-capacity-prefix20-2026-10-14.json).

Memoization requires all 36 kernel evidence tables to have SHARE locks; writes in
the same transaction disable reuse. Exact requests, cutoffs and versions remain
separate. Historical validation retains its exact rights clock; current reuse
requires the same global rights epoch and fresh context authorization. Private
temp state is disposed at transaction end. Callers cannot submit cache results
or authorize a record by creating a shadow temp relation. Original validators
remain the fallback, including outside the guarded training path.

After a committed guarded read, the session's empty TEMP namespace persists.
Catalog/migration operations must use a fresh administrative connection, as the
CLI does; the collector's strict no-temp rule is unchanged. Training sessions
may be reused normally, except after an interruption. Upgrade fixtures test
the fresh-migrator boundary without changing the recorded evidence or ledger.

For #106's forthcoming original-byte context recorder, any new table consulted
by these kernels must enter the read guard and memo's protected dependency set
through coordinated forward DDL. Reuse assumes that the access clock changes
kernel results only through rights boundaries and cutoff eligibility. New
clock-dependent policies must update that key or remain uncached. Frozen 0020
must not be edited to accommodate later dependencies.

The [evidence checkpoint](predictive-training-evidence.md) records migration
rollback/parity, restricted-role, temporal and deletion checks. The wider
64-QB checkpoint below identifies another capacity limit. Full-history,
opponent/file-size cases and independent review remain.
#118 and #106 remain incomplete; #54 Part B retains all real/population gates.

Validation covers all 234 PostgreSQL cases through one complete run and focused
rechecks of four corrected fixtures, plus the strengthened safety case. It also
passes 75 DB checks, 11 worker checks, 21 catalog contracts, 873 jsdom/793 Node
tests, typecheck, full lint and final affected-file/report checks. The complete
database command's aggregate report was not rerun after those fixture corrections;
final PR CI remains required. Only owned disposable/local databases were migrated.

## #118 wider capacity checkpoint (no new migration)

The [64-QB/eight-profile matrix](predictive-training-capacity.md) is now measured
at the same frozen prefix20. Width1/16 dataset preparation completes, but every
measured numerical page/current-label call exceeds its 10-second deadline.
Width64 run preparation also reaches the SQL limit. The prior successful
16-QB/two-profile sample therefore does not qualify larger source inventories.
The raw measurements separate SQL validation cost from byte-backed application
work; further optimization must preserve exact clocks, all visible lineages
and fresh use-specific rights gates.

Only disposable benchmark setup changes: it stages synthetic blob metadata
before guarded checked recording. Production byte-reading, verification,
deadline, retention and fresh-administrative-connection contracts stay unchanged.
All 40 frozen SQL/catalog artifacts still match `9cf2a8f`; **no migration after
0020 is allocated**. #106 may continue its recorder footprint/design work and
source qualification; coordinate the next number before either branch adds DDL.
The [independent review map](predictive-training-review.md) is prepared, with
review and final aggregate CI still outstanding. #54 Part B remains blocked.
