# Immutable model and report manifests (#165)

Status: the four initial steps were approved and committed through `967f337`.
Review corrections cover shared-report deletion, retry grace and orphan recovery
retirement, plus descriptor-based get-or-create. They remain uncommitted pending owner approval. Evidence explicitly
distinguishes the original implementation from the corrected sources.
Descriptor-based get-or-create is owner-approved. Push requires fresh consent.

The review correction makes #164 failure cleanup take the shared address lock
and check committed model references on a separate writer connection before
unlinking a newly staged report. Report readers receive no model-artifact grant.
Absent-address retries renew their cleanup grace before upload. Tests cover a
#165 commit between #164 staging and failure, an actual cleanup lock wait, and a
sweep between retry upload and publication. The owner-approved recovery policy
retains absent-object observations for a configurable retirement window from
last enrollment, defaulting to 24 hours. Registered model/report addresses drive
the sweep, including those with no object yet.

## Design basis

- **Pattern:** immutable versioned artifact registry, upload first followed by
  short transactional publication. Reuse ObjectStore and the common PostgreSQL
  writer address lock. Run/dataset/artifact associations are per publication.
  Orphan recovery uses a GC grace period much longer than maximum expected
  operation duration: 24-hour record retirement versus 300-second sweep grace.
  A unique descriptor SHA-256 is the publication's natural idempotency key;
  get-or-create returns the original immutable run on an identical retry.
- **Alternatives:** uploads or byte hashing inside publication prolong lock
  holds; caller-written provenance permits forged identities; per-example
  artifact lineage repeats the retired evidence graph. Namespace-wide audit
  cleanup can remove private #164 evidence, so use scoped enrollment in the
  existing orphan-observation table instead of another staging registry.
  Fencing plus bounded upload lifetime is rejected because ObjectStore lacks
  conditional-write support and #172 is blocked. Infinite recovery records are
  rejected because failed attempts otherwise accumulate without a bound.
  A caller-supplied idempotency key is rejected because callers would have to
  preserve another identity for the same immutable descriptor. Allowing duplicate
  runs is rejected because a lost COMMIT acknowledgement would create duplicate
  registry records and ambiguous provenance for downstream governance.
- **Targets:** five successful publication-boundary client SQL statements, four inside publication;
  one metadata-only HEAD per published object inside the transaction, zero byte
  reads/hashes there and no per-example SQL/verification. Three preflight HEADs
  are outside the transaction for descriptor + two reports. All uploads finish
  before BEGIN. Publication BEGIN-to-COMMIT p95 and every ABBA block's slowest
  candidate are <=70% of the interleaved dataset baseline p95 / block's fastest
  baseline on the same 512 MiB PostgreSQL fixture. End-to-end time is informational.
  Every ABBA block includes one create and one reuse of that descriptor so the
  reuse path cannot conceal slower first-publication work.
- **Server work:** CI measures transaction-local insert/update/delete counts
  across every `fs138` table, including definer-function DML, and requires exact
  equality for matching publication shapes guarding 0 and 2,504 examples.
  One-dataset publication inserts 1 run, 1 dataset pin, 2 artifact rows and
  removes 2 pre-upload observations for new objects. Enrollment inserts its 2
  rows separately. Zero writes to example/membership/source tables. This row
  budget measures writes; source review checks the no-per-example-read premise.
  Reusing an existing descriptor writes zero rows at both fixture sizes.
- **Requirement reasons:** version/hash pins prevent silent provenance changes;
  DB clocks prevent false historical-availability claims; current input rights
  and status checks refuse withdrawn inputs; short lock holds avoid delaying
  the cleaner and other publishers; client and server counts expose hidden work;
  pipeline-only grants prevent consumer access before #166 provides governance.
  Renewed enrollment prevents retry starvation; retaining absent records through
  the retirement window covers late PUTs; expiring them bounds recovery metadata.
  The rights guard precedes get-or-create so a refused caller cannot receive an
  existing run; preserving the first run's clock and receipt avoids rewriting
  publication history. Existing identity and exact file pins are compared on
  reuse so a conflicting descriptor claim fails closed.
