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

The final web boundary is `@dfs-ev/db/runtime` only, enforced with negative checks
in Step 3. Repository-level integration adapters provide fixtures to web-owned
scenarios, removing web's temporary test-support imports. Step 1 already checks
the package manifests and runtime source graph, including negative dependency
probes; it does not claim the final boundary is complete.

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
real Preview are later gates. Step 1 is ready for owner commit review; no commit
or push is authorized by the architecture approval.
