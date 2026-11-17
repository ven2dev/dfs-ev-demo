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
before reusing the boundary-owned app. An unverified global/default Firebase
app is never selected. Errors omit both project values. Both values can agree
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

Checkpoint (a) adds isolated modules and synthetic probes only. No current
consumer imports them. Exported value-free definitions describe names, parsing,
classification and capability/environment requirements without reading values
or initializing clients. Count repeated success/refusal requests, input reads
and parser invocations, and SDK/SQL/network calls. Verify Firebase check ordering,
fixture-mode secret-read refusal traps and a production build with no live
secrets. A required probe miss stops the checkpoint without changing the design
or migrating consumers. A pass stops for owner commit approval.

Checkpoint (b), after that approval, migrates consumers and qualifies real call
paths, cached clients, status changes, redaction and browser/static output.
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

#287's proposed exemption is limited to that member expression in that guard
in that file/function. Other environment access in the same file remains
restricted, preventing instrumentation from becoming a general boundary bypass.
Moving the guard into the client-safe module adds cross-module constant-folding
dependence without a benefit; routing it through server configuration would
pull a Node-only module into the Edge dependency graph. Preserve the documented
form and prove Node-only code is absent from Edge output with a production build.
