# #223 C4 results — pending owner review and commit

## Design basis

Pattern: DB-clock GCRA, atomic sorted locking across user/network dimensions
and overlapping HMAC versions, with one-minute reporting buckets and the quota
floor composed into the paid-leader statement. The cache kernel retains resource
ownership. Redis was rejected for the added service/round trip; route-entry/WAF
limits cannot identify paid leadership and would charge hits/followers. The
operator report uses one conditional 24h aggregate and bounded top-N lists.
The approved design, requirement reasons and alternatives are in 223-roadmap.md.

Targets: the owner-approved 90 ms warm pre-provider budget is cache 10 ms,
admission 53 ms and headroom 27 ms. The 53 ms share came from #220 PlanetScale
measurements; it is not hosted Neon proof. Fixtures: Q0's
223-20-leaders-two-instances, C3's 100,000 buckets / 10,000 real-length HMAC
subjects, and C4's 223-production-first-use-five-backends. Warm branch work is
<=80 shared blocks / zero temp at 10,000 subjects; report <=1,024 / zero temp.
First-use catalog work is recorded separately under the 2026-11-20 owner
correction. Identity remains HMAC-only to avoid retaining raw IP/UID/token.
All-or-none sorted decisions prevent partial allowance and conflicting owners;
fail-open errors preserve availability under the approved failure policy.
Assumptions remain <=2 dimensions, <=2 active key versions and <=12 markets.

## Tested revision and checkpoints

Runtime revision tested: 71fce9e5b49a6809a061424a8ad1756f52e4f592.

- C1: b3d717cb974c3454fa2fce05141f30c06a2194e4 — proposal and subject adapters.
- C2: 022269a3b14f0241a198a4e2f3b4e1d9f7683938 — paid-leader route threading,
  log-only admission, advisory deny cache and signature-only lazy attribution.
- C3: 71fce9e5b49a6809a061424a8ad1756f52e4f592 — authenticated reports,
  inactive bounded retention/threshold proposals, shared-cache enforcement gate
  and production work/plan checks. Includes both stopped and requalified receipts.

Each checkpoint's attribution grep was empty and exact-commit publication guard
passed. C3 was clean immediately after commit. C4 changes only review/evidence
documentation; its commit and publication guard await owner review/approval.

## C4 verification

- Full app: 949 browser tests and 1,018 Node tests pass; one pre-existing opt-in
  credentialed R2 contract is skipped. No credentials were supplied.
- CI gate: all 63 checks pass, retaining all six test-file paths.
- ESLint/import-boundary checks, web and DB package typechecks pass.
- Next.js production build passes, including /api/health/odds-subjects.
- Core PostgreSQL: all 89 tests across 11 files pass on lane-2 standard.
- Feature-store PostgreSQL: all 301 tests pass on the same standard fixture,
  with no failures or skips.
- Whitespace check passes. No runtime/code fix was needed during C4.

## Cold-first-use timing and baseline

Five fresh backend sessions, 25 total samples, production proposal SQL on a
registered local disposable clone; floor-only baseline alternated before/after
trial groups on a separate backend. p95 equals max for each five-sample phase:

| Phase | Local p95 ms |
| --- | ---: |
| Cold allow | 12.853 |
| First denial | 1.614 |
| Warm denial | 0.810 |
| Warm allow | 0.926 |
| Floor-only baseline | 0.411 |

Every phase passes the 37.1 ms local screen (53 ms admission share with >=30%
headroom). These are pg TCP comparator timings with connection setup excluded;
they do not prove hosted Neon HTTP, Firebase key-refresh latency, the entire
90 ms application path, or production tail percentiles. No target was raised.
Cold catalog/user IO evidence and its measurement-overhead caveat remain in
C3's receipt. Full warm/follower correctness and deterministic counts are
covered separately; the timing harness never calls a provider.

## Work and rollout limits

C4 reconfirms the production report at 821 shared blocks, zero temp, one base
scan/one loop and three bounded top-N nodes. Warm allow/denial/rotation/overlap
uses 28–74 shared blocks at 10,000 subject rows. Extracted production lock/update
plans use the subject PK; quota uses the partial index, with no seq scans.
Debt reuses the sorted locked-row snapshot; validation/atomicity are unchanged.

Production enforcement is hard-coded off. The shared-cache requirement prevents
legacy coalescing from spreading one subject's refusal to eligible joiners.
Live remains network-only/log-only until #299. Schema/ordered migration release,
old-instance drain, owner policy, key provisioning and #224 activation remain
separate approvals. Thresholds (100 warning / 500 critical per subject/hour)
and seven-day retention are inactive proposals; no schedule is installed.
Reports count subject-dimension admissions to send, not exact unique sends.
Reports may split during rotation; instance-health counters are not fleet totals.

No hosted work, credentials, provider calls, issue edits, push or PR occurred.
Lane-2 container/network and owned template clones are confirmed removed; other
lanes were untouched. The cleared timing window is finished. C4 remains
uncommitted for the owner's full-branch review; push and PR each need fresh consent.


## Evidence and review handoff

Untouched timing receipt: docs/evidence/subject-223/checkpoint-4-speed.json.
Separate hash/check wrapper: docs/evidence/subject-223/checkpoint-4.json. The
wrapper binds exact tested sources, all test totals, budget samples, cleanup
and the C3 publication result. Private raw logs and a review patch are retained
under planning/223-c4. Earlier stopped and requalified receipts remain unchanged.
C4 completed within the approved 1.25h cap. No additional code iteration or
scope expansion was needed. Owner full-branch review and C4 commit approval
precede publication; push and PR each require fresh consent.
