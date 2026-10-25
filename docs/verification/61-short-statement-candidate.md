# #61 short-statement candidate — local preparation

Status: owner approved retaining 20 workers and at most 60 active minutes of local
candidate preparation on October 24, 2026. a095bd0 prepared the candidate; its
review revision adds a local lock-hold spike and the review fixes below. No
push/Preview/performance-route approval. The existing functional route continues
to refuse run/cold actions. Nothing here is a permanent application credit ledger
or database migration.

## Design basis

Pattern: atomic conditional resource debit in one implicit transaction, with
pre-authentication role timeout defaults and the existing transaction advisory
fence/owner/lease pattern. Commit precedes any provider request so external latency
does not hold the account row. The local candidate is never wired to provider code.
Alternatives: a timeout configured inside the executing statement failed prior
proof; escrow adds outstanding-credit/reconciliation complexity and first-allocation
contention; Redis introduces another service/secret/recovery boundary before the
shorter Postgres candidate has been measured. Do not adopt those implicitly.
`synchronous_commit=off` for the worker role shortens the lock hold (see the spike
below) but trades durability: after a crash, the last few hundred milliseconds of
committed debits can be lost, allowing a bounded overspend. That needs an explicit
owner decision, and Neon support must be verified first.
Targets: retain 20 workers, hosted warm p95 <= 50 ms and <= 35 ms headroom. Local
behavior proof does not satisfy those speed targets. Server statement/lock
defaults 5 s/2 s; fixed opt-in PostgreSQL 18.6/512 MiB fixture 127.0.0.1:54361
only. No external URL is read by the tests, preventing accidental access to
hosted data.
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

The candidate module (`apps/web/src/lib/bench61-candidate.ts`) owns all candidate
SQL: baseline/debit/correction statements, the setup statements (role with
pre-login defaults, schema, tables, guard function and grants) and the cleanup
statements (exclusive fence, schema and role ownership checks, drop). Local tests
and any future hosted run therefore use the same reviewed SQL. The worker password
reaches setup only as a bind parameter. Per-mode parameter builders
(`debitParams`, `baselineParams`, `correctionParams`) prevent a debit flag from
being bound as a correction time. No Neon client, connection, environment read,
role/configuration mutation or network call occurs on module import, and the
module has no route caller.

Fixed local integration tests create only bench61_candidate_20261024 and
bench61_candidate_worker_20261024, refuse existing objects, apply defaults before
first login and remove owned objects after all worker connections drain. Existing
operator/functional roles are not changed. The temporary local role has connection
limit 24 for 20 workers plus margin; this does not authorize a hosted
role/capacity change.

Each measured operation submits exactly one SQL statement/round trip. Guard takes
a shared transaction fence and reads one control row; that server work is counted
as part of candidate elapsed time, not hidden as transport. Baseline uses the same
guard and eligibility predicates without updating balance. Correction uses the same
guard and refuses old/future observations and retired periods. Every statement
returns `pg_backend_pid()`, and the runner reports how many distinct backends served
a batch. Correctness cases include mixed interactive/collector work, uncertain
committed response with no retry, cancellation rollback, blocked-row lock timeout,
active-work cleanup refusal and expired/wrong identities for both baseline and
debit. All started work drains before runner failure returns.

## Local result and limits

Node 24 opt-in run (2026-10-25T04:41:45Z): 11/11 pass (two pure runner checks and
nine PostgreSQL cases), using the module's setup and cleanup statements. Twenty
simultaneous logins report 5 s/2 s pre-login defaults. One thousand interactive
attempts admit 26 across more than one backend, followed by seven collector
debits, leaving 1. A separate mixed run uses 18 debit workers plus two correction
workers: 900 successful debits and 100 successful downward corrections on one row,
with no replenishment. No wall-clock acceptance assertion runs in CI, and no local
result is reported as hosted speed. Statement cancellation rolls back the
candidate update; blocked-row cancellation is specifically 55P03 lock timeout.
Wrong/expired identities refuse work; the exclusive fence probe fails while an
admitted update remains in flight. Runner failure drains 20 started operations
without retrying an uncertain committed debit. The timestamp equality fixture uses
millisecond precision, matching the observation it replays; the first trial
correctly rejected a microsecond observation rounded backward by JavaScript. SQL
rejection rules were not weakened to make it pass.