- **Assumptions:** trusted pipeline/database owner, one authoritative DB per
  ObjectStore root, local private research and immutable snapshots. No calibrated
  product or population-completeness claim. The empirical baseline has an
  algorithm descriptor rather than trained weights. Strict PIT and retrospective
  reconstruction keep distinct dataset pins and actual knowledge clocks.
  PUTs complete within the recovery window under normal operation. This is an
  operational assumption, not an enforced upload deadline: a PUT finishing after
  record retirement can leave bytes outside this cleanup's scope. Recovery uses
  one row per enrolled address from a failed attempt, coalesced on retry and held
  through the retirement window; a three-object attempt enrolls at most three.

## Approved sequence

1. Proposal SQL, immutable registry/role/clock contracts and behavior/work tests.
2. Trusted descriptor/report orchestration using existing #164 scoring/envelopes.
3. Address/orphan integration, race/failure tests and focused regressions.
4. Final relative benchmark, compact evidence and review documentation.

Only proposal SQL under `packages/db/proposals/` is included; no frozen migration,
hosted write or Production command is authorized by #165. #166 owns dependent
invalidation, mandatory deletion and delivery authorization. No app/read grants
or delivery route are added here, preventing artifacts being served early.

## Publication contract

Exact supported algorithm/policy/adapter/preregistration identities are validated
at the SQL boundary; code includes both Git SHA and implementation-byte SHA-256.
SQL derives full dataset specs, exact file/content hashes, row counts and dataset
knowledge time from the pinned rows. A run can pin one or both supported evidence
modes. It has exactly one descriptor and one report for each pinned mode; each
report references its own pinned dataset. File keys bind namespace, SHA-256 and
size. Caller input has no knowledge-clock parameter. SQL stamps publication time.

`model_runs.descriptor_sha256` is NOT NULL and UNIQUE, derived from the validated
descriptor pin. Publication uses INSERT ON CONFLICT DO NOTHING under the existing
descriptor address lock, then returns either the inserted run or the matching
existing run. SQL exposes `existing_publication`, surfaced by the pipeline as
`existingPublication` (false on create, true on reuse). The stored identity and
exact report/descriptor pins are compared before reuse; a conflicting claim fails.
The first publication's `recorded_at` and rights receipt remain unchanged. Current
rights and dataset/source guards still run before the insert and existing-run
lookup, so a denied retry receives no historical run. There is no no-op UPDATE,
additional caller key or new lock.

The pipeline has SELECT and role-checked EXECUTE only on the new surface. Direct
insert/update/delete and all reader/app access are refused. Definer functions
use fixed search paths and the session login's membership, preventing an owner
session's role switching from being mistaken for a non-pipeline LOGIN proof.
The trusted database owner remains able to administer its database.

HEAD each address before upload; enroll absent addresses in one autocommit call,
then putIfAbsent for all objects. Existing objects are not enrolled, preserving
unregistered audit evidence. Every absent-address retry renews the observation's
clock before upload. Observation rows survive interrupted uploads and orphan
deletion throughout the recovery window; publication clears committed addresses.
This allows a later sweep to reclaim a PUT that finishes inside that window.
All file I/O for uploads happens before the
publication transaction. Inside it, lock source/dataset inputs and sorted object
addresses, check HEAD metadata only, then insert the run, pins and artifacts in
one set-based publication call. The SQL call repeats current input guards so
direct SQL invocation cannot bypass them. Only the trusted pipeline checks bytes;
SQL does not pretend it can inspect external ObjectStore content.

## Measurement basis

The recovered pre-approval spike used the 16 exact #138 wire files and reproduced
2,504 retrospective examples with content hash
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
Strict PIT had zero eligible examples. On the standard fixture it measured
dataset publication p95 91.790 ms and three-artifact transport publication
5.345 ms over six ABBA blocks. The retained reports were 9,290,168 / 306,544 bytes.
OS/DB/file caches were warm and unflushed. This prototype did not prove report
envelope association, preflight enrollment or the new server work budget.

The compact prototype receipt is retained as historical evidence. The final
implementation repeats the relative speed gate below and preserves every trial;
the prototype timings are not used as an implementation pass. The existing dataset transaction's
two byte hashes are a separate drafted issue; this issue leaves that baseline
unchanged so the comparison remains attributable.

Transaction-local table-write counters follow PostgreSQL's continuously updated
[transaction statistics views](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-STATS-VIEWS).
Instrumentation queries are measurement overhead and do not enter production
client counts or benchmark timing. Wall-clock assertions stay out of CI because
machine-speed variation would make them unstable.

## Proposal contract and isolation

