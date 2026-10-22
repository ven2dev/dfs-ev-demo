# Pipeline workspace extraction (#191)

## Design basis

- Pattern: a private server-side job workspace with explicit source exports,
  declared runtime dependencies and consumer-owned tests. Pipeline depends on
  domain and DB runtime; disposable harnesses depend on DB tooling in development.
- Alternatives: jobs importing the web app couple non-UI work to deployment;
  DB-owned consumer tests reverse the dependency graph; a separate repository
  adds publishing and coordinated releases. Duplicating the shared calendar
  would let web and creator policy disagree, so its existing implementation
  belongs to domain.
- Targets: preserve outputs, CLI arguments, empirical three-statement/two-rights
  budget, all 34 frozen hashes and readiness contracts; 74 Node DB, 25 PostgreSQL
  and 79 feature-store cases; both DB suites on the standard 512 MiB fixture.
  Root command names and CI remain unchanged. No new performance claim is made.
- Requirement reasons: explicit exports prevent private-source coupling;
  one-way dependencies keep infrastructure independent of consumers; test
  inventory comparison prevents dropped cases; repository-wide private-output
  protection prevents creator material leaking into another workspace; unchanged
  ObjectStore, rights, lineage and knowledge clocks preserve evidence integrity.
- Assumptions: Node 24, npm workspaces, one lockfile, local storage and disposable
  databases. No new runtime flow or performance-sensitive redesign is approved.

## Approved roadmap

The owner approved inventory first, behavior preservation and branch/worktree
creation from fresh main. Engineering work is capped at five hours; report and
split remaining scope before exceeding it. Owner/review waiting is separate.
Each step needs commit approval; pushes need fresh consent; the owner merges.

1. Inventory actual ownership/dependencies. Already correctly located files stay
   in place. The [inventory receipt](evidence/pipeline-191/step-1-inventory.json)
   records 90 pipeline files and 51 imports from 27 files into web. It describes
   the target dependency direction, not a completed implementation.
2. Complete package exports/dependencies and remove pipeline's dependency on web.
   Creator-only policies and tests move to pipeline; the pure shared NFL week
   module moves unchanged to domain. Do not retain compatibility re-exports.
3. Prove owner-local integration tests, package boundaries, supported CLI/asset/
   child-process paths and repository-wide private-output/lock protections.
   DB harness imports use DB tooling's public test-support exports.
4. Run the full typecheck/lint/unit/build, inventory, frozen/catalog/readiness
   and both PostgreSQL gates. Retain compact receipts and stop for review.

No SQL behavior changes, frozen migrations, hosted writes, Production, GCS, UI
product integration, deployment or scheduling belong here. Turborepo CI is #192.

## Package ownership

All feature-store source, scripts and integration tests were already correctly
placed, so they do not move. The five creator-only policy modules and their
tests leave web. Their historical calendar uses the shared pure `nflWeek.ts`:
that module and its existing tests move to domain, byte-identical. Web and
pipeline use `@dfs-ev/domain/nfl-week`. This closes a transitive web dependency
without duplicating date arithmetic or introducing a new runtime flow.

`@dfs-ev/pipeline/feature-store/*` exports the existing job, adapter, storage and
governance modules through named subpaths. `@dfs-ev/pipeline/creator/*` exports
the creator policy contracts. There is no broad wildcard/private-source export.
Runtime declares domain, DB, pg and csv-parse. DB tooling is development-only;
existing disposable spike/harness scripts require the development installation.
Production source imports no tooling or test support.

Root commands retain their names and exact node/argument strings. Workspace
commands expose the same creator and three feature-store spike entry points;
their module-relative asset and child paths continue resolving from either cwd.
Full creator browser tests still run in their existing jsdom lane, including the
two review-client suites. Consumer DB tests remain separate from infrastructure.

## Step 2 checkpoint

The [compact package receipt](evidence/pipeline-191/step-2-package.json) records
the public exports and runtime/development split. All 621 creator/calendar
tests and 18 feature-store unit tests pass, including a native Node package
contract. Typecheck, ESLint and 19 existing layout/boundary checks pass.
Discovery preserves all 951 browser and 290 existing Node cases; one Node test
is added to invoke the four native contract checks in CI.

The clean pipeline runtime install adds 27 packages without Next, React or
browser/test tooling. npm retains a link to the development-only DB-tooling
workspace even with `--omit=dev`; its absence is not claimed. Public exports
and the creator argument-refusal path also pass with that link disabled.
No application environment files or private creator data enter the clean export.

Thirteen files relocate: eleven are byte-identical and the historical calendar
source/test change only their shared-domain import. All 21 edited existing
runtime files have identical bodies after removing import declarations. Root
commands, CI and frozen database assets are unchanged. Full build/database
gates remain Step 4; permanent pipeline boundaries and private-path/CLI probes
remain Step 3. Nothing has been pushed.
