# #223 approved implementation roadmap

2026-11-19 local update. Q0, C1 and C2 are complete; C3 is uncommitted; owner-approved non-timing requalification is complete, with cold speed timing deferred to an approved C4 window.
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
| Cold first use (owner correction 2026-11-20) | Evidence only: catalog/user IO split plus opt-in speed; former <=512 CI ceiling replaced |
| Warm production branches | <=80 shared accesses, 0 temp at 10,000 subjects; allow/denial/rotation/overlap measured <=74; PK/quota index plan checks |
| Report at 100k buckets | 1 conditional aggregate/base scan, top-N lists, <=1,024 shared accesses, 0 temp; production measured 821 |
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
CI target: repeats within retry-after add zero claim/admission/release SQL.
The existing freshness SELECT still runs, is counted explicitly as existing
work, and returns fresh data if another subject published it. No local payload
snapshot replaces the freshness read. Owner clarified this budget during C2.
Log-only never inserts or applies this cache. The 0.5h
buffer is now assigned to C2; total remains 6h. Report before any overrun.

## Delivery state

C1 committed as b3d717cb974c3454fa2fce05141f30c06a2194e4; attribution check and
clean worktree verified before C2, and publication guard passed on that commit.
C2 now implements route threading, one-floor admission/fallback, enforced-only
bounded deny cache, fenced release and reason-only instance health counters.
C2 committed as 022269a3b14f0241a198a4e2f3b4e1d9f7683938 with no attribution lines,
a clean worktree immediately afterward, and a passing exact-commit publication
guard (zero unapproved findings). C3 is uncommitted; see qualification gap below.
C4 final build/feature-store/speed verification remains.
Owner approval precedes every commit; fresh consent precedes push and PR.
#299 blocks enforcement under #224. No ordered migration or hosted action.

## C2 review carry-forward: enforce requires shared cache

Before enforcing subject limits, #221's shared-cache capability must be ready
on every serving instance. Legacy discovery's in-flight promise shares the
creator's denial with eligible joiners; legacy live needs the same safeguard.
C3 acceptance/runbook work includes a test that an enforce request on a legacy
path is downgraded to log-only. #299 and #224 approval remain separate blockers.
Production remains hard-coded log-only. This limitation is recorded now, not
claimed fixed on the legacy paths.

Rate-limit subject verification is signature/expiry-only with cached keys, not
requireUid's per-request revocation lookup. Cached-key verification does not
promise zero cold/key-refresh network access. Account authorization is unchanged.


## C3 historical qualification gap — superseded by owner correction below

Implemented in the requested order: authenticated fixed top-20 report; bounded
inactive retention helper; inactive threshold proposals plus current/recent
instance health; CI statement/buffer assertions; shared-cache enforcement gate
and draft acceptance/runbook text. No issue edits, migration, activation or push.
The report uses the existing health bearer, one aggregate statement and full
versioned HMAC subjects. It reports dimension admissions, not unique sends.
Retention has no automatic schedule. Production enforcement remains off.

The 100,000-row / 10,000-subject report fixture uses actual-length synthetic HMAC
keys and production counters. Final per-window query: 1,234 shared blocks versus
1,024 approved; temp reads/writes zero. An earlier combined-window shape used
821 blocks but spilled 566 read / 567 written temp blocks, so it is not a passing
alternative. Do not increase work_mem or shrink keys/fixtures to claim a pass.

Production admission's final diagnostic sequence was ordinary [1376,137,22]
and overlap [52,28,28] shared blocks, all with zero temp IO. First-use ceiling
512 and repeated-call ceiling 80 both fail (including the first denial branch).
Q0 scratch measured 354/46; those figures do not prove the more fully validated
production function's first-use paths. The precise catalog/planning versus
query-work contribution is not yet isolated. Validation remains intact.

All 23 behavior/retention/privilege cases in the focused DB suite passed; its
two budget cases fail. An existing handoff fixture left published payloads in
the disposable DB between reruns; C3 now deletes only its handoff/late fixture
rows at setup/cleanup and scopes its assertion. App tests pass: 949 browser,
1018 Node, one pre-existing credentialed R2 skip; 63 CI gate checks, lint and
both typechecks pass. No hosted timing or provider calls were performed.

Owner review required before further qualification: recommend a bounded 0.5–1h
requalification of the production SQL, real-length HMAC report fixture, first
allow/first denial and warm branches. Prefer query improvements; any revised
ceiling needs explicit owner approval and fresh evidence. This additional work
was not in the six-hour allocation, whose buffer was assigned to C2. The six-
hour estimate is no longer a reliable completion estimate; do not proceed to
C4 or commit C3 on the basis of the scratch measurements.


## Owner correction and C3 requalification (2026-11-20)

Owner approved <=1h for the two review items. The first-use <=512 CI ceiling
is replaced by warmed per-branch <=80 / zero-temp checks plus production plan
assertions. Historical failed receipts remain untouched. No other ceiling is
raised. Cold speed timing is an opt-in check against the 53 ms admission slice;
the currently authorized lane window is non-timing, so it has not run.

The production report now materializes one conditional aggregate over 24h for
both windows. Each top-20 list uses a bounded ORDER BY/LIMIT, replacing full
window sorts. At 100,000 buckets / 10,000 real-length HMAC subjects: 821 shared
blocks, zero temp IO; plan proves one source scan with one loop and three
bounded top-N sort nodes (each serves both windows).

The new 10,000-subject plan check found a real issue hidden by the tiny warm
fixture: JSON IN was estimated as 100 keys and selected a subject-table seq
scan. Admission now captures TAT in the already-required sorted PK lock read
and computes each dimension's debt from that locked snapshot. No validation
or fencing is removed, and all-or-none behavior is unchanged. Warm allow,
first/repeat denial, rotation and overlap use 28–74 shared blocks at that scale,
zero temp IO. Extracted production lock/update and quota statements use the
subject PK/partial quota index without seq scans. Plans and behavior tests are
CI work checks; wall-clock assertions remain out of CI.

Cold-work evidence on five fresh backends records PL/pgSQL first allow and
first denial separately from warm branches, including pg_statio deltas on
pg_catalog versus public user tables. The observation/flush overhead is stated;
these deltas are not claimed to be an exact partition of EXPLAIN hits. The
opt-in script is ready, but --timing has not run in this non-timing window.

Revised C4 estimate for owner review BEFORE starting C4: **1.25 active hours**,
including 0.25h cold first-use opt-in speed/receipt review in an approved quiet
window, 0.75h final app/CI/lint/types/build and applicable DB regressions, and
0.25h evidence/publication preparation and final review. The original 6h cap
was exhausted; this is a separate allocation request beyond the <=1h C3
requalification approval. No C4 work, commit, issue post, push or PR is implied.
