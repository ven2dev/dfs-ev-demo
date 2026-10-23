# Turborepo task selection (#192)

## Design basis

- **Pattern:** an affected-task runner over the declared npm workspace graph.
  Turborepo owns Git change classification, lockfile interpretation and dependency
  traversal. A small runner validates history and the returned plan; it does not
  inspect imports, classify changed paths or reconstruct dependencies.
- **Alternatives:** the parked #140/#141 custom selector missed loaders and
  shared inputs, so none of it is ported. Running all integrations for every UI
  edit would forfeit the selection target. Nx is viable but adds machinery beyond
  this repository's chosen Turborepo approach.
- **Targets:** UI-only changes select zero executable tasks from either DB
  suite; domain changes select domain, web and pipeline tests; DB and pipeline
  changes select affected integrations. Docs/runbooks and root/config/toolchain/
  lock/workflow changes select full work or refuse visibly. Main and integration
  checkpoints retain full checks. There is no invented wall-clock threshold.
- **Requirement reasons:** explicit complete Git history prevents incomplete
  change sets; source/head equality prevents testing a different checkout;
  conservative shared-input handling prevents silent omissions. Uncached tasks
  prove present behavior. Serial execution prevents shared-port/container races.
  The required aggregate check prevents a skip, failure or cancellation from
  passing as successful validation.
- **Assumptions:** Node 24, npm, one root lockfile and the five extracted private
  workspaces; the existing standard disposable PostgreSQL fixture. CI owns
  fixture provisioning and always-run cleanup. No remote cache, hosted DB write,
  Production command or model/data behavior change is introduced.

Initial adoption disables caching for **all** tasks, including unit tests and
builds, because affected selection does not require a cache rollout. This avoids
claiming a sound environment/output cache contract before proving one. Database,
lifecycle and mutation tasks retain explicit `cache: false` and no outputs.
Unregistered job commands cannot be invoked through Turbo accidentally; adding
one requires an explicit uncached task declaration. Root npm commands continue
to execute their existing implementations and preserve CLI argument forwarding.

## Task and package ownership

| Workspace | Unit-test entry | Integration entry |
| --- | --- | --- |
| `@dfs-ev/web` | Existing browser and server tests | Existing root DB runner owns app/DB integration |
| `@dfs-ev/domain` | Existing browser math tests and Node projection tests | None |
| `@dfs-ev/db` | Existing root DB harness unit checks | None |
| `@dfs-ev/db-tooling` | Existing tooling unit checks | `test:db:local` delegates to the complete protected root runner |
| `@dfs-ev/pipeline` | Existing browser and Node pipeline tests | `test:db:local` selects the ordinary suite containing creator integration; `test:feature-store:db` selects the separate feature-store suite |

Workspace test/tooling commands first change to the repository root, preserving
the existing root-based test configuration and child-process assumptions.
`test` deliberately has no `^test` prerequisite: a UI-only edit does not force
dependency-package tests or integrations. Dependency expansion comes from
Turbo's affected-package graph. Build/typecheck retain their conventional
upstream task edges; the existing root build/typecheck commands remain intact.

The ordinary DB runner still owns its full catalog, 74 required Node cases and
25 PostgreSQL cases, including creator/app integration; it is not replaced with
an incomplete raw Vitest command. The separate feature-store suite retains its
79 cases. CI adoption will keep those two suites sequential with their existing
target guard and cleanup. These are preservation requirements, not new Step 1
database-execution claims.

## History and conservative fallback

Use full `TURBO_BASE_SHA` and `TURBO_HEAD_SHA` values. The runner refuses missing,
implicit, unavailable or shallow history and refuses a head that differs from
the checked-out commit. Turbo receives the explicit `...[BASE...HEAD]` filter.
No dependency analysis is performed in the wrapper; its Git operations validate
checkout metadata and commit existence only.

Turbo's `//` root-package marker means a shared or unowned change. The runner
then asks Turbo for the complete unfiltered graph, even when another changed
package has executable work. This covers unknown inputs mixed with UI changes
and lockfile edits that Turbo considers semantically unchanged. Root dependencies
on DB infrastructure also make DB changes conservatively repository-wide.

Turbo dry runs include `<NONEXISTENT>` transit nodes for tasks that have no
package script. They are not executable coverage. `TURBO_ALLOW_EMPTY=1` permits
an explicitly intentional empty executable set, such as UI-only DB work or an
unchanged range; it cannot bypass the root/shared fallback. Malformed plans and
Turbo errors refuse visibly. The wrapper accepts task names and task arguments
after `--`; caller-supplied Turbo override flags are refused to protect the plan.