The proposal and its public SQL asset export add the registry and guarded
publication/enrollment APIs. The pipeline can read and execute, but cannot write
the new tables directly. Reader access is refused. Report slots are bound to the
SQL-owned dataset's evidence mode and copied pins; unsupported identities,
versions, clocks and object addresses fail closed. The guard leaves model/report
observations enrolled until a manifest commits, preserving cleanup after an
abandoned publication.

[SQL evidence](evidence/feature-store-165/step-1-sql.json) records 13 passing
checks, including 15 real reader LOGIN refusals, 10 pipeline mutation refusals,
clock/pin round trips, invalid/withdrawn input cases, post-insert rollback and
revocation during an actual address-lock wait.
The server work vectors for zero and 2,504 actual synthetic dataset members are
identical: enrollment inserts two observations; publication inserts 1 run, 1 pin
and 2 artifacts, deletes 2 observations and touches no example/membership rows.
The guard performs zero writes. Before/after deltas exclude previous session
work. A negative control sees 2,504 updates hidden behind one definer function
call, proving the measurement includes internal database writes.

Package/import checks (19), targeted TypeScript checking, lint, whitespace and
frozen migration artifact checks pass. These SQL-only checks do not establish ObjectStore ordering or
report-envelope validation; step 2 supplies that proof, step 3 supplies sweep/race
checks and step 4 supplies the final speed gate. The [historical transport receipt](evidence/feature-store-165/preapproval-transport.json)
retains all pre-approval timing rows with its limitations. No migration is frozen,
no hosted command was run and step 1 was approved and committed as `3e716cf`.

## Trusted publisher and report preparation

`publishQbModelRun` is the trusted pipeline entry point at
`@dfs-ev/pipeline/feature-store/model-manifests`. A caller supplies a dedicated,
idle writer connection, an ObjectStore, the immutable input-pin artifact and the
current source-byte code identity. The disposable local runner
`services/pipeline/scripts/feature-store/model-publication-run.ts` captures Git
HEAD plus individual source hashes, checks those hashes again after execution,
rebuilds the retained 16-file fixture and writes durable local evidence.

Report preparation reuses #164's `evaluateQbBaseline` and report envelope via
`qbReports.ts`. It checks the exact dataset manifest, file/content hashes, full
spec, row count, coverage artifact, input-pin artifact, supported identities and
preregistration before any publication upload. Input preparation code and current
report/model code have separate identities; a fresh report does not pretend it
was generated by the code that built an older dataset. The descriptor links each
mode's exact dataset, report address, byte count and logical report hash.

`withDatasetRead` now passes SQL-owned metadata to its trusted callback using the
existing manifest query. It retains three preparation queries per dataset and
the final rights/status check. The legacy #164 report wrapper uses the extracted
preparation callback. Failure cleanup now holds the shared address lock and checks
committed model references before deleting new bytes. A separate writer performs
this check, preserving the reader's permissions and the successful path's three
read statements.
The existing dataset publisher's transaction hashing is unchanged. A separate
follow-up issue has been drafted for owner review; it is outside #165.

Preparation performs three SQL reads per selected mode. These precede the
publication boundary: one autocommit enrollment, BEGIN, batched guard, set-based
publication and COMMIT. For both modes, total preparation is six queries and six
object reads (input pins, population ledger, two datasets and two coverage
ledgers). All uploads precede BEGIN. Per-object preflight HEADs establish which
addresses to enroll; one transaction HEAD per object checks metadata under lock.
Actual cryptographic calls are observed in the measurement helper, including
ObjectStore upload verification. No crypto or object byte read occurs inside
the publication transaction.

Failure leaves new objects enrolled for the scoped sweep. The publisher performs
no direct deletion: a retry or unknown COMMIT outcome may share those bytes with
a committed run. A lost connection/COMMIT response withholds the result and tells
the caller to replace the connection. A returned result is a private pipeline
publication receipt; #166 governs any later artifact delivery.

The synthetic CI check uses genuine newly scored report envelopes and 0/2,504
actual PostgreSQL dataset-member rows. Both shapes assert identical operation
counts and ordering. It also covers two-mode publication, reuse, mismatched
inputs before upload, pre-existing unregistered bytes, upload-time revocation,
missing HEAD rollback and interrupted BEGIN. The real local fixture run checks
fresh envelopes and descriptor/SQL associations for the natural 2,504-example
cohort and zero strict PIT examples. Its elapsed times are informational. Step 3 supplies scoped sweep integration
and cleaner/connection-race evidence; the final relative speed gate appears below.

