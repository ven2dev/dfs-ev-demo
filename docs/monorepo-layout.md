# Monorepo relocation (#148)

## Design basis

- Pattern: incremental npm-workspaces migration. Physical moves and path repairs
  precede explicit package exports and Turborepo affected selection.
- Alternatives: separate repositories add publishing and coordinated-release
  overhead; one package cannot supply the sharing and test-selection boundaries.
  Nx is viable but adds machinery beyond the chosen Turborepo direction.
- Targets: unchanged frozen migration hashes, catalog/readiness history and test
  coverage; working root npm commands; both PostgreSQL suites green on the
  standard 512 MiB fixture; verified Preview and post-merge Production deployment.
- Requirement reasons: immutable SQL prevents historical drift; owner-local
  integration tests prevent package cycles; root commands preserve operational
  entry points; full CI remains enabled until task selection has its own proof.
- Assumptions: Node 24, npm, one lockfile, Vercel web hosting and disposable local
  PostgreSQL. This relocation makes no model, rights, SQL or latency claim.

## Approved scope and sequence

The [owner-approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/148#issuecomment-6260736589)
limits #148 to physical relocation, a minimal workspace/install shell and the
Vercel cutover. Each issue has a five-hour engineering cap; report and split an
overrun. Owner review/deployment waiting time is recorded separately.

| Issue | Scope |
| --- | --- |
| #148 | Physical relocation and Vercel cutover |
| #189 | Domain exports and leaf types |
| #190 | Database tooling and one-way test-support exports |
| #191 | Pipeline/creator package APIs and job entry points |
| #192 | Cheap task-graph proof, then Turborepo affected CI |

#164 follows this sequence on the model track. Package extraction and affected
selection are not completion claims for the relocation PR. Temporary source
imports and the shared root test/typecheck harness remain until extraction.

| Destination | Ownership |
| --- | --- |
| apps/web | Next app, UI, routes, app configuration and public assets |
| packages/domain | Independently movable existing pure probability/devig/EV math |
| packages/db | Frozen schema/migrations, catalogs, proposals, tooling, infrastructure tests |
| services/pipeline | Feature-store/creator jobs and their integration tests |

Consumer integration tests follow the runtime they exercise. All proposal SQL
stays together, especially 163_effective_rights.sql with the #138 proposals.

## Baseline checkpoint

The fresh worktree is on feature/dfsEV-148-monorepo-layout at
3b9d946cd57054803d1af892d62dd4413d82d43a. No other worktree's branch changed. The owner-approved code freeze
began before relocation: other sessions open no code branches until this PR
merges. File relocation has not started at this checkpoint.

The [compact baseline receipt](evidence/monorepo-148/baseline.json) records exact
hashes for every database asset and the generated runtime readiness manifest,
the root command inventory and collected test names. Full inventories/logs stay
off git; the baseline commit makes them reproducible.

- Locked dependency installation passes on Node 24.18.1; the lockfile is unchanged.
- Browser collection: 908 named cases in 68 files.
- Node collection: 243 named cases in 23 files.
- PostgreSQL/Vitest collection: 25 named cases in 6 files.
- The reviewed DB contract retains 74 Node cases and the
  13 lease, 4 readiness and 8 corpus cases. These are inventories, not new passes.
- Feature-store AST discovery records 77 literal test/probe names;
  this includes parent tests and is not a claim about executed test count.
- GitHub reports a successful Production deployment for the baseline SHA.
  Dashboard settings and runtime health have not been verified in this step.

Reproduce collection with Node 24 and npm ci, then run each configuration:

~~~sh
node node_modules/vitest/vitest.mjs list --config vitest.config.ts --no-staticParse --json=/tmp/148-browser.json
node node_modules/vitest/vitest.mjs list --config vitest.node.config.ts --no-staticParse --json=/tmp/148-node.json
node node_modules/vitest/vitest.mjs list --config vitest.db.config.mts --no-staticParse --json=/tmp/148-db.json
~~~

Normalize each collection to repository-relative file/name pairs, sort by its
JSON representation and hash JSON.stringify of the array. Retain multiplicity
when comparing names after applying the explicit old-to-new path mapping; a
set alone would miss duplicate tests. Full DB execution waits for the integrated
relocation checkpoint; this baseline changes documentation only.

## Relocation verification

Preserve root command arguments and environment loading with harmless sentinel
checks. Do not copy credential files, to prevent cross-environment disclosure.
Recheck SQL loaders, subprocess/asset paths, generated attributes/ignores and
code-hash lists. Creator private-output checks keep protecting the whole repo,
including sibling workspaces. Resolve installed Next documentation from
apps/web/node_modules/next/dist/docs, following the resolved package if hoisted.

After moves, run install/typecheck/lint/application tests/Firestore rules/build,
CI/runner gates, migration/catalog/readiness and both PostgreSQL suites on the
standard 512 MiB fixture. Compare complete test inventories and unchanged SQL
bytes. Keep compact receipts; independent review precedes merge.

## Vercel cutover and rollback

After independent review, local checks and an approved push, pause unrelated
deployments because the root setting is project-wide. Record actual old root,
install/build settings and the previous live deployment as the rollback point.

The owner sets project dfs-ev-demo: Settings → Build and Deployment → Root
Directory → apps/web → Save. Verify shared-source inclusion, workspace install
from the root lockfile, Node 24 and Preview/Production environment separation.
Trigger a fresh Preview for the candidate SHA after the setting is saved.

Preserve Deployment Protection. Generated PR hosts support signed-out fixture
checks; authenticated smoke uses the already-authorized stable Preview hostname.
Verify safe pages/routes/assets/manifest without collecting provider data or
mutating hosted databases. Preview and CI pass before owner merge. The owner
controls Production deployment; verify the merge SHA and safe read-only behavior
afterward before recording Production success. No agent Production deploy command
is included.

If Preview fails, leave main unmerged; restore the previous root setting when
abandoning cutover. If Production fails, the owner rolls back the previous built
deployment. Restore the old root before rebuilding old-layout source; mismatched
source and root settings otherwise break deployment.

See [Vercel build settings](https://vercel.com/docs/builds/configure-a-build),
[monorepo guidance](https://vercel.com/docs/monorepos/monorepo-faq) and the
[existing Preview isolation contract](preview-environment.md).