Every invocation prints `TURBO_SELECTION` with its base/head, selection mode,
packages, executable task IDs and cache policy. Execution propagates task failure
and runs serially. Fixture setup/cleanup remains the responsibility of the
invoking CI sequence; do not infer a new lifecycle from a bare workspace alias.

## Step 1 evidence and reproduction

The [compact receipt](evidence/turborepo-192/step-1-graph.json) records explicit
base/head SHAs, selected task IDs, verdicts and cache state. Full logs remain off
main. The committed matrix test creates a disposable Git repository using the
actual manifests, dependency declarations, lockfile, Turbo configuration and
runner. It replaces task bodies with execution markers, so it proves selection
and exit propagation without creating a database or running mutation commands.
The real workspace test commands are checked separately.

With Node 24 and a full root install:

```sh
npm run test:turbo-layout
npm run test --workspaces
npm run test:ci-gate
npm run test:import-boundaries
```

Set `TURBO_MATRIX_RECEIPT` to an off-repository file to retain a fresh compact
matrix receipt. Each disposable run has its own Git identities; the receipt
records them rather than depending on implicit refs. The matrix covers UI,
domain, proposals, pipeline, runbooks, root config, toolchain, workflow, lockfile,
dependency changes, unknown inputs and mixed unknown/UI edits. Negative probes
cover shallow/missing/implicit/unavailable history, source mismatch, deliberate
empty selection, override flags and selected-task failure.

The probes found and corrected three adoption hazards: unknown edits mixed with
known work, nonexecutable transit nodes mistaken for coverage, and an initial
workspace command that omitted the 30 browser math tests. The final inventory
and real execution checks are recorded in the receipt; earlier failures are
summarized there rather than discarded.

## Atomic adoption stops and remaining gates

1. **Graph and executable guards (committed `00592be`):** pin Turbo, declare package tasks,
   prove the matrix under Node 24, preserve unit coverage and record compact
   evidence. Owner-approved Step 1 was committed before CI edits; its receipt records that unchanged-workflow boundary.
2. **CI adoption (committed `bad427c`):** supply full history and explicit event base/head; run the
   selection proof in hosted Node 24 CI; preserve full checks on main and at
   integration checkpoints. Keep root command names, CodeQL protection, serial
   fixture ownership and always-run cleanup. Stop for commit approval.
3. **Required-gate proof:** distinguish deliberate empty selections from skipped,
   failed, cancelled, missing or malformed results. Preserve the required `CI`
   check name and demonstrate negative outcomes before adoption approval. Stop
   for commit approval.
4. **Combined checkpoint:** full application/build, migration/catalog/readiness
   and both DB suites; confirm root CLI behavior, compact receipts and hosted
   matrix parity after an approved push. Independent review and fresh push/PR
   consent remain separate from merge approval.

The issue remains capped at five engineering hours; review/approval waiting is
reported separately. If discovery exceeds that cap, stop and split remaining
work. Hosted reproduction and full integration checks remain pending at Step 1;
local matrix success does not authorize CI adoption or merge.

