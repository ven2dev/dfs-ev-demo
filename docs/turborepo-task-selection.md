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
| `@dfs-ev/pipeline` | Existing browser and Node pipeline tests | `test:feature-store:db` delegates to the existing root command |

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

1. **Graph and executable guards (current):** pin Turbo, declare package tasks,
   prove the matrix under Node 24, preserve unit coverage and record compact
   evidence. Stop for the owner's Step 1 commit approval. CI is unchanged here.
2. **CI adoption:** supply full history and explicit event base/head; run the
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