[Step 2 evidence](evidence/feature-store-165/step-2-publication.json) records seven
publication checks, 30 dataset/SQL regression checks, 19 package/import checks
and 41 scorer/ObjectStore unit tests. Targeted TypeScript, ESLint and frozen
migration checks pass. The fresh real fixture records six preparation queries,
five publication statements, three preflight HEADs, three transaction HEADs,
three uploads before BEGIN and zero transaction hashes/object-byte reads.
The 0/2,504-member CI shapes have identical work counts. The real fixture's
21.265 ms publication and 2,030.598 ms end-to-end times are single informational
observations, not a speed-gate result. Fresh report bytes differ from the retained
benchmark files because the envelopes bind fresh exact IDs/code/clocks.

## Scoped orphan cleanup and failure handling

For `models/` and `audits/`, registered addresses are the sweep's work source:
one initial SQL query selects observations, including absent objects. These
namespaces are not listed, so unregistered private reports receive no per-object
SQL or HEAD check. Raw/dataset discovery retains its existing metadata listings.
Each candidate uses the shared address lock and SQL reference/grace recheck.
That locked recheck protects a manifest committed after candidate selection.
No new lock or staging registry is added.

After normal grace (default 300 seconds), a registered object is checked with
metadata-only HEAD. Existing unreferenced bytes are deleted; their observation
remains available for a late PUT. An absent record retires only after the
configured window from its last enrollment. `MODEL_ORPHAN_RETIREMENT_SECONDS`
is the named 24-hour default; the fourth `sweepOrphanObjects` argument overrides
it. The window is positive, at least the deletion grace and at most one year,
preventing invalid/non-finite intervals. SQL rechecks age and committed references
under the address lock before retirement. Successful publication still clears
its observations immediately.

Recovery storage is one row per failed object-upload attempt, coalesced per
address across retries, retained through the retirement window (at most three
rows for one descriptor and both reports). Missing bytes alone do not authorize
early retirement. A PUT finishing inside the window remains reclaimable. A PUT
finishing after retirement falls outside the operational assumption; no fencing
or upload deadline is introduced. The 24-hour GC grace is intentionally much
longer than expected operation duration and the 300-second deletion grace.

The local race suite exercises both outcomes: a cleaner that wins removes bytes
and publication refuses with no rows; a publisher that holds the address lock
blocks the cleaner, whose eventual recheck preserves the committed artifacts.
It also proves pre-upload crash/retry, grace, partial upload cleanup, late-upload
reclamation, shared/unregistered object preservation, rollback after SQL inserts,
wrong HEAD key/digest/size, actual backend termination after insert and actual
cleaner termination after unlink. A committed transaction whose acknowledgement
is withheld returns the connection-replacement error while its referenced bytes
survive cleanup. This last case injects response loss after a real COMMIT; it
does not claim to reproduce a network partition.

Mandatory deletion, dependent invalidation and artifact delivery remain #166.

[Step 3 evidence](evidence/feature-store-165/step-3-orphans.json) records all nine
race/failure scenarios (ten tests including the parent). All 109 feature-store
database tests and 15 public package/import checks pass, including the existing
0/2,504 client/hash/server-write budgets and real LOGIN refusal probes. Targeted
TypeScript, ESLint, whitespace and frozen migration checks pass. SQL and the
publication implementation were unchanged in step 3.


## Original relative benchmark (historical)

The [original benchmark receipt](evidence/feature-store-165/step-4-benchmark.json)
records all 54 timing rows, source/SQL/runner hashes, fixture pins, work counts,
per-block comparisons and the full receipt's ObjectStore address. Six initial
baseline-only samples precede candidate SQL installation. Their p95 is
**109.701 ms**. Each candidate then runs six ABBA blocks (12 samples per arm)
against the unchanged dataset publisher on the same 512 MiB PostgreSQL 18.6
fixture, Node 24.18.1 and retained 16-file cohort. Caches are warm and unflushed.
The runner asserts the `buildDataset` function body equals the recorded baseline
commit `71cdd90`, preserving its two transaction hashes and 2,504 membership
inserts. The fixture reproduces the expected natural content hash and zero strict
PIT examples without backdating knowledge clocks.

| Candidate | Interleaved baseline p95 | Candidate p95 | p95 headroom | Smallest block headroom |
| --- | ---: | ---: | ---: | ---: |
| Exact retained reports + transport descriptor | 114.758 ms | 11.110 ms | 90.32% | 89.48% |
| Actual full publisher + fresh descriptor/reports | 121.948 ms | 13.736 ms | 88.74% | 87.48% |

