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
