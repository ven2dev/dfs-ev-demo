# #61 short-statement candidate — local preparation

Status: owner approved retaining20 workers and at most60 active minutes of local
candidate preparation on October24,2026. No push/Preview/performance-route approval.
The existing functional route continues to refuse run/cold actions. Nothing here
is a permanent application credit ledger or database migration.

## Design basis

Pattern: atomic conditional resource debit in one implicit transaction, with
pre-authentication role timeout defaults and the existing transaction advisory
fence/owner/lease pattern. Commit precedes any provider request so external latency
does not hold the account row. The local candidate is never wired to provider code.
Alternatives: a timeout configured inside the executing statement failed prior
proof; escrow adds outstanding-credit/reconciliation complexity and first-allocation
contention; Redis introduces another service/secret/recovery boundary before the
shorter Postgres candidate has been measured. Do not adopt those implicitly.
Targets: retain20 workers, hosted warm p95<=50ms and<=35ms headroom. Local behavior
proof does not satisfy those speed targets. Server statement/lock defaults5s/2s;
fixed opt-in PostgreSQL18.6/512MiB fixture127.0.0.1:54361 only. No external URL is
read by the tests, preventing accidental access to hosted data.
Requirement reasons: owner/request/lease guard and shared fence prevent cleanup
races; matching account/period, active flag, nonnegative amount, collector floor
and quota freshness prevent overspend or stale-period admission; corrections only
lower balance to avoid late responses minting credits. Client-side retries are
absent to prevent duplicated conservative deductions after ambiguous outcomes.
Assumptions: all paid callers coordinate one authoritative account/period and
quota freshness comes from trusted observations; cached reads and lease followers
perform zero candidate calls. Source replay proves possible offered bursts, not
actual production concurrency or candidate latency.

## Local scope

New pure candidate module supplies fixed-schema baseline/debit/correction SQL and
a bounded injected-query worker runner. No Neon client, connection, environment
read, role/configuration mutation or network call occurs on module import.
The candidate module has no route caller. Fixed local integration tests create
only bench61_candidate_20261024 and bench61_candidate_worker_20261024, refuse
existing objects, apply defaults before first login and remove owned objects after
all worker connections drain. Existing operator/functional roles are not changed.
The new temporary local role has connection limit24 for20 workers plus margin;
this does not authorize a hosted role/capacity change.

Each measured operation submits exactly one SQL statement/round trip. Guard takes
a shared transaction fence and reads one control row; that server work is counted
as part of candidate elapsed time, not hidden as transport. Baseline uses the same
guard and eligibility predicates without updating balance. Correction uses the same
guard and refuses old/future observations and retired periods. Correctness cases
include mixed interactive/collector work, uncertain committed response with no
retry, cancellation rollback, blocked-row lock timeout, active-work cleanup refusal
and expired/wrong identities. All started work drains before runner failure returns.

## Further gates

Local commit approval -> independent review -> separately approved hosted plan,
then fresh push/Preview consent. Hosted plan specifies exact sample counts, caps,
source/region, role connection limit, credential/build exposure, qualification,
cleanup and cancellation deadlines. Functional proof is reviewed before performance.
No benchmark result here relaxes50/35ms, and no fast quota denials stand in for
successful-debit latency. Downward corrections and baseline jitter belong in the
future workload. Stop after60 active minutes if preparation is incomplete.

## Local result and limits

Node24 opt-in run:11/11 pass (two pure runner checks and nine PostgreSQL cases).
Twenty simultaneous logins report5s/2s pre-login defaults. One thousand interactive
attempts admit26, followed by seven collector debits, leaving1. A separate mixed
run uses18 debit workers plus two correction workers:900 successful debits and100
successful downward corrections on one row, with no replenishment. No wall-clock
acceptance assertion runs in CI, and no local result is reported as hosted speed.
Statement cancellation rolls back the candidate update; blocked-row cancellation
is specifically55P03 lock timeout. Wrong/expired identities refuse work; the
exclusive fence probe fails while an admitted update remains in flight. Runner
failure drains20 started operations without retrying an uncertain committed debit.
The timestamp equality fixture uses millisecond precision, matching the observation
it replays; the first trial correctly rejected a microsecond observation rounded
backward by JavaScript. SQL rejection rules were not weakened to make it pass.

The local role/schema are confirmed absent, operator defaults remain0/0, and the
fixture is stopped. Evidence is local-short-statement-candidate-receipt.json under
docs/evidence/206-profile. Import-boundary and existing admission-denial checks
also pass. This does not qualify a new HTTP cleanup action: no such route exists.
The test proves the new SQL takes the shared transaction fence; future hosted
wiring has to use the matching exclusive fence and owned cleanup state machine.
Application integration, hosting and endpoint construction remain future work.

## Proposed hosted workload budget — separate approval required

After local review, propose one bounded20-worker experiment on the designated
Preview/Neon target, with all provider APIs disabled. Three alternating baseline/
candidate pairs of1000 samples each use6000 worker round trips. Interleave100 downward
corrections per candidate trial (300 total) within the same20 debit-worker loops,
with separately counted correction statements; do not replace20 debit workers
with18 or add uncounted worker/adapter calls. Fund synthetic rows so all measured debit samples succeed;
record denials separately and invalidate success-latency acceptance if unexpectedly
unfunded. Include exact freshness/period reset in the setup for each trial.

Reserve1100 additional worker attempts for floor/total-budget correctness,220
round trips/440 submitted statements for finite qualification and100 admin trips
of at most four statements for setup/reset/inspection/cleanup. Maximum proposed
7720 round trips/8240 explicitly submitted statements, below the historical
8020/16040 caps. Internal guard/fence/control-row work is additional and disclosed.
No automatic retry of writes. A failed trial is incomplete, never silently repeated.
Each pair gets its own bounded action (deadline45s, function maximum60s); all
started workers drain, and cleanup uses the transaction fence plus owned run lease.
A deadline miss invalidates the trial rather than extending resource consumption.
The application maxDuration and permanent routes are not changed by this proposal.

A hosted temporary role with connection limit24 (rather than the qualified role's
8) needs explicit approval, along with role provisioning, fresh build/runtime
credential, exact source/SHA and region, workload, counters and cleanup. Local
fixture capacity is not hosted authorization. No cold-start claim or idle samples
are part of this experiment. Retain50ms p95 and35ms headroom in every repeated
warm trial; a read baseline that misses is a hosting result to report, not subtract.
The final hosted plan still needs implementation details and independent review
before consent; these numbers do not enable any performance action today.