Both p95 comparisons and all twelve block comparisons pass the approved 30%
headroom gate. The metric is dispatch of BEGIN through the COMMIT response,
a conservative upper bound on the lock hold. The separately recorded interval
from address-lock response through COMMIT is only a client-observed lower bound.

The retained transport arm uses the exact 9,290,168- and 306,544-byte archived
files with the final proposal SQL and protocol. Its archived envelope dataset
IDs differ from the scratch fixture, so this arm proves byte-volume transport
and lock work. Its small orchestration wrapper is benchmark code. The second
series invokes the actual `publishQbModelRun` implementation, scores fresh matching
envelopes, and links them to the real SQL pins. It produced 9,290,167- and
306,544-byte reports; their hashes, logical hashes, dataset IDs and 3,318-byte
descriptor are recorded and verified. No timing claim relies on forged report
provenance or an edited archived envelope.

Every candidate trial has five publication-boundary SQL statements, four inside
the transaction, three preflight HEADs, three uploads before BEGIN, three
transaction HEADs and zero transaction hashing, uploads or object-byte reads.
The full publisher also performs six preparation SQL reads and six object reads;
those occur before publication. Actual crypto observation includes ObjectStore
verification of reused bytes. Server-side DML work remains the exact identical
0/2,504-member vectors proved in CI; row writes do not claim to measure all reads.

End-to-end times are informational: the retained arm ranges 43.747–93.878 ms and
the full publisher 2,041.428–2,337.260 ms. Scoring, disk speed and uploads affect
that duration without holding the shared address lock. No end-to-end deadline
or CI wall-clock assertion is added. These local measurements do not claim
hosted latency, cold cache behavior or concurrent capacity. Actual backend
termination, lock contention and unknown-acknowledgement behavior are covered
separately by the deterministic race suite.

The final source/receipt hashes and every timing comparison were independently
rechecked. Runtime/SQL are unchanged from the 109-test step 3 regression run;
the new benchmark passes targeted TypeScript and lint. Frozen migration artifacts
and whitespace checks pass. Scratch databases, throwaway LOGINs and other fixture
clients were zero after cleanup; the fixture container was stopped.

## Review corrections and corrected-source benchmark

The [correction receipt](evidence/feature-store-165/review-corrections.json)
records 115 passing feature-store database checks, 19 package/path/import checks,
targeted TypeScript/lint and unchanged frozen migrations. Its regression evidence
covers byte-identical #164 staging reused by a committed #165 run before #164
fails, a real cleanup lock wait, a sweep between retry upload and publication,
an absent in-flight PUT followed by completion/reclamation, and absent recovery
records retained at 23 hours and retired at 25 hours. A custom 22-hour window is
also tested. The retirement API has a real reader LOGIN refusal probe.

Model publication now has a separate source identity from #164 input generation.
The disposable identity probe changes a #165-only runtime source, observes an
unchanged #164 identity and a changed model identity, then restores the source.
Both identities and source hashes are recorded in fresh benchmark evidence.
Tests and scripts use ignored `node_modules/.cache/feature-store-165/` instead
of depending on an untracked draft directory. Publisher and cleanup share the
same socket/SQLSTATE interruption classifier, with nine refusal combinations.

The [corrected-source benchmark](evidence/feature-store-165/review-benchmark.json)
repeats all 54 samples on the same 512 MiB PostgreSQL 18.6 / Node 24.18.1 fixture
and exact retained 16-file cohort. Baseline-first p95 is **105.851 ms**. The dataset
publisher's body still matches main `71cdd90`; its transaction hashing remains
the separate follow-up. No target is relaxed.

| Candidate | Dataset p95 | Candidate p95 | p95 headroom | Smallest block headroom |
| --- | ---: | ---: | ---: | ---: |
| Exact retained-report transport | 115.160 ms | 10.257 ms | 91.09% | 89.83% |
| Actual full publisher | 113.362 ms | 12.785 ms | 88.72% | 87.78% |

Each candidate has six creates and six reuses. Every ABBA block uses the preceding
baseline's newly created SQL dataset pin: B1 creates a descriptor and B2 returns
that run with `existingPublication=true`. The full publisher prepares matching
immutable input pins outside timing. Retained transport create/reuse p95 is
10.257 / 6.563 ms; full publisher create/reuse p95 is 12.785 / 11.388 ms. All
twelve pairs return the same run ID within each pair and distinct runs across
blocks, preventing repeated reuse from concealing first-publication costs.

