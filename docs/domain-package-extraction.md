# Domain workspace extraction (#189)

## Design basis

- Pattern: one private TypeScript-source npm workspace with explicit exports.
  Web and pipeline consume `@dfs-ev/domain`; the adapter remains pipeline-side.
  Existing calculations keep one implementation.
- Alternatives: duplicate math invites numeric drift; aliases or relative paths
  into another workspace retain hidden coupling; publishing a separate package
  adds release coordination without a current external consumer.
- Targets: zero numeric/temporal-refusal regressions, including histories longer
  than 16 games; isolated pure kernel; declared consumer dependencies; passing
  root commands, clean web-only install/build and a real Vercel Preview; both
  PostgreSQL suites and unchanged frozen-file/catalog/readiness checks.
- Requirement reasons: explicit exports prevent unsupported deep-import coupling;
  domain-owned contracts remove reverse application dependencies; lint stops
  those dependencies returning; version equality prevents incompatible Next
  internals and duplicate React; unchanged math protects the model contract;
  frozen artifacts preserve database reproducibility.
- Assumptions: Node 24, npm workspaces, one root lockfile, private source packages,
  Next 16 App Router/Turbopack and the standard 512 MiB disposable PostgreSQL.
  Extraction introduces no new hot path or capacity claim.

## Approved steps and ownership

The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/189#issuecomment-6278248472)
sets a 3.5–4 hour estimate and five-engineering-hour cap. Report/split remaining
scope before exceeding the cap; owner and hosted waiting are separate.

1. Prove source-package resolution cheaply in a scratch export: Next compilation,
   native Node workspace-link resolution and a clean web-only install. A real
   Vercel Preview completes deployment proof after an approved push, before merge.
2. Extract the explicit empirical, strict-fitter, devig/consensus and EV exports.
   Move `EVScore` and `PlayerPropDirection` into domain and update web imports
   directly, without compatibility re-exports. A minimal private pipeline
   manifest declares its domain edge; full pipeline extraction remains #191.
3. Enforce the workspace import boundary and the reverse domain-to-app/service
   prohibition with negative probes. Domain has no exceptions. Existing DB and
   pipeline crossings receive exact, ticket-assigned exceptions for #190/#191.
   Strengthen existing shared-version checks while declarations remain duplicated.
4. Run the combined application/build, command, frozen-artifact/catalog/readiness
   and both PostgreSQL gates. Keep compact receipts; obtain independent review.

Each atomic step requires owner commit approval. Every push requires fresh
consent; the owner merges. No frozen SQL changes, hosted database writes,
Production commands, GCS, UI work or evaluation belong to this extraction.

## Step 1: local source-package resolution

The [compact receipt](evidence/domain-189/step-1-resolution.json) describes a fresh
tracked-source export of `13fac53`, scratch package manifests/exports and package
imports in the real web/pipeline consumers. Production code in this worktree is
unchanged at this checkpoint. The temporary prototype and full logs stay off git.

The candidate had no dependencies, build output, app credentials or parent
`node_modules` before installation. `npm ci --workspace @dfs-ev/web` installed
378 packages; no root install was run. Root-only pg, ESLint and Firebase CLI
were absent. Existing installed package versions did not change.

### Next.js

Read the installed `transpilePackages` guide through the app's resolved Next
installation (`apps/web/node_modules/next/dist/docs/`, following npm hoisting).
It says Turbopack transpiles workspace packages automatically. The clean native
web build confirms this with the actual stream route's consensus/EV package
imports: TypeScript and all 16 static pages pass, without `transpilePackages`.
Its 6.886-second elapsed time is diagnostic, not an adapter latency result.

Local success is one gate. A successful real Vercel Preview is also required
before merge because the prior relocation exposed differences between local and
hosted installs. Confirm `apps/web` remains the root and Include files outside
the root directory is enabled, and verify the Preview builds the domain source.
That hosted proof remains pending owner-approved commit/push.

### Node 24

A direct pipeline `.mts` consumer imports all five scratch package exports,
loads the real adapter and runs the existing prototype against synthetic
in-memory replies. The prototype records three statements and two rights checks;
no database is contacted. An invalid adapter request refuses with zero queries.
This is a resolution smoke probe, not fresh database authorization proof.

