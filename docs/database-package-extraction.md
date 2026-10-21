# Database workspace extraction (#190)

## Design basis

- Pattern: private infrastructure workspaces separated by dependency needs.
  `@dfs-ev/db` owns runtime contracts and unchanged SQL/reference assets;
  `@dfs-ev/db-tooling` owns migration/catalog tools and shared test support.
  Tooling depends on runtime; runtime has no dependency on tooling, web or
  pipeline. Web selects runtime only. This follows the infrastructure-package
  pattern while changing the original single-workspace packaging assumption.
- Owner-approved deviation: npm's web-only install selected the driver's
  dependencies even when the single DB package declared them as development
  dependencies or optional peers. The owner approved the two-package split
  before its implementation. Tooling lives at `packages/db/tooling`, explicitly
  listed as a workspace, so assets stay together under `packages/db`.
- Alternatives rejected: one package with driver devDependencies or optional
  peers failed the measured isolation guardrail (394 installed packages,
  including `pg` and `@types/pg`). Undeclared root-only drivers would make tooling
  depend on an accidental root install. Changing web install flags would change
  the agreed Vercel reproduction boundary. Consumer imports into infrastructure
  create cycles; duplicated harnesses let migration, role and cleanup behavior
  drift. A custom affected-file selector remains excluded under #192.
- Targets: preserve all 34 frozen database/readiness artifacts, including every
  proposal, byte for byte; retain 74 required Node DB cases, 25 PostgreSQL cases
  and 79 feature-store cases; both PostgreSQL suites pass on the standard 512 MiB
  fixture. Root npm command names and CLI arguments remain supported;
  `.github/workflows/ci.yml` remains byte-identical.
- Requirement reasons: immutable bytes protect SQL behavior and reproducibility;
  exact inventories prevent silent omissions; target guards and cleanup protect
  fixture isolation; public exports prevent private coupling. Separate dependency
  graphs prevent DB-only drivers and harness dependencies entering web's install.
  One-way imports prevent infrastructure depending on the consumers it supports.
- Assumptions: Node 24, npm workspaces, one lockfile, local PostgreSQL and no new
  query path or speed claim. Full CI remains until #192's selection proof.

## Approved sequence and approvals

The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/190#issuecomment-6322116159)
includes the owner-approved packaging amendment. The estimate remains 4.5
engineering hours with a five-hour cap. Stop and propose a split if discovery
threatens that cap; owner/review waiting is separate.

1. Pin immutable hashes and inventories; establish both workspaces, public
   runtime/assets and tooling/test-support exports, and consumer dependencies.
   Move readiness rules, the exact generated manifest and historical role helper
   here to prove the actual split rather than metadata alone. Prove clean
   web-only installation/build and tooling-only execution before commit approval.
2. Finish ownership extraction: move driver-injected lease SQL to DB runtime;
   keep provider payload types, the driver and refresh orchestration in web.
   Remove the remaining tooling-to-web lease-support imports.
3. Put combined integration inventory/adapters at repository root. Infrastructure
   cases stay DB-owned; consumer scenarios follow their runtime owners. Preserve
   every root command, lifecycle guarantee and exact-case gate. Remove #190
   import exceptions and add reverse-dependency and web-runtime-only negative
   probes, retaining only documented #191 exceptions.
4. Verify the full application/build/command and frozen-artifact checkpoint, plus
   both PostgreSQL suites on the standard 512 MiB fixture. Recheck clean web-only
   installation/build and a real Vercel Preview after an approved push. Commit
   compact receipts; keep full working logs off main.

Readiness and role moves were pulled forward from Step 2 because declarations
alone cannot prove dependency isolation. Lease extraction and root integration
coordination remain separate steps. Every atomic commit needs owner approval;
every push needs fresh consent. The owner merges. Integrate by merges, without
rebases or attribution trailers; no other worktree's branch changes.

## Guardrails and exclusions

Root commands include `test:db:local` and `test:feature-store:db`. Their internal
paths follow relocated files; names and argument behavior stay the same. If a
workflow edit becomes unavoidable, present it as a decision at commit approval
to prevent an incidental CI behavior change.

The web boundary is `@dfs-ev/db/runtime` only, enforced with negative checks.
Repository-level integration adapters provide fixtures to web-owned scenarios,
removing web's temporary test-support imports. Both DB packages reject consumer
imports, and runtime rejects tooling. Step 3 completes these source boundaries;
the package-manifest and clean-install checks also verify dependency isolation.

All proposal SQL stays together unchanged, especially `163_effective_rights.sql`
with the #138 proposals required by dataset reads. No schema, SQL semantics,
rights or model changes belong here. Pipeline extraction remains #191 and
affected CI remains #192. Hosted writes, Production commands, GCS and retired
branch work are excluded.

