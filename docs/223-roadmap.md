# #223 approved implementation roadmap

2026-11-18 local date. Q0 is complete; implementation is not started.
Owner approved this roadmap and branch creation. Branch:
feature/dfsEV-223-paid-leader-rate-limits, new worktree from origin/main f31a250.
Compact Q0 evidence: docs/evidence/subject-223/q0.json; raw receipts and separate
hash wrapper remain in private planning storage. Implementation commits still
require review; no push or PR consent follows from branch approval.

## Design basis (final)

**Pattern:** database-clock GCRA with sorted atomic subject/version decisions,
composed with the advisory quota floor and one-minute bucket upserts in one
paid-leader function invocation. Existing cache kernel keeps resource ownership.
PostgreSQL now earns its place through shared authority and co-location of the
already-required floor/reporting work, not a removed credit transaction.
No transaction remains open during provider HTTP.

**Alternatives:** Redis/Upstash is a standard strong alternative but adds service
provisioning and a second authority/round trip; WAF alone cannot know paid
leadership/verified user; in-memory grants independent allowances; route-entry
charges cache hits/followers; separate SQL costs two driver round trips. An
exact journal adds unnecessary per-call retention; owner chose approximate
minute buckets. Q0 supports the combined design on this fixture, not a universal
claim about Redis versus PostgreSQL or hosted performance.

**Targets:** 90 ms full warm pre-provider = cache 10 + admission 53 + headroom
27, decided. PlanetScale #220 informed 53 ms. Limiter/counters/floor share it.
Two-process, 20-leader Q0 successful combined round p95 was 2.14–34.64 ms across
ten rounds including the cold-reconnect sample; local screen <=37.1 ms passed.
19 behavior cases passed; real 45s follower path did zero admission. 100k-bucket
report worst p95 99.79 ms vs <=700 ms local screen. See results for separate
success/denial totals, interleaved baselines and plans. Full-path/Firebase/
hosted Neon speed is NOT qualified; #294 keeps hosted provider/driver authority.

**Requirement reasons:** zero nonleader work avoids read amplification; all-or-
none decisions and sorted DB-clock locks prevent partial allowances/deadlocks;
HMAC-only identifiers prevent retained raw identity; pre-send owner fencing
prevents market monopolization/late release; retaining ambiguous-send cooldown
prevents duplicate paid work. Fail-open errors preserve availability as owner
chose, at an acknowledged fairness/visibility cost. One-minute buckets bound row
growth per subject/minute but not write frequency. No session-affinity SQL,
ordered migration or automatic activation prevents pool/deployment hazards.

**Assumptions:** Vercel Node + current Neon HTTP driver, <=12 markets per batch,
1 anonymous / 2 signed-in dimensions, <=2 active HMAC versions. Lane-2 standard
has 512 MiB tmpfs, not RAM cgroup enforcement; its non-durable test settings
limit what local timing proves. WAF remains ingress defense, provider caps total
usage. Rates/bursts, IPv6 grouping, retention and health thresholds remain
proposals awaiting policy approval before enforce.

## Fixed behavior and scope

- Verified user-primary signed-in policy plus loose network backstop; anonymous
  network policy has a distinct namespace. No raw identity in SQL/logs/responses.
- Invalid/missing token becomes anonymous; invalid token gets one reason-only
  log, never refusal. Resolve only at actual paid leader. Discovery attaches
  getAuthHeaders; only trusted Vercel header is authoritative. Missing platform
  identity/HMAC/capability errors never cause raw identity fallback.
- One composed admission, <=1 quota read, <=1/2 reporting bucket upserts and
  <=1/2 ordinary GCRA rows, <=2/4 overlap rows. No limiter SQL on hits/followers/
  cooldown results. Production values are not copied from test policies.
- Limiter/counter errors allow in both modes, one sanitized reason warning and
  explicit health visibility. No retry/fallback query. Known floor refusal
  survives a counter error; quota read errors remain advisory under #222.
  Missing schema/key disables shadow, logs once and reports not-installed.
- One refusal class with quota-floor / subject-rate-limit reasons; no duplicated
  fallback. Limiter-denied pre-send release clears only current owner's claim/
  cooldown and outer lease, never payload age. Quota/ambiguous-send release
  retains existing cooldown semantics. Weather/collector/free-events unchanged.
- DB-minute buckets, admitted-to-send (not exact sends), denied and would-deny
  fields. Conservative window-edge overcount <1 minute for 1h/24h windows.
  At most 61/1,441 minute positions. Errors can undercount and health says so.
- Keep authenticated top-20 API report, traffic breakdown and approximate window
  totals in core, no new UI. Proposed 7-day retention, <=1,000-row maintenance
  batches; protect future TAT. Threshold values remain inactive proposals.
- Normal rotation checks/updates both versions using stricter debt, no aliases.
  Overlap horizon starts after old-only instances stop; retire after longest
  configured limiter horizon. Reports may split for 24h. Emergency rotation's
  fresh allowance exception is explicit; do not claim unconditional continuity.