The first run exposed an extensionless `./devig` import in `consensusDevig.ts`.
Adding `.ts` in scratch fixes native ESM resolution without changing arithmetic;
carry this change into step 2. The existing synthetic projection demo emits
byte-identical output on baseline and prototype.

Node resolves `node_modules/@dfs-ev/domain` to the real source path under
`packages/domain`, outside `node_modules`, where native type stripping works.
The probe checks both the module resolution and filesystem real path, with no
`--preserve-symlinks` flag or inherited Node options. Scripts exclude that flag
to prevent Node attempting unsupported type stripping inside `node_modules`.
An unexported source subpath refuses with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

All 10 existing CI/layout checks pass in the web-only installation, including
34 unchanged frozen database/readiness artifacts. Import enforcement, moved
types, focused regressions and the combined PostgreSQL checkpoint remain later
steps; the scratch proof does not claim those acceptance criteria are complete.

## Dependencies, deployment skipping and next issue

Retain the existing root/web version-equality policy while package ownership is
being extracted. Cover Next, React, ReactDOM and the root-owned `@next/env`
relationship. Exact DB/pipeline exceptions are removed by #190/#191 rather than
opening blanket exemptions. Domain imports neither `apps/*` nor `services/*`.

Turn Skip deployments back on only after the relevant workspace dependencies
are declared and a domain-only change is shown to trigger web deployment. Keep
it off while undeclared crossings or unproven selection remain, to avoid
silently missing shared-source changes. The dashboard step is Vercel project
Settings → Build and Deployment → Root Directory → Skip deployment → Enabled.
This setting is separate from Turborepo's #192 CI task selection. See
[Vercel's requirements](https://vercel.com/docs/monorepos#requirements).

Approved order: #189 → #164 → #190 → #191 → #192, with each branch starting from
fresh main after the preceding issue merges. #191 incorporates and moves #164's
files. Follow the owner's merges-only policy; no rebases.

## Step 2: package exports and consumer imports

`@dfs-ev/domain` is now a private source workspace with no runtime dependencies.
The root export supplies the `EVScore` and `PlayerPropDirection` leaf types;
`/empirical`, `/baseline`, `/devig`, `/consensus-devig` and `/ev` expose the
existing calculations. Source internals are not exported. Web and pipeline
declare the domain dependency and use those exports. Web type consumers import
directly from domain, with no old type definitions or compatibility re-exports.

The pipeline manifest intentionally declares only the domain edge here. Root
runtime/tooling declarations continue supporting its existing jobs until #191
assigns the complete pipeline dependency graph. This is the approved bounded
transition, not a claim that pipeline can already install independently.

Run from the repository root on Node 24:

~~~sh
npm run typecheck --workspace @dfs-ev/domain
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/domain/src
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts packages/domain/tests/projection services/pipeline/tests/feature-store/domainPackage.test.ts
npm run projection:demo
~~~

The standalone domain typecheck uses NodeNext resolution, ES2022 libraries and
`types: []`, so app/Node ambient types cannot hide a source dependency. Explicit
`.ts` imports support native Node ESM. The existing math tests now exercise public
package imports; the pure-kernel parser check remains in place. A pipeline-owned
regression also starts native Node 24 with a clean child environment, checks the
real workspace source path, exercises each runtime export, rejects a private
subpath, loads the adapter and verifies invalid input performs zero SQL queries.

The [step-2 receipt](evidence/domain-189/step-2-extraction.json) records 132
focused passing cases and 10 CI/layout cases, root/domain typechecks and lint.
The original empirical kernel, strict fitter, evaluator and devig are byte
identical. EV and consensus changes are import-only; the synthetic projection
demo output is byte identical. All 34 frozen artifacts retain their hashes.
Code-hash inventories now include the workspace manifests and kernel inputs.

A fresh tracked-source export with the actual extraction installed only web
(378 packages; root-only pg, ESLint and Firebase CLI absent) and built all 16
static pages successfully, without `transpilePackages`. Both domain typecheck
and the existing CI/layout checks pass there too. No installed dependency
versions changed. The initial new subprocess typecheck failure and its explicit
`NODE_ENV=test` correction are retained in the receipt.

The lint boundary and strengthened version probes are step 3. The full combined
gate, including both PostgreSQL suites, is step 4. Hosted Preview/source inclusion
and domain-only deployment selection remain pending; no push or deployment has
been performed at this checkpoint.

## Step 3: import boundaries and dependency versions

The existing ESLint flat configuration now uses `import/no-relative-packages`
across workspace source, tests and scripts, including dynamic imports, require,
re-exports and type-only imports. Public domain exports remain allowed; private
and unknown subpaths are refused. Domain also has a resolved path restriction
against apps/services and explicit package-name/alias checks, with no exceptions.
This uses the installed import plugin and core rules, without a custom graph tool
or new dependency. Next's bundled ESLint guide confirms the flat-config approach.

The import plugin does not visit TypeScript inline `import()` types or
import-equals declarations. Use static `import type` for local/workspace types
so resolved boundary checks apply; external inline types such as `import("pg")`
remain allowed. The report serializer's one local inline type was converted.
Its emitted JavaScript and the projection demo output remain byte identical.

The transition inventory is [eslint.boundary-exceptions.json](../eslint.boundary-exceptions.json):
74 exact importing-file/source pairs across 36 files, individually assigned to
#190 or #191 for removal. Tests check that each pair is still used, works only
from its named file, and does not allow a new destination. Duplicate/stale entries
fail. There is no blanket tests exemption; root orchestration remains root-owned.

`npm run lint` runs the normal lint pass and seven boundary probe cases. The
layout checks enforce matching dependency versions across all current manifests,
the Next/`@next/env` relationship, declared web/pipeline domain edges and the
native Node prohibition on preserve-symlinks. Negative mutations cover Next,
React, ReactDOM, `@next/env`, TypeScript and missing/mismatched domain declarations.
The root/web declarations remain duplicated under this enforced equality policy.

The [step-3 receipt](evidence/domain-189/step-3-boundaries.json) records clean lint,
root/domain typechecks, 7 boundary cases, 12 CI/layout cases and 35 domain/native
consumer regressions, plus 34 unchanged frozen artifacts. It retains the initial
exception-override mistake and its correction. Full logs stay outside git.

The combined PostgreSQL/application/build checkpoint remains step 4. A real
Vercel Preview and domain-only deployment-selection proof remain pending after
an owner-approved push; Skip deployments has not been enabled.

## Step 4: integrated local checkpoint

The [compact integrated receipt](evidence/domain-189/step-4-integrated.json)
records the checks on `ff5671d`. The complete repository suites pass: 909 browser
and 245 Node tests, seven boundary probes, 12 CI/layout cases, both typechecks,
lint, build, local built-app smoke checks, demo Firestore rules and the critical
production-dependency audit (zero vulnerabilities). These are cumulative repo
tests, not tests newly introduced by #189. Build generates all 16 static pages.

The CI database sequence passes on fresh standard 512 MiB PostgreSQL: 20 guard
cases, the lifecycle recovery case, two template prerequisites, 74 Node database
cases, 12 catalog contracts, 25 PostgreSQL behavior tests and 77 feature-store
PostgreSQL tests. Required lease/readiness/corpus case contracts also pass. No
suite is filtered, skipped or cancelled; the disposable service is removed.
All 34 frozen artifacts match their original hashes, including all 11 migrations.
The entire database tree, readiness manifest and CI workflow remain unchanged.

This checkpoint needed no source fix. The validation runner initially applied
the Preview environment to unit tests that deliberately simulate live mode;
removing that override restored the normal CI boundary. An unsupported creator
`--help` probe also refused as the existing CLI specifies. Its documented
missing-argument refusal passes, as do the full creator regressions. Both probe
mistakes are retained in the receipt. Full logs remain outside git.

### Review handoff and remaining deployment gates

Review `13fac53..ff5671d` for the implementation; the final checkpoint adds only
this documentation and its receipt. Start with the package dependency direction
and explicit exports, then unchanged math/refusals, boundary negative probes and
the exact #190/#191 exception inventory. Step 2 independently proved a clean
web-only installation/build; this integrated run proves the combined repository
checks. No model evaluation or capacity claim is added.

The owner approved the checkpoint commit, push and PR publication. Independent
review and a real Vercel Preview remain required before merge:
Root Directory `apps/web`, outside-root source inclusion enabled, and successful
compilation of the domain source. Verify that a domain-only change triggers a
web deployment before enabling Skip deployments, and leave it disabled while
the remaining DB/pipeline dependency graph is incomplete. Hosted success is
not inferred from the passing local build. No Production deployment is part of
this issue. #164 follows once #189 merges.