Both p95 gates and all twelve ABBA block comparisons pass 30% headroom. Every
candidate keeps five publication statements, four inside the transaction, three
preflight HEADs, three uploads before BEGIN and three transaction HEADs. There is
no transaction hashing, object-byte read or upload. The 0/2,504-member server DML
vectors and hidden-work negative control still pass; reuse writes zero rows at
both fixture sizes. Exact retained report sizes remain 9,290,168 / 306,544 bytes;
fresh matching retrospective reports are 9,290,166 or 9,290,168 bytes and strict
PIT reports are 306,544 bytes, with a 3,318-byte descriptor. Both fresh report logical
hashes match the original measurement. File hashes and envelope/descriptor/dataset
associations were verified against the corrected source identities.

End-to-end time remains informational: retained transport 37.530–115.785 ms;
full publisher 1,929.923–2,101.527 ms. Local warm-cache and retained-transport
provenance limitations remain the same as the original benchmark. Every timing
sample, per-trial budget and source hash is retained in the new compact receipt;
the full receipt has a separate ObjectStore digest.

The guard deliberately runs before metadata HEADs to hold the shared locks and
again inside final publication to protect direct SQL callers and recheck current
rights after those HEADs. Both calls are included in the measured fixed budget.
Descriptor-based get-or-create also applies after a lost COMMIT acknowledgement:
the retry returns the original run marked as an existing publication. Tests cover
one-row repeat publication, original clock/receipt preservation under a fresh
rights grant, refused retries, conflicting claims and concurrent callers.

## Acceptance mapping

| Requirement | Evidence |
| --- | --- |
| Dataset pins, DB knowledge clock, algorithm/policy/adapter/code, mode and exact object metadata | Step 1 SQL round trip and clock/refusal probes; step 2 fresh report/descriptor/SQL association checks on the real fixture |
| Upload before BEGIN, shared address lock, metadata-only HEAD, no transaction hashing | Step 2 observed SQL/ObjectStore/crypto ordering and fixed budgets at 0/2,504 actual members; final benchmark |
| Real non-pipeline LOGIN cannot publish/modify; no forged clocks or identities | Step 1 actual LOGIN permission probes, direct mutation and unsupported identity refusals |
| Rollback and cleaner races leave no dangling references | Step 3 both lock orders, post-insert rollback, backend termination, lost acknowledgement and late-upload cleanup; step 1 identical server DML vectors plus hidden-work negative control |
| Proposal SQL only and no artifact consumer access | SQL asset in `packages/db/proposals/`, frozen migration checks, no reader/app grants or delivery surface |
| Shared report deletion, renewed retry grace and bounded recovery records | Correction receipt: #164/#165 byte-sharing race, actual cleanup lock wait, sweep after retry upload, in-flight PUT and default/custom-window retirement |
| Descriptor get-or-create with current rights and immutable first publication | Correction receipt: one-run repeats, original clock/receipt preservation, denied retries, concurrent callers, conflicting claims and retry after lost COMMIT response; zero server writes on reuse at 0/2,504 members |

All artifact bytes use the existing private ObjectStore. A publication receipt
is a trusted pipeline result. Current dataset/source authorization is checked
again at publication; subsequent delivery, mandatory deletion and dependent
invalidation are #166. The trusted database and ObjectStore owner remains part
of the threat model. A caller uses a dedicated idle connection so enrollment
commits before uploads and cannot be rolled back with a larger caller transaction.

## Local verification

Use Node 24 and the standard registered disposable PostgreSQL fixture:

```sh
docker compose --env-file /dev/null -f compose.test.yml up -d --wait postgres
npm run test:feature-store:db
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/model-publication-benchmark.ts
```

Supply only the fixture's local `TEST_DATABASE_URL` in a clean environment;
the scratch harness validates the target before creating a database. The benchmark
writes its full receipt to `node_modules/.cache/feature-store-165/165-benchmark.json` by default;
`FS165_BENCHMARK_EVIDENCE` overrides the receipt path and `FS165_RETAINED_ROOT`
overrides the root containing the two pinned report objects. Private fixture
bytes stay under ignored `node_modules/.cache/feature-store-165/`. No hosted credential or
Production command is needed. Wall-clock comparisons run only in this opt-in
script because CI machine-speed variation would make them unstable.