References: [Turborepo task filtering](https://turborepo.dev/docs/reference/run),
[global inputs](https://turborepo.dev/docs/reference/configuration#globaldependencies),
and the version-pinned documentation shipped in `node_modules/turbo/docs/`.

## Step 2 CI wiring

Both upstream jobs always start. Step 2 preserved the original required `CI`
job; Step 3 adds the execution accounting below. Both versions require
`App checks` and `DB integration` to finish successfully; a skipped or cancelled
upstream job cannot pass. CodeQL's workflow is untouched.

For PRs, both checkouts fetch full history. The selection range is the explicit
PR target SHA through `github.sha`, the merge commit that GitHub checks out for
`pull_request`. This tests the integrated tree without confusing it with the
PR source SHA. A disposable merge probe advances the target with a domain edit,
merges a UI-only PR, and verifies that only web tests are selected against that
target base. [GitHub's event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
defines this merge-commit checkout contract.

Main pushes and `workflow_dispatch` integration checkpoints set
`TURBO_FORCE_FULL=1`. Even an unchanged/UI-only range then runs all requested
work. Full mode still validates complete history and checkout identity; it is
not a bypass for missing source. PR typecheck, lint, CI/layout guards, Firestore
rules, web build and dependency audit remain full. Only package unit tests and
the two expensive DB suites use affected selection.

The DB job first runs the affected runner with `TURBO_PLAN_ONLY=1`. It writes a
new, exclusive `TURBO_PLAN_FILE` containing explicit SHAs, task IDs, cache state
and an intentional-empty marker. No task executes during planning. A small
translator validates that exact contract and emits only `db_local`,
`feature_store` and `mode` outputs. It neither examines paths nor walks package
dependencies. Unknown, stale, duplicate, cached or incomplete full plans fail.
The workflow also executes a guard requiring both selection booleans to be
exactly `true` or `false` before any conditional suite; its executable test covers
all 16 valid/invalid output combinations.

The cheap target/bootstrap/report guards always execute. Startup lifecycle tests
run if either DB suite is selected. Ordinary DB integration runs before the
feature-store suite; each retains its existing root command. The feature-store
step still starts the standard 512 MiB fixture with `--env-file /dev/null` and
the public throwaway URL. The outer `always()` cleanup remains mandatory even
when planning or a suite fails. No 2 GiB override or app credentials are loaded.

The full disposable matrix runs in the hosted Node 24 App checks job on every
event and prints a compact JSON receipt to its log. Its inner environments reset
inherited selection flags so a main/manual full run still proves the affected
cases. Local evidence is in the
[Step 2 receipt](evidence/turborepo-192/step-2-ci.json). Actual hosted success is
pending a separately approved push; this local checkpoint does not claim it.

Step 2 was committed with owner approval as `bad427c` before Step 3 began.
It preserved the original success/success aggregate while enforcing explicit
selection before conditional work.

The pipeline also declares an uncached `test:db:local` alias, because its creator
PostgreSQL cases are executed by the protected ordinary runner. Domain and
pipeline edits therefore select both DB suites. The DB tooling and pipeline task
IDs can both request that same ordinary suite; the CI plan translator emits one
boolean, and the workflow runs it once. This is declared consumer ownership, not
an infrastructure dependency on pipeline or a custom dependency traversal.

## Step 3 required-gate execution accounting

The established pattern is an aggregate required check over explicit job outputs
and raw step outcomes. Depending only on successful job conclusions would lose
the distinction between deliberately unselected integrations and selected steps
that did not run. Parsing logs or duplicating Turbo's dependency analysis in the
gate is rejected: logs are not a typed completion contract, and a second graph
would drift. The gate interprets execution metadata only.

`CI` keeps its name, unconditional `always()`, both upstream dependencies, empty
permissions and no checkout. It first requires successful app and DB jobs. It
then requires the Node 24 selection matrix, application tests, DB plan, explicit
selection guard, target guards and outer cleanup to have raw `success` outcomes.
GitHub distinguishes a step's raw `outcome` from its conclusion after
`continue-on-error`; checking the former prevents a suppressed failure from
passing. [GitHub's context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#steps-context)
and [job-output contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs)
define these fields. Missing outputs resolve to empty strings and fail the gate.

The application test step publishes `mode=full|affected` and
`work=executed|intentional-empty` only after successful work. Full root `npm test`
publishes full/executed after its unchanged command succeeds. The affected
runner publishes after Turbo exits successfully, or after explicitly validating
an empty selection; plan-only invocations and failed tasks publish no completion.
An empty app selection still requires a successful test step and matrix.

For each DB suite, exactly `true` requires raw `success`; exactly `false`
requires raw `skipped`. The lifecycle step requires success if either suite is
selected and skipped otherwise. An unexpected execution is rejected too. Cleanup
is required even for an empty DB selection, because failed planning or partial
setup may otherwise leave disposable state behind. Full DB mode requires both
suites; main and manual integration checkpoints require full app and DB modes.
Missing, malformed, unknown, failed or cancelled metadata cannot mean no work.

The executable gate tests run the actual inline Bash across all 16 job-result
pairs, every DB selection/suite/lifecycle outcome combination, explicit empty
selections, missing/unknown outputs, raw failures with successful jobs and
incomplete full checkpoints. The disposable Turbo matrix checks real completion
outputs for selected execution, intentional empty work, planning and failures.
Its child environments isolate `GITHUB_OUTPUT` so scratch probes cannot emit
completion metadata for the hosted matrix step itself.

The [Step 3 receipt](evidence/turborepo-192/step-3-gate.json) records the local
proof boundary and hashes. It does not simulate GitHub's orchestration: hosted
Node 24 reproduction remains a required gate after a separately approved push.
Stop for owner commit approval before the combined Step 4 checkpoint.