- #299 is now the live bearer transport follow-up, on the project board and
  natively blocking #224. Live stays network-only shadow/log-only until it lands;
  does not block #223 itself. Enforcement is separately gated, never enabled here.

## Measured ceilings to implement in CI

| Work | Proposed CI ceiling supported by Q0 |
| --- | --- |
| Leader admission | 1 driver statement; <=1 indexed floor lookup; <=2 logical dimensions / <=4 physical overlap rows; <=2 counter upserts |
| Hit/follower/cooldown | 0 admission/limiter/counter SQL; existing cache work budget retained |
| Limiter denial | No TAT advance, no send/payload write; <=1 release statement per owned raw/outer layer |
| Error | <=1 attempted admission, one fixed warning, no additional fallback SQL |
| Quota index probe | <=16 shared blocks, 0 temp; measured 3 |
| Admission first plan | <=512 shared accesses, 0 temp; measured max 354 including catalog/first-plan work |
| Warm ordinary/overlap probe | <=80 shared accesses, 0 temp; measured max 46 |
| Report at 100k buckets | 1 aggregate query, <=1,024 shared accesses, 0 temp; measured 628 |
| Follower timeout | <=182 reads and <=182 failed claims at 250ms/45s; measured 177 each plus 4 held-owner renewals; admission stays 0 |
| Retention | <=1,000 rows per maintenance delete, outside paid path |

Buffer limits are fixed-fixture SQL work checks, not universal production bounds.
Wall-clock thresholds remain opt-in, not CI assertions. Preserve the cold sample
and outcome-specific receipts; no cheap-denial or smaller-fixture substitutions.

## Checkpoints and six-hour cap

Core remains **5.5–6 active engineering hours including Q0**, with the basic
report retained. Q0 setup/behavior/timing fit its 0.75h allocation. No claim of
precise active-time billing is inferred from the three-second/49-second harness
elapsed times. They exclude preparation and analysis. No further split needed
now; stop and propose top-consumers API follow-up if this estimate rises.

| Checkpoint | Deliverable and required evidence | Active allocation ceiling |
| --- | --- | --- |
| Q0 (done) | Scratch SQL, actual shared-kernel behavior, two-process interleaved trials/report plans; raw evidence and final roadmap | 0.75h |
| C1 | Production-quality proposal API/validation/least privilege, subject adapter, atomic GCRA/buckets/error isolation, simplified rotation/startup runbook and DB tests | 1.25h |
| C2 | Discovery auth, lazy shared/legacy/live context, generalized refusal/fenced release, bounded subject deny cache; boundary guard and weather/collector/free-events regressions | 1.75h |
| C3 | Authenticated bounded top API, retention and current/recent reason-only health; deterministic work/buffer budgets | 1.0h |
| C4 | Full app suite, lint/typecheck/build, CI/boundary guard and applicable core/feature DB suites on quiet lane-2; compact evidence and final review report | 1.25h |
| Buffer | Allocated to owner-approved C2 deny cache; stop before exceeding total cap | 0h |
| Total ceiling | Q0 plus remaining core | 6.0h |

Before each commit report diff and test results. Do not skip validation to fit a
checkpoint. No commit/push/PR permission is implied by this roadmap. No attribution
trailers. Q0 scratch injection arguments, mock identity code and schema names
are not a production API to copy wholesale. Real Firebase, legacy/outer-live
wiring, route authorization and health markers remain unimplemented checkpoint
work, with explicit regression coverage rather than claims of Q0 completeness.

Schema proposals stay under packages/db/proposals/. #285's existing activation
scope does not authorize new #223 schema; no ordered migration/hosted apply.
#294 owns provider/driver/timing, #299 blocks #224's enforcement activation.
Real secret provisioning belongs to owner. No provider/credential/hosted work
in local validation. Cleanup removed only owned lane-2 resources.

## Owner addition: bounded C2 deny cache

Owner approved an instance-local advisory deny cache for enforce only. Key it
by HMAC subject, not raw identity or resource. Cache only the actual failing
subject dimensions returned by admission, so a user denial does not blacklist
other users sharing a network. Expire at the database retry-after using a
monotonic deadline and a fixed entry bound. Check only at prospective leadership;
fresh hits do no limiter work. A cached denial skips claim/admission and returns
existing stale/unavailable data. It never substitutes an allow for the DB gate.
CI target: repeats within retry-after on that instance add zero SQL. C2 must
prove the target with existing freshness/fallback behavior, not hide cache reads
in a different counter. Log-only never inserts or applies this cache. The 0.5h
buffer is now assigned to C2; total remains 6h. Report before any overrun.

## Delivery state

C1 is underway; C2 deny cache and route threading are not implemented here.
Owner approval precedes every commit; fresh consent precedes push and PR.
#299 blocks enforcement under #224. No ordered migration or hosted action.