At 2026-10-25T04:42:39Z the local role/schema were confirmed absent, no worker
sessions remained, operator defaults remained 0/0, and the fixture was stopped.
Evidence: `local-short-statement-revision-receipt.json` and
`local-hold-spike-receipt.json` under docs/evidence/206-profile. The original
a095bd0 receipt (`local-short-statement-candidate-receipt.json`) has no
observation times; both new receipts record them. This does not qualify a new
HTTP cleanup action: no such route exists. Application integration, hosting and
endpoint construction remain future work.

## Local lock-hold spike

Question: does the single statement shorten the time the shared row stays locked?
Each debit holds the row from its `UPDATE` until its commit completes. With 20
workers on one row the queue is never empty, so commits per second ≈ 1 / hold.

Method (`tests/bench61-hold-spike.test.ts`, opt-in with `BENCH61_LOCAL_TEST=1
BENCH61_HOLD_SPIKE=1`): three alternating rounds, each mode at 20 workers × 1,000
debits and 1 worker × 200 debits, funded so every debit succeeds; balance
arithmetic is asserted after every run. Modes: `batch` (BEGIN, set_config, guard,
debit, COMMIT as separate round trips, the old shape); `single` (the candidate
statement, autocommit); `single-async` (single with `synchronous_commit=off` set at
login). Fixture settings: fsync on, wal_sync_method fdatasync, full_page_writes on.
Run 2026-10-25T04:42:05Z–04:42:10Z. Medians of three rounds:

| Shape | Commits/s at 20 workers | Implied hold | p95 at 20 workers | p95 at 1 worker |
| --- | ---: | ---: | ---: | ---: |
| batch | 1,645 | 0.608 ms | 33.8 ms | 1.53 ms |
| single | 3,658 | 0.273 ms | 15.7 ms | 0.53 ms |
| single-async | 10,739 | 0.093 ms | 4.0 ms | 0.43 ms |

Every 20-worker run used 20 distinct backends. The `single-async` hold is an
upper bound; at that rate the client may limit throughput rather than the lock.

Findings: the hold time, not the statement count, sets the contended p95. Removing
the post-update COMMIT round trip roughly halved the local hold; turning off
synchronous commit cut it by about two thirds again. In both durable modes the
20-worker p95 was about 55 times the hold.

Estimates for the hosted target, not measurements: if the hosted p95 is also about
55 × hold, #206's executor p95 of 139–154 ms (old shape) implies a hosted hold of
about 2.5–2.8 ms. With roughly 11 ms of uncontended client latency, a 50 ms p95
needs a hold of about (50 − 11) / 55 ≈ 0.7 ms. That figure combines a local ratio
and #206's uncontended latency; it is a diagnostic, not a proven cutoff, and does
not by itself show the target is unreachable. The local spike cannot say how much
of the hosted hold is the post-update round trip (removed by the single statement)
versus commit durability, which on Neon waits for WAL quorum and is unchanged by
it. Limits: loopback client and container disk; local fsync is much faster than
Neon's commit path, so these numbers show the mechanism, not hosted hold time.

## Further gates

Local commit approval -> independent review -> separately approved hosted plan,
then fresh push/Preview consent. Hosted plan specifies exact sample counts, caps,
source/region, role connection limit, credential/build exposure, qualification,
cleanup and cancellation deadlines. Functional proof is reviewed before performance.
No benchmark result here relaxes 50/35 ms, and no fast quota denials stand in for
successful-debit latency. Stop after 60 active minutes if preparation is incomplete.

## Proposed hosted workload budget — separate approval required

Step 1, hosted hold probe (before the full experiment). On the designated
Preview/Neon target, each shape runs 20 workers × 200 debits and 1 worker × 50
debits, so 250 debits per shape:

