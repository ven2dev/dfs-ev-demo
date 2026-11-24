# #224 final rollout-preparation roadmap after Q0 — owner approved

2026-11-23. Main basis `68dd11e382104621e808fb099e6574ef848b7eb7`.
The authorized app/mock Q0 passed 20 cases before branch creation or app edits.
The [Q0 receipt](evidence/rollout-224/q0-receipt.json), source manifest and work metrics accompany this roadmap. The owner approved implementation on `feature/dfsEV-224-rollout-preparation`. Retention is [blocking issue #311](https://github.com/ven2dev/dfs-ev-demo/issues/311),
not implementation work inside #224. The [acceptance amendment is posted](https://github.com/ven2dev/dfs-ev-demo/issues/224#issuecomment-7118534988).

## Design basis

**Pattern:** immutable server-only deployment configuration at the existing #99
boundary, requested/effective health projected from existing capability state,
staged observation/enforcement and compatible log-only replacement/drain.
Reuse the paid-leader primitive, HMAC identities, expiry memo and shared cache.
WAF and app modes are independent operational axes, not one service controlling
both. Retain the existing advisory quota floor; no application credit ledger.

**Alternatives:** a mutable flag service adds another availability/consistency
boundary; a DB mode query adds hot-path work; a client-controlled mode is not an
operational authority. Hard-coded enforce-only or immediate deployment skips
rollback/observation. WAF-only cannot provide paid-leader user fairness. None
improves the existing layered pattern at this scale.

**Targets:** preserve 90ms warm pre-provider allocation (cache 10/admission 53/
headroom 27) and hosted p95<=63ms, with #220 as history and actual-app PlanetScale
cutover rehearsal owning the current-path proof. This roadmap proves deterministic
app/mock work, not SQL buffers, DB timing or a new shared runtime deadline timer.
Fixture `224-rollout-two-instances-20-leaders`: one existing admission per eligible
mock leader; zero added mode/health SQL or probes; fresh hits zero verification;
enforce pre-claim <=1 coalesced verification including eventual followers, with
zero new follower SQL. Repeated cached denial adds zero claim/admission/release
statements beyond the existing freshness read.

**Requirement reasons:**

| Rule | Reason |
| --- | --- |
| Server-only enum, absent => log-only, invalid => no enforce and no raw value in health. | Prevent accidental activation and supplied-input disclosure. |
| Use the existing validated boundary/inventory, with no import-time route failure. | Preserve centralized input ownership and public-route availability. |
| Project requested/effective mode from existing state; no health-only probe. | Avoid lying about readiness or adding read amplification. |
| Preserve the existing fail-open/floor/auth/expiry contracts. | Avoid changing availability, stale delivery or identity trust while adding rollout control. |
| Replace/drain enforced instances during rollback, preserving persistent state. | Prevent old denial caches persisting through reachable deployments and avoid reset allowances. |
| WAF is a written draft; no unconsumed rule mock or API. | Avoid tests of invented behavior and unintended firewall changes. |
| #311 blocks #224; #95 tracking live before SQL freeze. | Prevent known retention loss and untracked schema release. |
| Actual observation/entitlement/activation remain owner gates. | Prevent local mock success being mistaken for Production proof or authorization. |

**Assumptions:** Node 24 app; <=2 logical dimensions/2 key versions/12 markets;
current main still has Neon HTTP while #294 selected PS-5 single/us-east-1 with
iad1 and #309 owns driver/cutover. Existing startup retry and shared-path gates
remain the implementation hooks. No new store, scheduler, admin UI or alert
service. HMAC health policy values remain activation decisions. Per-instance
health is not a fleet-wide guarantee.

## Q0 proof and retained limits

20/20 mock cases pass. Twenty eligible boundary calls across two independent
factories cause exactly 20 existing admission statements; health projection adds
none. A fresh hit reads once without verification. A later follower uses its
existing two reads/one failed claim and one coalesced verification; no added SQL.
Five cached denials use five freshness reads only. Expiry does not add a second
SDK call. Invalid/readiness/error/floor states behave as specified.

Compatible rollback stops new-instance denials and sends enforce=false, without
reset SQL. The old instance can still refuse; the operational drain is essential.
No DB algorithm, HTTP/config integration, certificate/network cost, actual WAF
behavior or real observation window is claimed. C1-C4 retain those integration
checks that are local and leave external facts as explicitly blocked gates.

## C1 — deployment enum and requested/effective health (0.75–1h)

After branch authorization, add `ODDS_SUBJECT_MODE`, ordinary server-only enum
`log-only | enforce`, absent default log-only, at the existing paid-odds input
boundary and #99 inventory. Cache the validated deployment selection; no alternate
reader, client input, live flag service or SQL lookup. Malformed supplied values
cannot enable enforce or be echoed; preserve unrelated-route availability.

Thread mode through the existing boundary. Requested enforce is effective only
with existing limiter/shared readiness. Health uses current cached state and
fixed degradation reasons, retaining old `mode` as effective-mode compatibility
where needed. Missing key/policy/schema and startup retries preserve their
existing work/fallback behavior. Per-request allow-on-error remains visible
separately; effective enforce is not a promise that errors refuse.

Port the scratch cases to the real configuration/health APIs. Add invalid/default/
ready/degraded cases, no-extra-probe counts, unauthorized health zero DB work,
and no import-time refusal of unrelated routes. No supplied production mode/key/
policy is changed. Report diff, focused tests, guard/typecheck and whitespace
before C1 commit approval; then exact-commit publication verification.

## C2 — rollback and bounded verification contracts (0.75–1h)

Exercise independent instance generations in log-only → enforce → log-only
replacement using existing boundary/cache/auth mocks, not a reimplementation
of GCRA SQL. Preserve TAT/buckets/keyring/observations by issuing only existing
admission calls; no reset/rollback-ledger query. A new log-only instance bypasses
cached-denial behavior. Document old instance/URL drain; no fake global cache
flush or runtime mode mutation.

Port primed-cache fresh/follower/repeat-denial and expiry cases. Keep fresh hits
zero verification, pre-claim <=1 coalesced SDK call even when later following,
zero additional follower SQL and no repeat cached-denial claim/admission/release
work. Cover user/network distinction, floor refusal and fail-open counter/storage
errors with one reason warning. Rotation/rollback retain overlap and newest
reporting, with old-only drain/horizon and emergency allowance caveats.
Report tests and work counts before C2 commit approval.

## C3 — written WAF draft and runbook (0.5–0.75h)

Document exactly one IP fixed-window rule: every path of the production hosts
named by the owner at activation, **120 requests/60s**, initial log-only,
separately enforced **429**. No executable rule manifest, API, extra rule, bypass,
challenge substitution, hostname guess or WAF mock contract tests. If a real
machine-readable rule file becomes a test input later, that is a reviewed scope
choice; do not create one just to justify a test.

Runbook/checklist covers independent WAF/app approvals and one change at a time;
actual **24h observation plus synthetic journeys** before enforce, low-traffic
thresholds labelled **provisional**; page/assets/NAT/auth/cron/health/discovery/
stream reconnect journeys; named hosts, entitlement, rule slot and allowance-
exhaustion/rollback behavior verified at activation. Neither mock timers nor
empty traffic are called representative production evidence.

Record #95 tracking **live/verified before limiter SQL freeze**, then separately
approved release/grants/index evidence. Do not widen #285 or #309. #311 and its
proven/released repair block completion/maintenance; approved retention is 7-day
buckets, <=1000 rows/batch, manual first run and **no cron initially**. No SQL,
maintenance credentials, DELETE, runner or schedule here. Preserve HMAC dual-key
horizon/drain, quota/DB outage visibility, independent rollback and no credit
initialization/liability/account-safety steps. Report written draft/runbook
before C3 commit approval.

## C4 — final app/mock checks and evidence (0.5–0.75h)

Run focused plus full browser/Node mock suites, all existing CI/provider/config/
import guards, lint, root/web and DB-package **static** typechecks, production
build and whitespace. No DB suite, lane, PgBouncer, SQL-plan/speed run, hosted
credential or WAF/provider call. Bind compact receipts to exact sources; retain
Q0's original receipt and separate hashes. Report before the final docs/evidence
commit, followed by exact-commit publication guard. Push and PR require fresh
owner consent. No merge or activation permission follows.

## Estimate and next approval

Total remains **3–4 active engineering hours including the completed Q0 slot
(15–30 minutes)**, with approximately 2.5–3.5h remaining for implementation/checks.
No wall-clock test duration is a latency claim or active-time bill. Review/branch
approval waits and actual observation/activation are excluded. Re-estimate before
five active hours; stop/split before six or a new subsystem, rather than relax
budgets. #311's 3–4h repair work and its DB window are separate.

Next: owner reviews Q0/final roadmap and creates/authorizes the feature branch
with ALT. No branch name is asserted as already approved or created. #224
preparation may merge default-disabled, but does not auto-close #224 while #311
is unresolved. Actual policy/host/entitlement, 24h evidence, #95 tracking/release,
shared-cache/drain and #309/cutover gates remain prerequisites to owner-approved
activation. Retention Q0 still waits for Relay changeover and lane-2 clearance.
