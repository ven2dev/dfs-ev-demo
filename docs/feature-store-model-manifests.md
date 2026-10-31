# Immutable model and report manifests (#165)

Status: owner-approved roadmap, with server-side work measurement and enrollment
before upload. Steps 1–2 are committed as `3e716cf` and `b67979a`. Step 3 (scoped
orphan cleanup) is in review; commits require owner approval per step and push requires fresh consent. Engineering cap: five hours,
excluding review waiting; split remaining work if discovery exceeds the cap.

## Design basis

- **Pattern:** immutable versioned artifact registry, upload first followed by
  short transactional publication. Reuse ObjectStore and the common PostgreSQL
  writer address lock. Run/dataset/artifact associations are per publication.
- **Alternatives:** uploads or byte hashing inside publication prolong lock
  holds; caller-written provenance permits forged identities; per-example
  artifact lineage repeats the retired evidence graph. Namespace-wide audit
  cleanup can remove private #164 evidence, so use scoped enrollment in the
  existing orphan-observation table instead of another staging registry.
- **Targets:** five successful publication-boundary client SQL statements, four inside publication;
  one metadata-only HEAD per published object inside the transaction, zero byte
  reads/hashes there and no per-example SQL/verification. Three preflight HEADs
  are outside the transaction for descriptor + two reports. All uploads finish
  before BEGIN. Publication BEGIN-to-COMMIT p95 and every ABBA block's slowest
  candidate are <=70% of the interleaved dataset baseline p95 / block's fastest
  baseline on the same 512 MiB PostgreSQL fixture. End-to-end time is informational.
- **Server work:** CI measures transaction-local insert/update/delete counts
  across every `fs138` table, including definer-function DML, and requires exact
  equality for matching publication shapes guarding 0 and 2,504 examples.
  One-dataset publication inserts 1 run, 1 dataset pin, 2 artifact rows and
  removes 2 pre-upload observations for new objects. Enrollment inserts its 2
  rows separately. Zero writes to example/membership/source tables. This row
  budget measures writes; source review checks the no-per-example-read premise.
- **Requirement reasons:** version/hash pins prevent silent provenance changes;
  DB clocks prevent false historical-availability claims; current input rights
  and status checks refuse withdrawn inputs; short lock holds avoid delaying
  the cleaner and other publishers; client and server counts expose hidden work;
  pipeline-only grants prevent consumer access before #166 provides governance.
- **Assumptions:** trusted pipeline/database owner, one authoritative DB per
  ObjectStore root, local private research and immutable snapshots. No calibrated
  product or population-completeness claim. The empirical baseline has an
  algorithm descriptor rather than trained weights. Strict PIT and retrospective
  reconstruction keep distinct dataset pins and actual knowledge clocks.

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

The pipeline has SELECT and role-checked EXECUTE only on the new surface. Direct
insert/update/delete and all reader/app access are refused. Definer functions
use fixed search paths and the session login's membership, preventing an owner
session's role switching from being mistaken for a non-pipeline LOGIN proof.
The trusted database owner remains able to administer its database.

HEAD each address before upload; enroll absent addresses in one autocommit call,
then putIfAbsent for all objects. Existing objects are not enrolled, preserving
unregistered audit evidence. Observation rows survive interrupted uploads and
orphan deletion until committed publication clears them. This allows a later
sweep to reclaim an upload that finishes after an earlier deletion; there is no deliberate
upload-before-enrollment crash leak. All file I/O for uploads happens before the
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

Its compact receipt will accompany final evidence. Final implementation repeats
the relative speed gate, preserving every timing trial, rather than treating the
prototype timings as an implementation pass. The existing dataset transaction's
two byte hashes are a separate drafted issue; this issue leaves that baseline
unchanged so the comparison remains attributable.

Transaction-local table-write counters follow PostgreSQL's continuously updated
[transaction statistics views](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-STATS-VIEWS).
Instrumentation queries are measurement overhead and do not enter production
client counts or benchmark timing. Wall-clock assertions stay out of CI because
machine-speed variation would make them unstable.

## Step 1 review candidate

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
report-envelope validation: those are step 2. Address sweeping and final race/
speed checks follow in steps 3–4. The [historical transport receipt](evidence/feature-store-165/preapproval-transport.json)
retains all pre-approval timing rows with its limitations. No migration is frozen,
no hosted command was run and step 1 was approved and committed as `3e716cf`.

## Step 2 review candidate

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
preparation callback while retaining its staging/failed-new-output behavior.
The existing dataset publisher's transaction hashing is unchanged and has its
own draft issue in `codex-briefs/dataset-publication-hashing-issue.md`.

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
cohort and zero strict PIT examples. Its elapsed times are informational: the
final repeated relative speed gate remains step 4. Scoped sweep integration and
the remaining cleaner/connection-race cases remain step 3.

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

## Step 3 review candidate

The JavaScript orphan sweep now lists all four existing ObjectStore namespaces.
For `models/` and `audits/`, one initial SQL query selects enrolled candidates;
unregistered addresses receive no per-object SQL check. Existing raw/dataset
behavior remains. Each candidate still uses the shared address lock and SQL
reference/grace recheck before deletion. That locked recheck protects a manifest
that commits after candidate selection. No new lock or staging registry is added.

Enrollment survives orphan deletion because an upload begun before cleanup may
finish afterward. Subsequent metadata listing rediscovers those bytes and the
same enrolled address remains eligible. Absent objects cause no per-object SQL
work, even when their observation remains. Successful publication clears its
observations. Keeping this small crash-recovery record avoids an unowned late
upload without introducing leases or byte I/O inside publication.

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
The final repeated relative benchmark and closeout evidence remain step 4.

[Step 3 evidence](evidence/feature-store-165/step-3-orphans.json) records all nine
race/failure scenarios (ten tests including the parent). All 109 feature-store
database tests and 15 public package/import checks pass, including the existing
0/2,504 client/hash/server-write budgets and real LOGIN refusal probes. Targeted
TypeScript, ESLint, whitespace and frozen migration checks pass. SQL and the
publication implementation are unchanged in this step.
