# Immutable model and report manifests (#165)

Status: owner-approved roadmap, with server-side work measurement and enrollment
before upload. Step 1 (proposal contract) is ready for commit review; commits require owner
approval per step and push requires fresh consent. Engineering cap: five hours,
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
- **Targets:** five successful client SQL statements, four inside publication;
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
unregistered audit evidence. Observation rows survive an interrupted upload and
stay until committed publication or scoped orphan cleanup; there is no deliberate
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
no hosted command was run and no implementation commit is made at this checkpoint.
