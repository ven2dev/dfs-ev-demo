# #106 / #118 integration prefix — 2026-10-13

#118 merged #106's pushed `47b1c89` checkpoint in `da24ab9` on
`feature/dfsEV-118-training-reads-retention`. The combined prefix is now
**0001–0014**, including #118's immutable run-inventory increment described below.
#106's 0013 supplies gzip staging and receipt/cleanup protections; qualified
compressed publication and guarded binary reconstruction remain unfinished.
Neither session has published a usable real feature or label.

## Fixed integration prefix

Use the ordered **0001–0014** prefix in [migration-manifest.json](../db/migration-manifest.json).
Released 0001–0011 and the integrated 0012–0013 remain byte-for-byte unchanged.
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

**0014 belongs to #118 run inventory.** The next number is **0015**, available to
#106 after coordination here; neither session should reserve a further range
silently. Integrate by merge after preserving local work; do not rebase or
cherry-pick duplicate copies of the prefix. Keep #106's binary artifact
implementation when resolving shared files. Regenerate migration/catalog/
readiness artifacts for the combined prefix and validate the final integrated
SHA before merging either PR. These additions have run only in disposable local
databases.

## Shared interfaces

| Surface | #118 change / #106 integration requirement |
| --- | --- |
| `artifacts.ts` | #106's binary addition is integrated: `readBinary`/`writeBinary` preserve exact gzip wire bytes. `read(reference, sha256, byteSize)` remains a UTF-8 JSON/CSV reader. Never route compressed bytes through it. |
| `persistence.ts: readBytes` | New private wrapper caches by exact reference/hash/size within the guarded transaction, charges unique stored bytes and checks fresh access before opening a file. Add the binary wire-reader path here, preserving the gate; it is not an exported helper. |
| CSV verification | Shared exact-file reads and parsing, then exact stored-row/projection comparison and full normalization/witness/decision/calculation reproduction. Wire hash/size must verify before decompression; decoded content cannot replace the wire identity. |
| `batchEvidence.ts` | New transaction-local metadata-query and verification-promise reuse. Keep binary payloads outside the JSON metadata dispatcher. Decoder cache keys must distinguish wire reference, encoding, feed and parser version as applicable. |
| `replaySourceConsumers(ids)` | New local evidence primitive: at most 64 references; returns snapshot time, ordered verified records/nulls and verification metrics. It does not seal training datasets or pins. Gzip must work through its full reconstruction path. |
| Run preparation | `prepareFittingRun(request)` fixes the entire inventory and SQL-selected IDs; `readFittingRun(id)` reads its metadata with fresh rights. Neither opens files, seals a verified dataset or creates pins. |
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
