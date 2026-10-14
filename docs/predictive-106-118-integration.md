# #106 / #118 integration prefix — 2026-10-13

#118 integrated #106's pushed `4f1ad06` checkpoint on
`feature/dfsEV-118-training-reads-retention`. The combined fixed prefix is now
**0001–0015**, including #118's immutable run inventory and #106's guarded codec
inspection. Qualified compressed publication and full compressed consumer
reconstruction remain unfinished.
Neither session has published a usable real feature or label.

## Fixed integration prefix

Use the ordered **0001–0015** prefix in [migration-manifest.json](../db/migration-manifest.json).
Released 0001–0011 and the integrated 0012–0015 remain byte-for-byte unchanged.
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

**0016 is reserved for #118 dataset/pin DDL**, as authorized by the owner after
#106 confirmed its complete prefix through 0015. #106 will use **0017 or later**
for publication changes after coordination here; neither session should reserve
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
The current `verifiedBytes` metric has no separate gzip decoded-work metric yet.

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
