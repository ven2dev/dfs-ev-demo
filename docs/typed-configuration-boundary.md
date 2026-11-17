# Typed application configuration (#99)

## Design basis

- **Pattern:** a server-only typed configuration boundary with capability-scoped
  lazy initialization and immutable, memoized success/refusal results; a separate
  client-safe module retains literal public environment references. This follows
  the [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/99#issuecomment-6931613525)
  and [#97 amendment](https://github.com/ven2dev/dfs-ev-demo/issues/97#issuecomment-6904517703).
- **Alternatives:** eager all-secret validation breaks builds/fixtures; scattered
  getters preserve drift and cached-client bypass; GCSM adds an unselected
  billing/identity/outage dependency. Five separate expected-identity settings
  were rejected: they share the same Vercel environment and copy-error risk,
  add five settings per environment, and duplicate #101's deployed verification.
- **Targets:** one parse per required input per configuration instance, cached
  success and refusal, zero SDK/SQL/network calls on configuration refusal,
  Firebase project agreement before initialization/reuse, and fixture/build
  independence from live secrets. After checkpoint (b), only the two readers
  access app environment inputs, apart from the exact framework guard described
  below. No existing request/SQL/provider budget changes.
- **Requirement reasons:** server-only prevents client imports; literal public
  references preserve Next inlining; capability scope avoids unused credential
  requirements; memoization prevents repeated parsing and per-instance drift;
  verification before reuse prevents ambient SDK state bypassing validation;
  safe errors prevent values/parser causes leaking through logs; no fallback
  prevents choosing another credential, environment or fixtures in Production;
  the pre-migration spike prevents consumers depending on an unproven boundary.
- **Assumptions:** Node 24, Next 16.4.6, Vercel injection, trusted deployment
  administrators and immutable worker configuration. Redeployment replaces a
  worker; mutating its environment is not rotation. Tests create isolated
  configuration instances rather than exposing a production cache-reset API.

## Identity and failure contract

The validated Firebase service account's `project_id` is compared with the
existing `NEXT_PUBLIC_FIREBASE_PROJECT_ID` before `cert()`/`initializeApp()` and
before reusing the named app. A default Firebase app is never selected. After a
reload, `dfs-ev-server` is reused only when its explicit `options.projectId`
matches the verified account. Errors omit both project values. Both values can agree
on an unintended project; #101 verifies the actual deployed resource, IAM and
permissions. There are no new `EXPECTED_*` variables.

Database URL parsing is local and structural. Verifying the intended deployed
host, database and role belongs to #101. That is the approved scope limit, not
a claim of target correctness or a deferred #99 check. Opaque provider/bearer
credentials likewise cannot establish account provenance by parsing.

Missing receiver `CRON_SECRET` maps to sanitized 500; missing
`ODDS_HEALTH_SECRET` maps to 503. Configured receivers retain 401/403 for bad
callers. Database readiness retains 503. Other app configuration failures retain
controlled 500. Checkpoint (b) integrates these mappings; checkpoint (a) changes
no existing route behavior. No store, environment or Production-fixture fallback.

## Checkpoints and measurement

Checkpoint (a), committed as `6fa5d1a`, added isolated modules and synthetic
probes before consumers were migrated. Exported value-free definitions describe names, parsing,
classification and capability/environment requirements without reading values
or initializing clients. Count repeated success/refusal requests, input reads
and parser invocations, and SDK/SQL/network calls. Verify Firebase check ordering,
fixture-mode secret-read refusal traps and a production build with no live
secrets. A required probe miss stops the checkpoint without changing the design
or migrating consumers. A pass stops for owner commit approval.

Checkpoint (b) migrates the 26 former environment reads in 12 consumer files
on main `8da5fa1`, including #286's new startup reader. Shared odds types and
predicates remain client-safe; server routes obtain policy from `serverConfig`.
Catalog source references follow the two readers without retiring discovery.

Firebase Admin initializes `dfs-ev-server` with an explicit verified project ID;
the same named app can survive a configuration reload after its project is
checked again. An absent or mismatched project refuses before any SDK client is
selected. Browser Auth checks its cached app's
public options against `publicConfig` before reuse and retains controlled
unavailability for missing Auth configuration. It preserves the existing default
app identity, so Auth persistence and hot reload keep their current behavior;
unused storage/messaging settings do not become sign-in prerequisites. The
server's named app avoids default-app adoption and duplicate initialization on
reload while refusing an existing named app whose project cannot be verified.
Every cached database adapter return first passes through `serverConfig.database()`.
These checks add no SDK initialization, SQL, provider requests or remote checks.

External SDK/driver messages, causes and configuration fields are omitted before
existing API log calls. Safe diagnostics retain the constructor's class name,
exact SQLSTATE/Firebase code formats and an integer HTTP status (100–599).
Arbitrary instance `name` values are omitted. App-origin errors retain only
repository-relative stack locations, with the full message header and function
labels removed; dependency and unknown compiled-chunk origins omit the stack.
ConfigurationError keeps its fixed message and finite code. Browser Firebase
initialization likewise logs only a fixed message and a validated Firebase code.
Provider network/JSON failures are
normalized at transport exit; HTTP status/quota metadata and request outcome
telemetry remain intact. Unexpected SSE errors use a fixed message; deliberate
quote-validation messages remain unchanged. Missing receiver configuration now
returns the approved cron 500 and odds-health 503; configured receivers retain
their existing bad-caller 401/403 behavior. Sync and active collection validate
database configuration before beginning downloads; health validates policy
before its snapshot query, so known configuration refusals cause no work.

Synthetic integration tests cover the real Firebase/database adapters and
route handlers, cached-app mismatch, verified named-app reuse across reloads, refusal before
side effects, sanitized logging and SSE output, and unchanged operation counts.
Existing provider, cache, collector, readiness and authentication checks remain
in place. Tests that previously changed an environment under a live singleton
now import a fresh module instance between synthetic deployments. The odds
policy tests moved from the shared contract to the executable server owner;
configuration errors assert stable sanitized codes rather than echoed settings.

The migration exposes existing coupling: configuration parsing was spread across
consumers, ambient Firebase state could bypass verification, and route loggers
accepted raw dependency errors. Consolidating the readers and normalizing errors
at the existing log calls addresses those weaknesses. Browser app renaming and
new requirements for unused Firebase settings were removed during review to
preserve Auth persistence and capability scope. #287 enforces the new boundary
so later configuration changes do not recreate the scattered readers.

At this checkpoint, Node 24 qualification passes 1,877 tests with one opt-in live
R2 test skipped. CI gate passes 36 checks, typecheck and clean-snapshot lint pass,
and a production build succeeds without application secrets. A synthetic marker
build scans 81 browser/static artifacts: six server markers are absent while a
public project marker is present. The documented runtime guard excludes Node-only
dependencies from 11 Edge JavaScript files and four source maps. One source map
retains the original guarded instrumentation source; the executable Edge code
omits that guard's imports and log, and its maps contain no Node-only module
sources. A deliberate
client import of `config.server` is rejected by Next's server-only boundary.

[#287](https://github.com/ven2dev/dfs-ev-demo/issues/287) then enforces the boundary
with lint and catalog/schema alignment, replacing generic code discovery while
retaining the other #98 checks. #99 stays open until #287 merges; only the
companion PR closes both. No actual delivery, credential, hosted or Production
operations are part of these implementation checkpoints.

## Framework compiler guard

Preserve `process.env.NEXT_RUNTIME === "nodejs"` inside `register()` in
`apps/web/src/instrumentation.ts` (#286). Next 16.4.6's installed instrumentation
guide documents that form for runtime-specific imports. Its compiler replaces
the literal environment expression with the target runtime, allowing the Edge
bundle to omit Node-only imports. This is compiler state, not a runtime secret
or deployment identity input; it does not go through the server module.

#287's [approved exemption](https://github.com/ven2dev/dfs-ev-demo/issues/287#issuecomment-6935991900)
is limited to that member expression in that guard
in that file/function. Other environment access in the same file remains
restricted, preventing instrumentation from becoming a general boundary bypass.
Moving the guard into the client-safe module adds cross-module constant-folding
dependence without a benefit; routing it through server configuration would
pull a Node-only module into the Edge dependency graph. Preserve the documented
form and prove Node-only code is absent from Edge output with a production build.

After any merge from main, rerun the CI gate and full suite before pushing;
pre-merge results cannot expose integration failures introduced by the merge.
