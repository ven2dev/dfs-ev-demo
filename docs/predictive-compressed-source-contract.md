# #106 compressed prior-season source contract

Status: **qualified decoder proof; proposed publication/storage contract**.
Prepared 2026-10-13 on the #106 branch, based on merged main 716d755 and
[the accepted #106/#118 handoff](https://github.com/ven2dev/dfs-ev-demo/blob/b7db281e156ac4decfd181e4d158ce912bef57e0/docs/predictive-training-handoff.md).
No database profile, migration, binary blob writer or model reader is activated.
The existing v1 feature/history contract and frozen migrations 0001–0011 remain
unchanged. This increment has no provider/network or database calls.

## Decision and exact evidence

Retain complete provider `.csv.gz` bytes, rather than raise the global plaintext
blob limit or pretend a QB-filtered CSV is a provider snapshot. A gzip source is
an original artifact with a binary wire identity and a separately verified
complete decoded CSV identity. Compression must not evade decoded, record,
row, time or aggregate work budgets.

Offline Node inspection of the previously retained, digest-verified provider
files completed with CRC/EOF validation and no new acquisition:

| Feed, season 2025 | Wire bytes | Decoded bytes | Data records | Scoped records | Elapsed | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Player weekly | 1,262,421 | 8,656,387 | 19,422 | 19,422 | 450 ms | 122,273,792 bytes |
| Weekly roster | 708,144 | 15,385,661 | 46,849 | 46,849 | 642 ms | 120,209,408 bytes |

These are single-file local measurements, not hosted/page/concurrent capacity
promises or a hard process-memory bound. Both exact headers match the registered
2026 column profiles. Independent Python gzip/CSV/hash checks agree on wire and
decoded identities, all row/scope counts and the ordered selected-record digest.
Raw artifacts and numerical data remain private outside Git.

The wire sum is 1,970,565 bytes. Plaintext would total 24,042,048 bytes and would
already exceed #118's proposed 20 MB unique-private-byte verification ceiling
before other context. Compressed wire identity fits that ceiling but still
requires about 24 MB of decoded work across these two files.

Private results: `/private/tmp/dfs106-player-decoder.json`,
`/private/tmp/dfs106-roster-decoder.json`,
`/private/tmp/dfs106-decoder-python-parity.json`. Original immutable bytes and
release metadata remain in `/private/tmp/dfs106-source-probe-lzpwbnwa/`.
Temporary evidence is not durable; do not copy raw source bytes into Git.

## Inspection profile implemented in this increment

`nflverse-gzip-csv-inspection-v1` accepts only player/team/roster and declared
seasons 2025 or 2026. Accepting a decoder request is not registration for source
use. Every result explicitly returns `publicationSupported: false`,
`featuresPublished: false` and `labelsFinalized: false`.

| Ceiling | Inspection limit |
| --- | ---: |
| Complete immutable wire bytes | 8,000,000 |
| Decoded UTF-8 bytes | 20,000,000 |
| Complete data records | 80,000 |
| CSV record bytes | 65,536 |
| Per-inspection wall time | 30 seconds |

These are a separate qualification profile; old blob/claim limits remain
8 MB/8,192 rows. Callers can lower inspection limits but cannot raise them.
The decoder copies the input/request before awaiting, verifies the complete
wire digest/size, streams 16 KiB zlib output, validates UTF-8 across chunks and
pins the exact full header. It hashes decoded bytes including any BOM; CSV
ordinals count data records, including invalid-scope rows, not physical lines.
Quoted commas/newlines and concatenated gzip members representing one CSV
stream retain their exact semantics. Selected-record hashing is versioned as
SHA-256 over UTF-8 `canonical([ordinal, allowlistedRow]) + newline` in record order.
Excluded columns remain in wire/decoded identity, never selected fields.

CRC/truncation, invalid UTF-8, malformed CSV, header drift, empty CSV, cap overflow,
cancellation or elapsed deadline refuse the whole inspection. There is no row
callback, iterator or partial result that a caller could publish before EOF/CRC.
Out-of-scope rows are counted, not filtered; later claim classification must
retain them as explicit refusals. Scope counts do not qualify numeric values,
identity, membership, participation, completion, rights or correction finality.

The offline CLI refuses ambient application/database credentials, files inside
the checkout, insecure parent/file modes, symlinks and hardlinks, changed size/
mtime and unbounded reads. It has no artifact registration, write/delete,
provider credentials, acquisition or database connection.

## Proposed production wire/storage contract

1. **Versioned profile.** Register each qualified feed/year/asset/header/codec
   combination explicitly. Preserve existing `nflverse-csv-qualification-v1`
   producers and 2026-only semantics. A new gzip/multi-season source profile
   does not change `passing-yards-source-v1` feature mathematics/history.
   Initial source qualification is 2025/2026; do not infer approval for 2024 or
   earlier raw statistics, even though target-relative schedule coverage is broader.
2. **Binary identity.** Add `application/gzip` with exact `.csv.gz` storage
   references under the existing private database-blob namespace. The primary
   digest is SHA-256 of original compressed bytes, never decoded or reserialized
   content. Add byte-oriented read/write methods while preserving old UTF-8
   JSON/CSV APIs. No base64-in-JSON wrapper and no unmanaged duplicate cache.
3. **Codec proof metadata.** Bind a capture to codec/version, exact header hash,
   declared feed/season, wire digest/size, decoded digest/size, row count and
   selected-record aggregate digest. Sealed writes use the database clock;
   source capture provenance remains separate. Metadata and ordinals must bind
   to that exact capture/artifact/profile; caller fields cannot make a bad wire
   file usable. Recompute proof from private bytes before consumer payloads.
4. **Complete source claims.** New player/team publication preserves every
   original data-record ordinal, including explicit refused rows. Validate full
   coverage, keys/projections and profile/asset/season compatibility. Expand the
   source-claim ordinal bound forward for the qualified profile only, with an
   explicit per-profile maximum; legacy captures keep their 8,192-row contract.
   Generic semantic projections must still match artifact scope. No row/page
   filter can substitute for full snapshot verification.
5. **Roster separation.** Roster gzip is not a statistical claim or automatic
   ordinary artifact-observation input. Its later native membership adapter needs
   exact source-row provenance and separately qualified effective bounds. This
   codec contract does not infer intervals from week numbers or ACT status.
6. **Same authorization boundary.** Before bytes, apply current rights and
   historical requested-use checks. Extend canonical guards, clock rules and
   source readers to recognize new registered codecs. An unrecognized binary
   profile cannot bypass a text-CSV guard or fall back into ordinary statistics.
   SQL enforces metadata/role/closure contracts, not an ability to parse gzip
   bytes it cannot access; application replay must independently verify bytes.
7. **Same lifecycle.** Publication/digest locks, rollback, diagnostics, orphan
   sweep, removal queue, exact final-address ownership and restore/re-apply must
   support `.csv.gz`. A deletion/pin closure includes original wire artifact,
   codec metadata and dependent claims/bindings/native evidence. No decoded
   journal/spool survives mandatory deletion outside managed closure. Preserve
   historical audit parity and coordinate helper integration with #115/#118.

## Proposed runtime budgets for review

Keep 8 MB per wire blob and 20 MB unique wire bytes per protected batch, charging
quota by the complete retained wire and managed manifest/proof bytes. A compressed
size is not a licence to decode an unlimited body. Proposed separate work budgets:
20 MB decoded/file, 80,000 records/file, 64 MB decoded work/batch and 160,000
records/batch. Per-feed caps can be narrower after measured growth/headroom.

Preserve #118's page/prepare deadlines; pass the remaining caller deadline into
inspection rather than allow a fresh 30-second timer to extend the operation.
Verification reuse covers exact wire/decoded/codec/profile identities only inside
one protected batch. Do not cache approval across pages/rights states.

Use a bounded worker/process for untrusted source decode with a proposed 256 MiB
memory ceiling and cancellation/termination behavior. A V8 heap limit is not a
process RSS limit. The current inspector streams and measures RSS but does not
enforce that proposed process ceiling. Large heap/oversized-entry stress and
worker termination/recovery are required before production-path activation.
Concurrent workers must fit an explicit parent budget rather than each claiming
the whole allowance. Measure native memory and CPU as well as SQL round trips.

These new decoded-work/process budgets are proposed integration limits, not
changes to the accepted #118 contract by implication. Review and benchmark the
shared verification contract before either branch activates a writer/reader.
No migration number is allocated here; add only forward migrations after the
then-current tip, integrating the first lander's main before the second lands.

## Scope evidence uncovered by full inspection

All ten 2025 player-history slots have a matching weekly roster claim. Nine
have one Hurts statistics row with positive raw usage. `2025_18_WAS_PHI` has no
Hurts statistics row. That slot remains unresolved and needs a permitted explicit
participation/absence route; it is not zero or DNP by inference. Keep it in both
8/16-slot horizons. Positive claims still need canonical identity, reconciliation,
completion and recorded participation decisions. The absence route is a concrete
qualification prerequisite for the selected proof, independent of codec/storage.

## Validation / review gates

The focused tests verify independent wire/decoded/selected hashes, excluded-column
separation, multiline/BOM/concatenated-member ordinals, inclusive wire/decoded/row
limits, multibyte record-byte enforcement, highly compressible expansion refusal,
CRC/truncation/fatal UTF-8/header/schema errors, input immutability, cancellation,
monotonic deadline and CLI credential/argument refusal. Real complete files have
independent Python parity, not just agreement with this parser's own helper.

Before schema/publication activation, add actual binary artifact lifecycle and
restricted-SQL profile/claim/clock regressions, raw/canonical hash parity for
negative and refused rows, rights/deletion races, restoration and #118 batch
work/quota tests. Run required app/database/security checks and affected
independent review. Decoder success is not proof of a usable real feature/label.

Checkpoint adherence QC: all 17 focused tests passed, followed by six selected
single-fault checks in an isolated copy. Disabling wire integrity, decoded-byte
limits, row limits, fatal UTF-8, total record-byte limits or decoded identity
each caused assertion failures. The first fault pass exposed a weak record-size
oracle (its header exceeded the test limit); the strengthened case now accepts
the exact full Unicode data-record byte boundary, uses a valid smaller header,
and refuses one byte less. It detects removal of the explicit total-byte guard.
No working-tree source was mutated by fault injection. This is selected sensitivity,
not exhaustive mutation coverage or an independent review of future schema changes.

Final code checks for this checkpoint: all 686 Node tests pass; typecheck
(including readiness verification), lint and `git diff --check` pass. Existing
UI/database/publication behavior is unchanged; no DB test service or migration
was needed for this inspection-only increment. No provider data was committed.

## Binary filesystem checkpoint

The private artifact store now exposes `writeBinary` and `readBinary` for exact
wire bytes at `<wire-sha256>.csv.gz`, alongside the existing text methods. Writes
copy mutable input before awaiting filesystem work, use exclusive private
temporary files and atomic links, and verify the final hash and size. Reads are
bounded even if a file grows, check private single-link files and registration,
and return independent buffers. The byte store makes no assertion about gzip
validity, source rights or publication eligibility.

Removal and age-gated orphan discovery recognize the exact gzip suffix. Cleanup
is confined to `.db-blobs`; root archive files remain outside orphan discovery.
Seven regression cases cover concurrent/idempotent writes, caller mutation,
buffer isolation, text/binary separation, malformed addresses, tampering,
permissions, links, registration replacement and exact-address deletion.

The SQL schema remains at its existing prefix: it does not register gzip blobs
or publish compressed source captures. Relay owns the pending migration 0012.
Coordination stays in this chat at the owner's request. The next storage step
is a separately tested SQL patch, followed by a forward migration after the
shared prefix is settled; neither a migration number nor SQL activation is
claimed by this filesystem checkpoint.

Checkpoint checks: all 693 Node tests, all 75 Node database checks and all 136
PostgreSQL tests pass, with the required-case report verified. Typecheck, lint,
migration artifacts, readiness manifest and whitespace checks pass. The disposable
database service was removed after testing. These database checks verify existing
publication and retention behavior; gzip SQL publication remains unimplemented.

## Complete-file claim preparation checkpoint

#106 integrated Relay's published schema-13 checkpoint `da24ab9`. The decoder
now has a separate preparation entry point that retains allowlisted rows only
for callers that need them; the streaming inspector still returns metadata only.
No row callback or partial result escapes before complete gzip CRC, UTF-8,
header and work-limit verification. `prepareCompressedSourceClaims` accepts
player/team files scoped to 2025 or 2026, retains every full-file ordinal and
records invalid numbers, context, IDs and wrong-season rows as explicit refusals.
Roster effective-window qualification remains separate. The released text
projector and publisher retain their existing 2026-only interface and behavior.

Six new cases independently specify signed/zero values, raw key and selected-row
identities, full-file ordinals with interleaved refused rows, team/player separation,
scope limits, mutable-input pinning, CRC/truncation and independent work limits.
An isolated copy passed the baseline; disabling scope enforcement, filtering out
refused claims or disabling wire-hash verification each caused assertion failures.
The working-tree source was not fault-injected. This is selected test sensitivity,
not exhaustive mutation coverage or independent review of a publication writer.

The retained complete 2025 player gzip produced 19,422 claims: 19,400 projectable
raw rows and 22 `source-stats-player-refused` rows. An independent Python gzip/CSV
and numeric projection pass matched every ordinal/ID/key/selected hash, refusal
and typed payload via aggregate claim SHA-256
`804909c4205efaa46a84df9194ac5b59e788fcaea764fec3034e50edf422785a`.
It also matched the wire/decoded/selected-record identities. Diagnostics remain
private; no new acquisition or provider rows were committed. Measured preparation
peak RSS was 214,122,496 bytes (about 204 MiB); the proposed process ceiling is
still not enforced, and bounded decoded bytes/rows do not establish an RSS cap.

This is pure preparation, not rights authorization, SQL codec registration,
canonical evidence or training readiness. No runtime writer or guarded batch
calls it yet. 0013 still rejects published gzip; #118 owns 0014, and no 0015 was
allocated in this checkpoint. Next activation needs the versioned SQL envelope,
guarded binary reads, separate decoded-work accounting and the process ceiling,
followed by publication/deletion/restoration and full-consumer reproduction checks.

Checkpoint validation: all 742 Node tests, 75 database checks and 151 PostgreSQL
tests pass, including the required-case report. Typecheck, lint, generated
catalog/migration/readiness checks and whitespace checks pass. The disposable
database service was removed. The pure preparation API is still outside runtime
publication and guarded training reads.

## Immutable inspection envelopes and guarded wire reads (0015)

The [integration handoff](predictive-106-118-integration.md) fixes 0001–0015 and
records the exact hash and deletion interfaces. 0015 adds a private, immutable
inspection envelope tied to an existing incomplete capture. Its execute-only
recorder checks the capture's complete parsing flags, count, wire identity/size,
feed, scope/header and research rights under the existing digest lock. Recording
time is database-stamped. It rejects unsupported shape, activation flags and
capture mismatches. SQL metadata alone cannot validate private gzip bytes.

The new local `replayCompressedInspections` path takes the extended training
guard, verifies every selected envelope from exact binary wire bytes, and never
calls the text reader for gzip. File and codec reuse is transaction-local. Fresh
uncached rights checks run before each unique wire file and at delivery, so both
concurrent rights writes and already-scheduled expiry are covered. Wire storage
keeps its 20 MB bound; decoded work has a separate 64 MB/160,000-record ceiling
with downward-only caller limits. A failed file/proof/rights/budget check returns
no partial inspection batch. The returned metadata contains no numeric claims.

The inspection deletion hook follows authorized capture deletion, composes with
0014's inventory hook and leaves existing retention procedure bodies unchanged.
The envelope's sole identity is the already-audited capture ID. Restricted role
tests exercise recording, reading and cleanup; forged decoded hashes and valid-
wire CRC damage refuse. Other cases check private-table denial, exact replay/
wire and decoded accounting, quota boundaries, current rights before corrupt
bytes, blocked concurrent rights writes, expiry at delivery and v14 upgrades.

The full gate initially caught a missing table in bootstrap's explicit expected
inventory, which was corrected. A later run caught an existing A→B→A fixture
mixing host-clock synthetic capture times with database-clock binding times.
That fixture now samples the database clock and explicitly asserts strict time
ordering; all original historical-routing assertions remain. Six independent
repetitions passed after this repair. No application replay logic was changed.

This is local codec-diagnostic verification, not publication qualification.
0013 still refuses published gzip; there is no compressed claim writer or
consumer reconstruction yet. The proposed hard process memory ceiling and
compressed restored-backup proof remain activation prerequisites. No hosted
database or production path has been activated.

Final local gate for 0015: all 742 Node tests, 75 database checks and 166
PostgreSQL tests pass, including all 141 mandatory predictive cases. Typecheck,
lint, generated artifacts and whitespace checks pass. The test service was
removed. These checks validate codec diagnostics and the combined existing
readers/inventories, not compressed publication or usable real feature/labels.

## Isolated codec worker checkpoint

`runCompressedWorker` is a separate, opt-in local worker for inspection or complete
claim preparation. It requires a local Unix Docker endpoint and the pinned Node
image `node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`.
It never pulls an image implicitly. Prepare that exact image with `docker pull`
and run `npm run test:predictive:worker` for the mandatory eight-case worker suite;
the suite fails rather than skips when the required runtime is unavailable.

The container has a kernel-enforced 256 MiB memory allowance with swap disabled,
one CPU, 32 processes maximum, no network, no capabilities, no new privileges,
an unprivileged UID and a read-only root/code mount. Docker daemon logging is
disabled so private claim payloads are not copied into a configured log sink.
Only trusted library code, the entrypoint and csv-parse are mounted; no private
artifact directory, application environment file or Docker socket is mounted.
The child checks the actual cgroup memory/swap limits before consuming wire bytes.
The additional 192 MiB V8 heap limit does not substitute for the kernel limit.

Wire input is copied and hash-checked before asynchronous startup. The request
and capture identity are detached. The parent allows one job at a time with no
unbounded waiting queue, bounds input and output (64 MB), and limits execution
to at most 30 seconds plus bounded cleanup. It creates a stopped container before
starting/attaching and sending private bytes. Cancellation, timeout and parser
failure return no partial result. Explicit removal and a separate absence check
precede permit release; ambiguous cleanup keeps the permit held and refuses
further work in that parent. This bounds worker concurrency, not total host or
parent application RSS; parent IPC allocations have their separate output bound.

Eight container tests cover codec/claim parity, immutable input, CRC failure,
concurrency refusal, cancellation/deadline cleanup, native memory exhaustion and
recovery with no remaining task-owned container. The same sandbox killed a
512 MiB native Buffer allocation (exit 137), proving memory enforcement beyond
V8 heap accounting; Docker independently reported `OOMKilled: true`. An 80,000-
record claims job also refused resource/output exhaustion, then the same parent
successfully ran a normal job. The full retained 2025 player file reproduced the independent
aggregate digest for all 19,422 prepared claims within this sandbox. Worker peak
RSS was 143,142,912 bytes (about 137 MiB). No new source acquisition occurred.

This checkpoint adds no migration or database-path change. The existing 0015
guarded reader still uses its local in-process inspector; worker integration,
qualified compressed publication, full consumer reconstruction and restored-
backup checks remain next. 0016 stays with #118; coordinate any #106 DDL at 0017
or later. The isolated worker is not a claim that the entire application now has
a hard memory cap or that a usable feature/label has been published.

Worker checkpoint checks: all 746 Node tests, all eight Docker worker tests,
typecheck, lint and whitespace checks pass. The worker tests inspect the actual
container memory/swap, network, read-only, logging and UID configuration and
leave no task-owned container. No DB schema or existing reader changed, so the
previous schema-15 database gate remains the last DB validation checkpoint.

## Guarded inspection worker integration

The subsequent checkpoint connects `replayCompressedInspections` to the kernel-
bounded worker. Rights are rechecked before opening each unique wire file and
before final delivery, with existing database table guards held across decoding
and verified container cleanup. The compressed reader alone uses a 45-second
idle transaction timeout, covering the worker's 30-second maximum execution and
bounded cleanup. Decoder byte/row ceilings are reduced to the remaining batch
allowance and copied before asynchronous startup. Resource refusal returns no
inspection; the transaction rolls back. Persisted envelope checks and separate
wire/decoded accounting remain unchanged.

The local/CI database harness prepares the exact pinned image and runs all nine
container checks before its existing mandatory database gate. New coverage proves
inclusive reduced decode limits, refusal just below the required size and caller
limit mutation isolation. Runtime reads never download an image. This remains
codec diagnostic replay, with no qualified compressed publication, numerical
consumer reconstruction or usable feature/label activation. Schema 0015 is
unchanged; 0016 remains allocated to #118.

Integration validation passes all 746 Node tests, nine container checks, 75 Node
database checks and 166 PostgreSQL tests (141 mandatory predictive cases), plus
typecheck, affected-file lint and catalog/migration/readiness/whitespace checks.
The disposable local database was removed after validation.

## Guarded complete-claim reconstruction

`replayCompressedClaims` uses the inspection guard and isolated worker to return
complete player/team raw claim reconstructions for an explicitly listed capture
batch. It validates the entire stored codec envelope before releasing any row.
All source rows retain their original ordinals, including rows that refuse scope
or player validation. IDs include the exact capture identity. Roster numeric
claims refuse before wire access. Fresh research-rights checks, guard lifetime,
failure rollback and verified worker cleanup match diagnostic inspection replay.

The wire memo remains transaction-local and shared. Capture-specific claim work
has its own memo identity and charges decoded bytes/rows for each reconstruction;
two captures sharing one file therefore have one wire read but two decode charges.
The remaining batch work budget is enforced inside each worker. This deliberately
conservative accounting prevents claim rebinding from silently escaping decode
limits. Inspection-only callers retain their original response and accounting.

This does not publish gzip source-stat rows or authorize model inputs. Returned
claims remain research reconstructions with publication/features/labels false;
qualified publication, consumer reconstruction and usable real outputs remain
outstanding. Schema 0015 remains unchanged and 0016 stays allocated to #118.

Combined checkpoint validation passes 750 Node tests, nine worker checks, 75 Node
DB checks and all 175 PostgreSQL tests (150 mandatory predictive cases), including
Relay's assigned-shard verification. Typecheck, full lint, catalog/migration/
readiness and whitespace checks pass; disposable database cleanup completed.

## Versioned publication preparation

The next increment adds `prepareCompressedPublication` and its narrow binary
metadata interface. Complete 2025/2026 player/team assets bind the exact provider,
release tag, `.csv.gz` name/URL, header, evidence kind and unfiltered season scope
to the new `nflverse-gzip-csv-source-qualification-v1` profile. The old plaintext
profile remains unchanged. Historical and preparation-clock research rights
must permit the operation; future capture/release/registration knowledge refuses.
The worker verifies actual wire identity, complete CRC/CSV and claim ordinals,
and returns a detached candidate with a stable versioned request hash.

The result is explicitly `prepared-only`; no file, profile, capture, claim or
codec envelope is persisted. Supplied rights/clock fields do not establish
authoritative database permission. A future atomic writer must recheck the
registered chain and current rights under publication locks, use the database
ingestion clock and seal the complete claim aggregate. The SQL activation plan
and migration dependency are recorded in the integration handoff: proposed
0017 only for raw publication, after Relay freezes its 0016 prefix. No later
number or consumer activation is allocated by this checkpoint.

Validation passes 755 Node tests, 11 real worker checks, typecheck, full lint and
whitespace checks. This preparation-only increment makes no database-path change;
the previous complete schema-15 database gate remains the last DB checkpoint.

## Qualified raw publication activation

0017 implements the publication contract against frozen 0001–0016. Complete
player/team 2025/2026 inputs use the exact versioned gzip profile above and a
private immutable whole-claim seal. Legacy text projection checks, 8,192-row
tables and producer limits are preserved. The new ingestion-count exception is
bounded to 80,000 and requires a complete qualified capture and seal at commit.
Serialized sealed claims have a separate 64 MB ceiling; wire remains 8 MB/file,
with the existing 20 MB unique-wire and 64 MB/160,000-row replay work limits.

The atomic writer validates authoritative rights under publication/table locks,
runs the isolated decoder, writes/rechecks managed binary bytes and records the
complete codec proof, claims and rights audit with database clocks. Published
gzip without the seal refuses at deferred commit. Retries and published replay
verify actual wire and regenerated claims. Rights are checked after SQL row
validation and at commit as well as before bytes. Executed source-deletion scopes
prevent reimport and apply to diagnostic record/read authorization too.

The seal and codec metadata follow authorized capture deletion. Supplemental
digest-only row-count/identity audit is independently reproducible on a fresh
restoration; existing removal queues and exact-address ownership handle bytes.
There is no decoded cache or spool. The integration handoff contains role,
guard-order, retry and lifecycle details.

This activates raw claims only. Gzip cannot enter canonical observations or
legacy normalization by parser-name fallback. Feature/label consumers and dataset
closure must explicitly qualify the new seal in a later coordinated increment.
The selected real proof still needs its licensed source registration, native
evidence and missing 2025 Week 18 participation/absence evidence.

The complete checkpoint passes 757 Node tests, 11 worker checks, 75 Node DB
checks and 197 PostgreSQL tests (172 mandatory predictive cases), typecheck,
full lint, all 18 catalog contracts and generated migration/readiness/whitespace
checks. Frozen 0001–0016 files/contracts are unchanged. Only disposable databases
ran 0017; the service was removed after the gate.