| Shape | Per debit | Round trips | Submitted statements |
| --- | --- | ---: | ---: |
| batch | One Neon HTTP transaction: timeout settings, guard, debit | 250 | 750 |
| single | One statement | 250 | 250 |
| batch-async | The batch transaction with `set_config('synchronous_commit','off',true)` in its settings statement | 250 | 750 |

The hosted batch shape is the one #206 measured: one HTTP transaction carrying three
statements, with begin and commit done on the server. It is not the local spike's
five client round trips per debit, which no hosted caller uses.

Owner decision (2026-10-25): `synchronous_commit=off` is measured as `batch-async`
on the same candidate role, as a measurement only. The Neon HTTP driver (1.2.0)
cannot pass login settings, so the local spike's `single-async` shape would need a
second role and a sixth deployment setting holding its credential; that was
rejected to avoid widening credential exposure. batch versus batch-async shows the
commit-durability share of the hold; batch versus single shows the post-update
round-trip share. A single-async figure can only be estimated from those two and
must be labelled as an estimate.

Workload: 750 round trips and 1,750 statements. Add at most 220 round trips/440
statements for finite qualification of the candidate role and at most 20 admin
round trips of at most four statements (setup, per-run reset and balance check,
snapshots, cleanup). Totals: 990 round trips/2,270 statements. Caps are those
totals plus 5% (1,040/2,384), enforced before any workload. Option B raises the
statement count by 500 over the plan in 1545ce1, because batch-async carries three
statements per debit rather than one.

Decision rule. The probe measures the 20-worker p95 of each shape directly. Step 2
runs only if the single statement's measured 20-worker p95 is within 50 ms, or close
enough that the owner judges a 1,000-sample trial could meet it; record that
judgment with the numbers. A 200-sample p95 rests on its ten slowest samples, so it
is a screening result, not acceptance. If the measured p95 and commits per second
clearly show the target missed, stop and present them; the owner then decides
between `synchronous_commit=off` (if Neon supports it and it is approved),
escrow/credit leasing, or a target or hosting decision. The implied hold time and
the p95/hold ratio are recorded as diagnostics that explain the result, never as
the cutoff on their own.

## Hosted probe implementation (local, not deployed)

This SHA admits only four actions, in order: `probe-setup`, `probe-qualify`,
`probe-run`, `probe-cleanup` (`apps/web/src/lib/bench61-probe-policy.ts`). The
earlier functional actions stay in code for their fixture regressions but are
refused at admission (`action_not_admitted`). The worker credential must name the
candidate role (`bench61_candidate_worker_20261024`); the deploy helper now issues
that role's credential. Setup and cleanup run the module-owned SQL from
`bench61-candidate.ts`.

- `probe-setup`: one operator transaction of the 13 setup statements; refuses an
  existing schema or role.
- `probe-qualify` and `probe-run`: one-shot. Each claims the run row with an
  `operations` and `active_action` record and a renewed five-minute lease, so a
  replay or an overlapping action is refused. A failed action keeps its claim, so
  only cleanup can follow. Qualify checks the login defaults (five identity probes,
  three of them concurrent), the privilege audit, statement-timeout cancellation and
  rollback, lock timeout, wrong owner and request, the shared/exclusive cleanup fence
  with exactly-once commit, and whether Neon applies `synchronous_commit=off` inside
  a transaction.
- `probe-run`: the three shapes, each at 20 workers × 200 and 1 worker × 50, funded
  so every debit succeeds; balance arithmetic is checked after every run. Every
  statement returns `pg_backend_pid()`, and each 20-worker run takes one
  `pg_stat_activity` snapshot. Every batch-async debit must report
  `synchronous_commit=off`; if Neon refuses the setting, that shape is skipped and
  reported. An error stops new dispatches; every started debit drains; nothing is
  retried. A 45-second deadline invalidates the run rather than extending it.
- `probe-cleanup`: counts worker sessions, then the exclusive fence, ownership
  checks, drop and confirmed absence in one transaction. A retry after a lost reply
  reports `alreadyAbsent`; a partial state refuses and needs operator cleanup.