The owner [assigned two behavior decisions to #95](https://github.com/ven2dev/dfs-ev-demo/issues/95#issuecomment-6322123571):
per-role `statement_timeout` limits (reported as 0 on both databases from #171)
and the migration-runner stop-at-version-N A/B choice. This extraction changes
neither role settings nor runner behavior.

## Step 1 evidence and status

The [baseline receipt](evidence/database-190/baseline.json) pins `c59cff1` before
source edits. The [packaging decision receipt](evidence/database-190/step-1-packaging.json)
is a historical checkpoint: it retains the failed single-package probes and
metadata-only split. Its pending-decision status is superseded by the owner's
approval and the [actual-split receipt](evidence/database-190/step-1-split.json).

Both new clean source exports used Node 24, omitted dependencies, build output
and app environment files, and ran a workspace-only `npm ci` with no root
install. npm, OS and database caches were not flushed. Timings are diagnostic,
not a new performance claim; neither probe opened a database connection.

- Web: 379 packages; `pg`, `@types/pg` and `@dfs-ev/db-tooling` absent. Native Node
  resolves real runtime source through the workspace link without
  `--preserve-symlinks`. Actual web consumers compile in a successful Next build
  with a routes manifest. Neon, TypeScript, Vitest and Node types were already
  independently required by web, so their presence is not DB-tooling leakage.
- Tooling: 103 packages, with Next and the web workspace absent. Migration and
  readiness artifact checks run; all 11 migrations and 12 catalog contracts
  load; the driver and target guard import; 20 existing DB guard cases pass.
- Root checks: typecheck, full ESLint, 7 boundary probes, 13 CI/layout checks,
  runtime workspace typecheck and 13 targeted readiness tests pass. Root/tooling
  artifact commands and malformed-argument refusals agree. All 22 public exports
  resolve through native Node; six private subpaths are refused.
- Parity: 34 immutable artifacts and CI are byte-identical. Existing external
  lockfile versions, resolutions and integrities match; npm only removed the
  development-only classification from 14 records in the newly declared tooling
  driver graph. Root command names/arguments and all test inventories match
  after path normalization. Browser 919, Node 290 and DB 25 cases were collected,
  not executed; the required 74/25/79 contracts are unchanged.

Corrected working attempts remain summarized in the receipts. Full application
and PostgreSQL execution, final boundary enforcement, lease extraction and the
real Preview are later gates. Step 1 was committed with owner approval as
`e1f9568` (`refactor(db): separate runtime assets from database tooling`).


## Step 2 evidence and status

The [lease-extraction receipt](evidence/database-190/step-2-leases.json) records the
driver-injected lease store moving into `@dfs-ev/db/runtime`, with a generic
payload contract. Provider payload types, lazy Neon initialization and refresh
orchestration stay web-owned. Both production and database tests call the same
store. The lease fixtures no longer import web; their #190 boundary exception
has been removed. Web consumers import the DB key contract directly, with no
temporary type re-exports.

All five SQL statements and parameter expressions match the original. Emitted
JavaScript for both the store and refresh orchestrator is byte-identical to the
pre-extraction versions after TypeScript erasure. All 34 frozen artifacts, the
root commands, lockfile, required-case contract and CI workflow stay unchanged.

- Typecheck, the runtime's independent typecheck, full lint, 7 import-boundary
  probes and 13 CI/layout checks pass.
- All 17 affected cache/store/repository tests pass. The complete local database
  command passes: 74 required Node cases, 25 PostgreSQL cases (including the
  13 required lease cases), 12 catalog contracts and template lifecycle probes.
  It uses the standard 512 MiB disposable fixture with no spike override, loads
  no application credentials and removes the container afterwards.
- A fresh web-only install/build passes with 379 packages and no `pg`,
  `@types/pg` or DB tooling installed. A fresh tooling-only install has 103
  packages with neither Next nor web; the actual public lease fixtures import
  and execute an injected read under Vitest without opening a DB connection.
  The 20 isolated tooling guard cases also pass. Caches were not flushed, and
  overlapping diagnostic timings make no new speed claim.

The initial typecheck caught a fixture inferred more narrowly than the web
payload. Generic fixture specialization at the consumer boundary corrected it;
the passing reruns and failure summary are retained in the compact receipt.
Full logs stay off git. Step 2 was committed with owner approval as `3300cc2`
(`refactor(db): move lease store into runtime package`). Its receipt preserves
the preapproval checkpoint status. No push has been approved or performed.

## Step 3 evidence and status

The [coordination receipt](evidence/database-190/step-3-coordination.json) records
the combined DB runner, exact-case inventories and their coordination guards
moving to repository root. Infrastructure fixtures and schema cases remain in
DB tooling. A root integration adapter injects those fixtures into the web-owned
refresh scenario; the scenario has no driver or test-support dependency.

The five coordinator files are byte-identical after explicit path and public
import substitutions. The web scenario's emitted callback is byte-identical
after type erasure. All 34 frozen artifacts, the lockfile and CI workflow remain
byte-identical. Root command names and arguments are unchanged.

- Typecheck, full lint, 10 boundary probes, 13 CI/layout checks and 20 runner
  guards pass. Negative probes enforce web's runtime-only entry point, prohibit
  DB-to-consumer and runtime-to-tooling dependencies, and retain only the
  unchanged #191 transition exceptions.
- The complete local DB command passes: 74 required Node cases, 25 PostgreSQL
  cases, 12 catalog contracts and two template lifecycle cases. The relocated
  startup/recovery command passes all three cases; lifecycle cleanup passes.
  Both real database runs use the standard 512 MiB fixture, load no app
  credentials and remove their disposable container afterwards.
- Dynamic collection matches the baseline exactly: browser 919/68 files, Node
  290/25 files and DB 25/6 files, with only the root adapter's path normalized.
  Browser and Node counts here are collected, not full-suite execution results.
  The initial default static collector miscounted dynamic registrations; the
  receipt records the corrected `--no-staticParse` method.
- Separate clean workspace installs still pass: web builds with 379 packages
  and no `pg`, `@types/pg` or DB tooling; tooling executes with 103 packages and
  no Next or web. Caches remain unflushed; timings are diagnostic only.

Step 3 awaits owner commit approval. Step 4's full application checkpoint,
both PostgreSQL suites (including all 79 feature-store cases), independent
review, separately approved push and real Vercel Preview remain pending.
