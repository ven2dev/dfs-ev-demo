# DB integration suite speed (#153)

The suite prepares one verified chain of migration-prefix templates per run,
then clones a fresh database for each ordinary integration fixture. Raw
migration proofs retain empty scratch databases and execute the migration
behavior they assert. No application schema or ordered migration is changed.

## Design basis

**Pattern:** migrate once into a run-owned builder, take quiescent snapshots of
verified prefixes, seal them against connections, and clone isolated databases
from those snapshots. The parent owns the snapshots and the private resource
registry. A target-wide session advisory lock serializes suite invocations, and
a startup sweep reclaims abandoned fixture databases before any test starts. This is the template-database integration-fixture pattern approved on
[#153](https://github.com/ven2dev/dfs-ev-demo/issues/153).

**Alternatives:**

- Per-test migration replay repeats setup SQL and artifact validation. Initial
  measurement found 37.15 seconds of migration/catalog work plus 9.18 seconds of
  artifact/contract loading across 115 source-claims fixture invocations, and
  10.55 plus 2.33 seconds across 30 predictive fixture invocations.
- Per-file/per-prefix templates were useful for the spike but repeat migration
  SQL across workers/prefixes. The production chain advances each ordered file
  once and preserves each historical ledger prefix without replaying it.
- Shared-schema resets or transaction rollback do not preserve the behavior of
  tests with multiple connections, committed publication, privileges and
  migration upgrades. Each fixture keeps its own database instead.
- CI job sharding duplicates installation/startup and is not pursued under the
  owner's current decision. File balancing, overlapping independent lanes and
  CPU-derived worker limits belong to step B.

**Targets — owner decision, October 17, 2026:** complete `DB integration` job
**median of three consecutive CI runs ≤150 seconds, with no individual run
>180 seconds**. App checks take about 140 seconds, so DB integration should no
longer dominate PR wall time. The ceiling tolerates the measured 118/155-second
runner spread while bounding regressions. This is a critical-path bound, not a
capacity-sizing target: the median plus ceiling replaces the 30% capacity
headroom rule for this issue. No sharding; revisit only if the implemented
median exceeds 150 seconds. The owner recorded this decision in the issue's
[Targets and roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/153#issuecomment-6245176113).

Preserve all 75 existing Node cases, all 136 existing Vitest cases and the
unchanged required-case contracts. Repeat mode runs the whole suite three
times. The deterministic fixture budget is each ordered migration executed once
in template preparation, with one catalog verification per prefix. Explicit
migration, bootstrap and end-to-end persistence proof operations remain under
test and are excluded from that setup budget. New factory regressions exercise
the factory itself separately from preparation of the integration fixtures.

**Requirement reasons:** a session advisory lock prevents concurrent sweeps
from deleting active fixtures; the startup sweep reclaims leftovers even after
SIGKILL or runner termination; literal `dfs_ev_test_` prefix matching and strict
target checks protect the primary and unrelated databases; registered random
run-owned names constrain ordinary teardown; strict loopback/throwaway credential guards
prevent application/hosted access; frozen inputs and source-bound manifests
reject stale fixtures; sealed, disconnected snapshots prevent test mutations of
a shared source; fresh clones prevent cross-test state leakage; historical
prefix snapshots preserve upgrade/idempotency evidence; unchanged case/report
gates prevent coverage loss; pre-creation clone registration lets the parent
reap a child interrupted after CREATE; cleanup failures fail the command rather
than being reported as success.

**Assumptions:** disposable loopback PostgreSQL 18, one suite per fixed Compose
project/port at a time, local create-database privileges, Node 24, private POSIX
temporary directories, and fixed migration/contract inputs for a run. Inputs
are frozen for the invoking process; snapshots are never reused between suite
repetitions. Shared-primary and cluster-role-sensitive tests remain serial.

## A: verified run-scoped template chain

`tests/db/templates.mts` reads and freezes the checked migration inputs and
reviewed catalog contracts. It verifies the connected disposable target before
DDL. An empty run-owned builder advances through the ordered migrations using
the existing migration runner. Every advance enforces `executed === [version]`.
After the client disconnects, PostgreSQL copies the verified prefix into a new
snapshot; a source/run/version marker is recorded and `ALLOW_CONNECTIONS false`
seals it. The builder is removed when the chain is complete.

Only then is a private manifest published with exclusive creation, mode 0600,
under an owner-only run directory. It binds the local endpoint, all unique
ordered prefixes, the run ID and a digest of the validated migration bytes and
catalog fingerprints. A test process checks private filesystem ownership,
permissions and non-symlink files before resolving an opaque template reference.
The scratch harness confirms the source's owner, marker and sealed state before
cloning it. A plausible database name alone cannot grant template access.

Before running any Node, catalog, factory or Vitest checks, the suite opens a
guarded admin session and takes `pg_try_advisory_lock` using namespace 153045
and the primary database OID. A refused acquisition fails immediately with
“another DB test run is active on this target”. The session remains open across
all children and all repeat-mode repetitions. While holding it, startup drops
every database whose name has the literal `dfs_ev_test_` prefix with FORCE,
including sealed snapshots and connected abandoned clones, and logs
`staleDatabasesSwept`. Names are identifier-escaped; `dfs_ev_test` is excluded.
A refused local contender leaves the shared Compose service running only when
startup raises `DatabaseTestRunActiveError` (`DB_TEST_RUN_ACTIVE`). Every other
startup failure, failed Compose up, or lost lock still runs Compose down, as
requested by the owner. A lost lock connection stops the active children and
fails the run.

This is startup reconciliation under an exclusive session lease. Teardown-only
recovery cannot cover SIGKILL or runner termination; age/TTL-based sweeping
could mistake a slow active suite for stale work. The session lock, released by
PostgreSQL on connection loss, establishes when a startup sweep is safe without
adding teardown retries or parent ownership of factory-test databases. All
entry points that use this target need to honor the same lease; other manual
users of the fixed Compose service still require coordination.

A private clone registration is written before CREATE so that an interrupted
child remains discoverable even when it did not receive CREATE's response.
Successful fixture cleanup removes its registration. Parent cleanup invalidates
the manifest, reaps remaining registered clones, drops only run-owned snapshots,
and closes its admin connection. An invalid registration cannot grant cleanup
rights over the primary database; other known resources are still cleaned and
the error is surfaced. SIGINT/SIGTERM cancels a partial build and waits for the
sequential child to stop before parent cleanup. An idle admin connection loss
also stops the child and fails the run. Teardown remains best-effort with no
reconnection or retry; any leftover databases are swept by the next run. Forced
process/machine death is covered by that next-run sweep or disposable-service
teardown.

`withMigratedDatabase` supplies the source-claims, predictive, corpus and
migrated-readiness fixtures. Authentic unversioned/behind readiness fixtures
stay empty. Source-claims, predictive and corpus test declarations are
byte-identical; readiness changes only its fixture calls, with every expect and
matcher expression preserved. Explicit migration calls in upgrade/no-op/reset
cases, the primary bootstrap and the local persistence/archive program remain
unchanged.

The normal runner prepares and owns the chain, passes only its manifest path
to Vitest, reports the deterministic setup counts and cleans up in `finally`.
`test:db`, `test:db:local` and `test:db:repeat` remain the entry points. Migrated
fixtures refuse a missing manifest rather than silently reverting to migration
replay. Step A kept files serial; Step B partitions the same cases as described below. There are no profiling `any` annotations or lint suppressions.

## B: balanced files and overlapping lanes

**Pattern:** fork/join orchestration of independent test lanes, bounded by
`os.availableParallelism()`. This follows the measured spike rather than adding
CI jobs. The serial lane runs the original 75 Node cases, catalog verification,
then primary/bootstrap/lease/readiness/corpus Vitest files. The scratch lane
runs source-claims, source-decisions, source-consumers and predictive files with
independent cloned databases and no primary reset hooks. Corpus role/login
operations remain in the serial lane. Templates and factory regressions finish
before the lanes start, avoiding role-creation races.

Source claims are three stable domain groups: source/binding/unavailable
(39 declarations), canonical facts/witnesses/decisions (31), and consumers (9).
`sourceClaimsSupport.ts` shares the original fixture helpers. All 79 declarations
are byte-identical to the baseline; no generated test files or runtime Git
history are needed. Predictive remains 31 declarations/32 cases.

The allocation reserves `max(1, floor(CPUs / 4))` Node workers, then assigns
`min(3, max(1, CPUs - Node workers))` scratch workers. On four CPUs this gives
one Node plus three scratch workers, matching the hosted feasibility check.
When the Node checks finish, catalog/serial Vitest uses that same lane. On a
single CPU, the two lanes execute consecutively with one worker each. Three is
a measured upper bound for scratch concurrency; it is not a fixed worker count
on smaller runners. Alternatives are serial execution (measured slow),
unbounded workers (CPU contention), and CI job sharding (duplicated startup;
explicitly excluded by the owner).

Every spawned child is tracked. Failure or interruption aborts both lanes; the
parent waits for all children to close before fixture cleanup. Fresh reports
are required from both lanes. Aggregation checks exact file membership,
successful summaries, unique passed case names and complete assertion counts.
The unchanged global named-case validators then gate all 136 Vitest cases.
These checks prevent a successful sibling or stale/partial output from hiding
a dropped, duplicated, skipped or failed case.

The single CI job also runs `test:db:lifecycle`: real startup sweep/held-lock
regressions, followed by an intentional disposable-password authentication
failure that has to remove the service. Only the typed contention error skips
Compose teardown. The main suite then starts with the normal public credentials
in a new disposable service. This verifies the accepted P3 without application
credentials, test skipping, or migration changes.

Final acceptance is still the complete hosted DB-job median ≤150 seconds
across three consecutive runs, with none >180 seconds. Local repeat validation
and committed implementation precede fresh owner consent for a push; no local
timing is substituted for that CI proof. B stops for commit approval before
pushing or starting hosted acceptance runs.

## Evidence and validation

- [Per-test baseline, local comparisons and inventories](evidence/db-suite-speed-spike-2026-10-17/evidence.json).
- [Hosted 4-CPU check](evidence/db-suite-speed-hosted-2026-10-17/evidence.json):
  complete DB jobs passed in 155 and 118 seconds using 3 scratch + 1 Node
  workers. App lint failed only on the disposable prototype's profiling
  annotations. These were feasibility measurements, not final three-run CI
  acceptance evidence.
- Step-A validation is recorded in
  [the A evidence file](evidence/db-suite-speed-A-2026-10-17.json), including
  exact unchanged declaration/assertion hashes, setup counts, guard/integration
  regressions, repeat mode, lint/typecheck/application tests and an actual
  SIGTERM test with an active clone. Local serial-A times are not the final
  hosted target proof.

The startup regression command is `TEST_DATABASE_URL=<public loopback URL>
npm run test:db:startup` against the already-running disposable service, before
starting a suite. It proves stale sealed/connected fixtures are removed on the
next run, other databases survive, and a real concurrent runner is refused
without sweeping or executing tests.

The owner accepted two Step-A review findings concerning interrupted factory
subprocesses and admin loss during cleanup. The follow-up uses startup
reconciliation rather than expanding teardown: [startup-sweep validation](evidence/db-suite-speed-startup-sweep-2026-10-17.json).
The admin-loss regression moved to the startup tests and now proves that failed
teardown leaves snapshots that the next startup removes. The existing factory
regression still proves normal abandoned-clone and malformed-registry cleanup.

Step-B local validation and the remaining hosted acceptance gap are recorded in
[the B evidence file](evidence/db-suite-speed-B-2026-10-18.json). Three final
local repeats passed all 75 Node and 136 Vitest cases. A SIGTERM while both
lanes were active exited 143; the next startup swept two abandoned Node
fixtures, leaving no prefixed databases and preserving the primary. One
earlier attempt failed with a masked cleanup error; its underlying cause was
not reproduced and it is excluded from passing evidence. Diagnostics now
preserve original and cleanup errors together. Hosted acceptance is pending.

## Approval checkpoints

A and B are two commit steps on the existing #153 branch, with a three-hour cap
each; no new issues. A stops with a validated reviewable diff for owner commit
approval and owner-run Codex review. B then balances independent scratch files,
overlaps the independent lanes, sizes workers from `os.availableParallelism()`,
and obtains three consecutive CI runs under the revised median/ceiling target.
Each commit needs owner approval, each push fresh consent, and nothing merges
from the agent. New scope beyond a cap is a new owner decision.
