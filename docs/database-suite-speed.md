# DB integration suite speed (#153)

The suite prepares one verified chain of migration-prefix templates per run,
then clones a fresh database for each ordinary integration fixture. Raw
migration proofs retain empty scratch databases and execute the migration
behavior they assert. No application schema or ordered migration is changed.

## Design basis

**Pattern:** migrate once into a run-owned builder, take quiescent snapshots of
verified prefixes, seal them against connections, and clone isolated databases
from those snapshots. The parent owns the snapshots and the private resource
registry. This is the template-database integration-fixture pattern approved on
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

**Requirement reasons:** registered random run-owned names prevent touching the
primary or unrelated databases; strict loopback/throwaway credential guards
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

A private clone registration is written before CREATE so that an interrupted
child remains discoverable even when it did not receive CREATE's response.
Successful fixture cleanup removes its registration. Parent cleanup invalidates
the manifest, reaps remaining registered clones, drops only run-owned snapshots,
and closes its admin connection. An invalid registration cannot grant cleanup
rights over the primary database; other known resources are still cleaned and
the error is surfaced. SIGINT/SIGTERM cancels a partial build and waits for the
sequential child to stop before parent cleanup. An idle admin connection loss
also stops the child; cleanup reconnects through the same guarded target and
still fails the run rather than retrying setup. Forced process/machine death
still needs the existing disposable-service teardown.

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
replay. Files still execute serially in A; no CI workflow or selection rule is
changed. There are no profiling `any` annotations or lint suppressions.

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

## Approval checkpoints

A and B are two commit steps on the existing #153 branch, with a three-hour cap
each; no new issues. A stops with a validated reviewable diff for owner commit
approval and owner-run Codex review. B then balances independent scratch files,
overlaps the independent lanes, sizes workers from `os.availableParallelism()`,
and obtains three consecutive CI runs under the revised median/ceiling target.
Each commit needs owner approval, each push fresh consent, and nothing merges
from the agent. New scope beyond a cap is a new owner decision.
