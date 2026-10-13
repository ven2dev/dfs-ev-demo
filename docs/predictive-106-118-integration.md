# #106 / #118 integration prefix — 2026-10-13

#118's pushed implementation checkpoint is `58eadecc6df817265322fa8b32d9d67b106b1ee8`
on `feature/dfsEV-118-training-reads-retention`. #106 reports local commit
`11a760f` on `feature/dfsEV-106-real-qb-slice`, not yet pushed, with exact binary
wire storage but no SQL gzip publication or allocated migration. These are
separate validation checkpoints; #106's gzip implementation is not verified by
#118's current tests.

## Fixed integration prefix

Use the ordered **0001–0012** prefix in [migration-manifest.json](../db/migration-manifest.json).
Released 0001–0011 remain byte-for-byte unchanged. For branch integration, also
keep #118's 0012 fixed:

```text
0012_predictive_training_read_guard.sql
sha256 52dbb7400c93d9eb231fa210a4cce859e425ba7f836841ba5743c978efcf2fc3
```

0012 adds two source-consumer lookup indexes and the role-checked training read
guard. It adds no tables, byte encodings, publication format or retention
procedure replacement. It has run only in disposable local databases; it is
not merged to main or activated in a persistent/hosted database. Future changes
to this shared prefix use forward migrations.

**0013 is available to #106.** #118 will not allocate another migration until
#106 declares its complete next prefix. Integrate the pushed #118 branch by
merging after preserving #106's local work; do not rebase or cherry-pick duplicate
copies of the prefix. Keep #106's binary artifact implementation when resolving
shared files. Regenerate migration/catalog/readiness artifacts for the combined
prefix, and validate the final integrated SHA before merging either PR.

## Shared interfaces at 58eadec

| Surface | #118 change / #106 integration requirement |
| --- | --- |
| `artifacts.ts` | Unchanged by #118. `read(reference, sha256, byteSize)` still returns a UTF-8 string; media types remain JSON/CSV. #106 owns the binary addition. Never route compressed bytes through this string reader. |
| `persistence.ts: readBytes` | New private wrapper caches by exact reference/hash/size within the guarded transaction, charges unique stored bytes and checks fresh access before opening a file. Add the binary wire-reader path here, preserving the gate; it is not an exported helper. |
| CSV verification | Shared exact-file reads and parsing, then exact stored-row/projection comparison and full normalization/witness/decision/calculation reproduction. Wire hash/size must verify before decompression; decoded content cannot replace the wire identity. |
| `batchEvidence.ts` | New transaction-local metadata-query and verification-promise reuse. Keep binary payloads outside the JSON metadata dispatcher. Decoder cache keys must distinguish wire reference, encoding, feed and parser version as applicable. |
| `replaySourceConsumers(ids)` | New local evidence primitive: at most 64 references; returns snapshot time, ordered verified records/nulls and verification metrics. It does not seal training datasets or pins. Gzip must work through its full reconstruction path. |
| Retention APIs | Signatures unchanged: `retain`, `resumeBlobRemovals`, `sweepOrphanBlobs`. Preserve execute-only role APIs, exact `storage_ref` ownership, digest locks, queued acknowledgement after unlink, rollback cleanup and aged-temp recovery. Extend every address validator to `.csv.gz`, not just the filesystem reader. |

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
has published a usable real feature or label. #118 currently passes 700 Node
tests, 75 Node DB checks and 142 PostgreSQL tests plus typecheck/lint; those counts
do not include #106's binary integration. Focus combined validation on denied
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
No later migration number is reserved by this checkpoint. Settle the next number
in this chat before either session allocates another migration.

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