Per-action caps are counted before each dispatch: setup 2/20, qualify 220/440, run
770/1,830, cleanup 2/8 round trips/statements, 994/2,298 in total, within the
1,040/2,384 caps. The fixed run plan is 768 round trips/1,768 statements. Each
result records `observedAt`, the deployment id (`VERCEL_DEPLOYMENT_ID`), the SHAs,
region and work totals.

Local validation (Node 24.21.0, 2026-10-25T05:48:01Z–05:49:01Z on the fixed
fixture, through a local stand-in for the Neon HTTP driver): 13/13 candidate and
probe cases, including the full setup → qualify → run → cleanup sequence with
replay, overlap and repeat-cleanup refusals; the four earlier functional fixture
regressions; 312 Node tests including the updated admission and cap tests; 12
deploy-helper and 10 import-boundary checks; root typecheck and ESLint. Afterwards
both candidate and functional schemas and roles were absent, operator defaults
were 0/0 and the fixture was stopped. The stand-in proves orchestration and SQL
behavior, not managed Neon HTTP timing or pooling.

Step 2, full experiment, only if Step 1 passes. One bounded 20-worker experiment
on the designated Preview/Neon target, with all provider APIs disabled. Three
alternating baseline/candidate pairs of 1,000 samples each use 6,000 worker round
trips. Interleave 100 downward corrections per candidate trial (300 total) within
the same 20 debit-worker loops, with separately counted correction statements; do
not replace 20 debit workers with 18 or add uncounted worker/adapter calls. The
50 ms p95 and 35 ms headroom are computed over the 1,000 debit samples of each
candidate trial; correction latencies are reported separately.

Funding and corrections: each trial resets one funded row to F = 1,000,000 credits,
floor 20, fresh observation and current period. Debits are 3 credits, so 1,000
debits need 3,000. Correction i (i = 1..100) sets the value F − 10·i, so the
corrections lower the balance by at most 1,000 in total and the balance never
falls below F − 4,000, far above the floor. Every measured debit must succeed;
record denials separately and invalidate the trial if any debit is unexpectedly
denied. Include exact freshness/period reset in the setup for each trial.

Backend concurrency: every statement returns `pg_backend_pid()`. Each trial
records the number of distinct backends and one mid-trial `pg_stat_activity`
snapshot of active worker sessions (inside the admin budget). If a trial was served
by fewer than 20 backends, it measured the HTTP pool's queue as well as row locks;
report that as a hosting result rather than a lock-contention result.

Reserve 1,100 additional worker attempts for floor/total-budget correctness, 220
round trips/440 submitted statements for finite qualification and 100 admin trips
of at most four statements for setup/reset/inspection/snapshots/cleanup. Planned
Step 2 totals: 7,720 round trips/8,240 explicitly submitted statements. Caps are
the planned totals plus 5%: 8,106 round trips and 8,652 statements, enforced before
any workload. Internal guard/fence/control-row work is additional and disclosed.
No automatic retry of writes. A failed trial is incomplete, never silently repeated.
Each pair gets its own bounded action (deadline 45 s, function maximum 60 s); all
started workers drain, and cleanup uses the transaction fence plus owned run lease.
A deadline miss invalidates the trial rather than extending resource consumption.
The application maxDuration and permanent routes are not changed by this proposal.

A hosted temporary role with connection limit 24 (rather than the qualified role's
8) needs explicit approval, along with role provisioning, fresh build/runtime
credential, exact source/SHA and region, workload, counters and cleanup. Local
fixture capacity is not hosted authorization. No cold-start claim or idle samples
are part of this experiment. Retain 50 ms p95 and 35 ms headroom in every repeated
warm trial; a read baseline that misses is a hosting result to report, not subtract.
Every hosted receipt records an observation time for each check, the wait
duration for any follow-up and the deployment id. The final hosted plan still
needs implementation details and independent review before consent; these numbers
do not enable any performance action today.
