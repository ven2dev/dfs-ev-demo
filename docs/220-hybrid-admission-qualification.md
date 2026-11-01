# #220 hybrid admission qualification

Status: owner-approved **local commit only**, 2026-10-31. #220 stays open.
No push, PR, issue posting, hosted execution or real provider call is authorized.
Branch: `feature/dfsEV-220-hybrid-admission-qualification`.
Durable worktree: `/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-220`.
Base: `71cdd90e11cbee7ec6b0eb1961322d40c49a20e9`.

## Current Design basis

### Pattern

Use database-owned atomic multi-resource admission: lock catalog-approved
per-market resources in sorted order, recheck freshness/held leases, lock bounded
GCRA subject rows in sorted order, and reserve credit on the single account row.
Only successful reservation advances theoretical arrival timestamps and installs
leases. One submitted SELECT commits these effects before a provider callback;
no transaction or session lock spans provider I/O. Followers never evaluate or
advance GCRA and cache hits incur no added limiter SQL.

Account availability is the latest accepted provider quota snapshot minus
unresolved reservation liability, clamped at zero. The account row maintains
that aggregate transactionally; reconciliation settles known responses even
out of order and re-syncs from the newest retained snapshot. Hot-path work is
bounded without scanning the growing ledger. Tests audit the aggregate against
SUM of unresolved ledger liabilities.

Stale quota uses an account-wide free-observation lease with the same DB-clock
singleflight and owner-fencing pattern. A mocked zero-credit /events observation
runs outside the transaction, records a trustworthy snapshot and releases that
lease before atomic paid admission is retried. This lease is not paid leadership
and consumes neither GCRA nor a credit reservation.

### Alternatives

- Lease then GCRA then separate reservation needs provisional ownership and
  compensation on a budget refusal; undoing TAT after later admissions can
  restore another caller's allowance. The atomic candidate avoids both races.
- Process-local coalescing cannot coordinate Vercel instances. GCRA before
  leadership can charge followers. Per-market sorted rows avoid the 4,095
  possible market-set keys per event without partitioning work by player.
- Downward-only quota estimates strand credits under normal concurrent use;
  independent refunds can escape a newer observation. Rebase from the retained
  snapshot minus pending liability instead. Per-request ledger SUM would add
  unbounded work, so keep a transactionally maintained aggregate.
- Per-market free probes duplicate account-wide observations; relying only on
  a 15-minute collector cannot maintain a five-minute freshness window. Holding
  a DB transaction across that request retains locks/connections unnecessarily.

### Targets

- Zero added limiter SQL/round trips for fresh hits and zero follower charges;
  this prevents cheap traffic from becoming admission writes.
- One warm combined admission statement/round trip, two including the existing
  cache read; one reservation/subject charge per batch, not per market.
- At most 12 sorted resource rows and two sorted subject rows per request;
  lock ordering prevents opposite-order deadlocks.
- Twenty eligible distinct paid leaders admit without an artificial concurrency
  cap while credit permits. Correctly bounded costs preserve the collector floor.
- Twenty stale callers coalesce one mocked free observation; ordinary out-of-order
  cheaper responses eventually recover to the true retained provider balance.
- The 20-event / 12-market fixture has at most 240 resource rows and 1 MiB logical
  payload for 4 KiB synthetic payloads. Real payload size/catalog retention and
  production stale eligibility are separate design gates.
- Historical hosted 64.294 ms remains a miss against 50/35 ms. Proposed warm
  200 ms p95 / <=140 ms acceptance in every 20-leader round is not approved by
  these local results. Stale-quota recovery is reported separately; see #222 gates.

### Requirement reasons and assumptions

Database clocks and trusted, bounded identities prevent forged time/policy inputs.
Resource-lock freshness rechecks prevent duplicate leaders after a racing publish.
All-or-none GCRA advancement prevents partial allowance consumption. Budget refusal
installs no owned lease and consumes no allowance, preventing charges or waits
without paid work. Fenced publication refuses expired/replaced owners. Stable
per-lease UUIDs prevent a later legitimate refresh being mistaken for a replay.
Server-enforced statement/lock timeouts bound failures. No SQL schema default
guesses provider credit or a quota period; synthetic fixtures initialize them
explicitly. Execute-only roles, production identity/HMAC and rollout integration
are not claimed by this prototype.

Assumptions: existing Vercel/PostgreSQL stack, one provider account, all paid
uses routed through the authority, and an explicitly initialized quota period/
plan total. Local fixture: PostgreSQL 18.6 standard pinned image, measured
524,288 KiB tmpfs, loopback port 54362, Node 24.18.1 and existing pg 8.23.1.
Other tasks' databases, installed dependencies and application credentials were
not modified. No real HTTP, managed-Neon, auth/HMAC or production application
integration is proven by this local spike.

## Current mechanism

### Atomic leadership, fairness and reservation

`spike220.admit` locks sorted per-market resources and rechecks freshness. A
fresh result or held stale resource returns before subject/budget work. For
partial overlap, the caller follows before acquiring any paid lease; after
publication, a later admission claims only the remaining stale markets. Empty
placeholders may exist after denial, but neither owned leases nor TAT advancement
are installed. A batched request reserves its missing-market worst-case cost
once and advances each applicable subject once. The mock adapter serves eligible
flagged stale data on GCRA/budget denial, or the corresponding typed denial if
none exists. Production eligibility and HTTP/SSE presentation remain later work.

### Snapshot reconciliation

```
max(0, latest accepted provider remaining - unresolved reserved liability)
```

Reserve increments pending liability. A trusted paid response removes its
settled reservation even when that response is older than the retained snapshot;
no additive refund can escape that newer account view. Example proved: start
at 100, reserve 3 for A and B (available 94). B arrives with actual 1 / remaining
98 / used 2: retain A's pending 3, giving 95. A later arrives with actual 1 /
older remaining 99 / used 1: retain the newer remaining 98, remove pending 3,
giving 98. Twenty overlapping cheaper requests also reconcile in shuffled order
to the exact final provider balance with pending zero.

Within the initialized period, x-requests-used orders accepted snapshots;
remaining plus used is checked against the initialized quota total. HTTP arrival
time alone cannot authorize upward credit. Lower used counters do not silently
open a new period. Missing, malformed, future or inconsistent headers do not
restore credit/freshness; actual cost is recorded and liability retained. Trusted
metadata repair can settle a record without another provider send. This ordering
assumes coherent per-account counters within a period, not a provider-issued
linearizable snapshot sequence/epoch. Real header qualification remains required.

No-response/timeout liabilities currently remain outstanding indefinitely and
can be counted twice by later snapshots. This limitation is explicitly carried
to #222 rather than claimed as fixed by ordinary response reconciliation.

### Free quota observation

`fetchSlateEvents` already exposes remaining/used/last quota metadata. The
[provider's GET events documentation](https://the-odds-api.com/liveapi/guides/v4/#get-events)
describes a zero-credit call with those headers. Only that public documentation
was read; no actual provider API request or credential was used.

After cache/paid-resource follower checks, stale quota returns quota-stale with
no paid lease/GCRA charge/reservation. The wrapper claims the account-wide probe
lease, makes the mock /events call outside every transaction, applies a fenced
snapshot finish, and retries paid admission. Twenty distinct event callers share
one mocked observation. Its independent upstream 70 remaining / 30 used replaces
an older 100/0 view; twenty cost-1 admissions leave available credit 50.

Failed probes back off and recover; expired/replaced owners cannot publish.
Fresh cache hits and existing paid-resource followers do not trigger a probe.
If observation fails, eligible stale data stays visibly stale; otherwise the
response is typed observation-unavailable. The five-minute drift-check interval
is provisional and does not rely on the collector's stated 15-minute cadence.
Existing collector observations should feed the same authority when integrated.
No interval prevents an uncoordinated external key user spending between readings.

**Prototype limitation:** followers currently poll in the accelerated mock (5 ms,
at most 200 polls). This is evidence of coalescing, not an approved serving design.
The #222 gate below replaces polling with immediate stale/typed return; a later
SSE tick retries. The current harness was not changed to pretend that future
behavior has already passed. Its lease/backoff values are fixture parameters.

### Actual-cost anomalies

Actual costs above reservation are persisted and flagged instead of rejected.
Trusted quota rebases balance even to zero; missing headers retain liability at
least as large as actual cost. The sticky cost-overrun breaker then refuses paid
work pending review, collector included. This does not undo an already-made
unexpected charge or restore a collector reserve it already consumed.

Proved: reserve 3 from 25, actual 25 / remaining 0 / used 25 records the anomaly,
leaves balance zero and refuses further paid admission. With missing metadata,
reserve 3 then actual 8 from 100 records liability 8 and balance 92, with the
breaker set. An unexpected charge on the nominally free probe is also recorded
as a cost-zero expected attempt with actual cost, not silently discarded.

## Iteration 3 verification and measurement


**35 local behavior checks pass**. Receipt:
`docs/evidence/220-qualification/local-iteration-3.json`.

The fixture is unchanged PostgreSQL 18.6 / measured 524,288 KiB tmpfs / Node
24.18.1 / pg 8.23.1 on isolated loopback port 54362. Two independent pools model
instances. Provider reads/sends are mocks only; app routes, auth/HMAC, real HTTP
transport and hosted quota behavior are not claimed as validated.

| 20-worker round | Cache-read baseline p95 | Atomic lease/GCRA/budget, distinct subjects p95 | Same atomic operation, shared subjects p95 | Cache read + atomic warm paid admission p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1.135 ms | 12.263 ms | 13.160 ms | 9.537 ms |
| 2 | 1.083 ms | 9.922 ms | 13.298 ms | 10.338 ms |
| 3 | 0.975 ms | 10.352 ms | 13.474 ms | 8.920 ms |

Three alternating 1,000-successful-sample rounds per mode run at both one and
20 workers. High fixture bursts avoid manufacturing a speed pass through
rejections. Warm quota is deliberately fresh in this timing matrix. A counted
mock post-provider lease release is outside pre-provider timing. The single
account row still serializes paid leaders; no durability change, user cap or
lower-concurrency substitute hides that hotspot. These local numbers are not
hosted p95 acceptance or proof of the proposed 200/140 ms budget.

### Work budgets

- Fresh cache hit: one existing read; zero added limiter/reservation/probe SQL.
- Warm paid leader: one combined lease/GCRA/reservation statement and round trip;
  two total including the existing cache read. Internal lock/counter/ledger work
  is disclosed separately in the receipt, not disguised by the single SELECT.
- Reconcile: one submitted call; maintained account aggregate updates are fixed
  per attempt, without scanning the growing ledger. Full SUM checks are tests.
- Stale-quota probe leader: cache read + quota-stale admission + probe claim +
  fenced snapshot finish + retried paid admission: five SQL calls before the
  paid mock starts, plus one mocked free-provider HTTP call. The local harness
  obtains a trusted fixture timestamp with an additional diagnostic SQL query;
  production response capture would not use that query. Actual telemetry SQL
  from real fetchSlateEvents also needs inclusion in the application budget.
- Probe followers: one claim query per bounded poll, not another provider call.
  With the accelerated 200-poll cap, a caller can use up to 203 pre-provider SQL
  calls (read, stale check, polls, retry); this is a disclosed worst-case test
  bound, not a production budget approval. Failure paths do a freshness recheck
  before refusing, and no paid call follows an unresolved failure.
- Final run: 49,932 counted query messages under 60,000.
  Setup contains 14 top-level statements in one message; two schema-cleanup
  queries are outside the counter. Conservative top-level statement bound:
  60,015, separate from internal function statements.

The schema and owned compose project were removed and absence verified. Full
logs are durable outside Git as `220-iteration-3.log` in the chat visualizations
directory. A first test setup hit integer/bigint parameter inference and was
fixed with an explicit fixture cast; that diagnostic is retained separately.
Later reruns added independent upstream, recovery, stale-fallback and explicit
initialization coverage. No guessed quota is seeded by schema defaults; test
fixtures explicitly initialize their synthetic total/period.

## Gates carried to #222

These are before-enforce requirements, not changes implemented or proven by this
commit. They prevent an honest local spike being treated as release readiness.

### a. Release unresolved liability after a covering accepted snapshot

Today a no-response/timeout reservation stays in pending liability forever and
is double-counted by later snapshots, eventually stranding credits. Implement
release once an accepted snapshot's trusted observation time is later than the
attempt's reserve time + bounded request timeout + safety margin, for example
**20 s + 60 s = 80 s**. The snapshot, liability release, account aggregate and
idempotent resolution record need one atomic update so concurrent reconciliation
or repeat cleanup cannot release twice.

Prove the request cannot start/resume a paid send after its bounded deadline,
and distinguish a covering snapshot's observation time from merely a delayed
HTTP arrival; otherwise time-based release could admit still-unaccounted work.
Test the 80-second boundary, no-response/timeouts, late responses, retries,
concurrent snapshot/reconciliation, and expired owners. Unknown/new quota periods
need explicit operator handling rather than using a mismatched snapshot to
release liability. This gate replaces indefinite retention without silently
refund-and-resending an ambiguous attempt.

### b. Observable breakers and operator recovery

The cost-overrun breaker and quota-period/plan-total validation can stop **all
paid work, collector included**, without a useful health-route explanation.
Before enforce, provide distinct stable health-route reason codes (for example
`provider-cost-overrun` and `quota-period-or-plan-mismatch`) so this is not a
silent outage. The prototype can leave a mismatch unresolved until freshness
fails; the serving design needs an explicit documented state and diagnostics.

Add an appropriately restricted, audited **operator reset/reinitialization
function** plus runbook steps for monthly quota reset and plan changes. Validate
current provider observations, new period/plan total, outstanding liabilities
and sticky breaker disposition; preserve attempt history and prevent duplicate
reset/release. Health/operator output exposes no credentials or unnecessary
subject/account details. No automatic inferred allowance or production operator
write is authorized by this commit.

### c. Free-probe followers return immediately

Free-probe followers **do not poll** in the application design. They immediately
return the eligible cached value with a visible stale flag, or typed
observation-unavailable if none exists. The next SSE tick retries. This avoids
turning one coalesced free call into a DB polling amplification path. Retain the
single account-wide free leader, owner/expiry fencing, failure backoff and no
paid GCRA/reservation charge for its followers. Replace the accelerated polling
mock and update its work budgets/regressions before enforce; do not copy its
200-poll allowance into production.

### d. Deadline scope and hosted qualification

- **Warm-quota path:** proposed **200 ms p95**, requiring **<=140 ms in every
  repeated 20-leader round** for 30% headroom. Measure the atomic hotspot and
  full warm pre-provider path, retaining all statement/transport work.
- **Stale-quota path:** report separately as **warm path + one /events call**,
  including observation claim/finish, telemetry and any retry/coordination work.
  Set its target from hosted measurement; returning followers follow gate c.

Both remain proposals until the hosted test and owner decision. Hosted testing
is **still unauthorized**. Historical 64.294 ms versus 50/35 ms remains a miss;
local pg results neither pass that target nor prove the proposed hosted SLO.
No user cap, weaker durability or lower worker fixture can manufacture a pass.

## Remaining review and release boundary

#220 stays open. Owner authorized this qualification checkpoint commit only.
No push, PR, issue posting, hosted deployment, hosted SQL, real free/paid provider
call, released migration or downstream implementation is authorized. SQL remains
in `packages/db/proposals/`; nothing under `packages/db/migrations/` changes.

Alongside the explicit #222 gates, real web/identity/HMAC wiring, catalog
population/retention, stale eligibility, execute-only production roles, actual
header/epoch semantics and WAF availability remain separately reviewed work.
Rate values (network 60/min, burst 30; signed-in user 6/min, burst 6) are log-only
candidates. Log-only → observed initialization → enforce and rollback still need
application integration/proof. Future scope estimated above six hours is split.

## Short history — Iterations 1 and 2

- **Iteration 1:** 17 local checks proved atomic lease/GCRA, freshness recheck,
  follower bypass and bounded sample variants. Separate budget reservation left
  lease/charge cleanup defects; key-per-market-set analysis exposed up to 81,900
  keys for 20 events. One-way quota adjustments could strand concurrent credit.
- **Iteration 2:** 23 checks combined sorted per-market leases, GCRA and budget
  atomically; proved 240 resource rows, unique lease attempts, flagged stale
  responses and recorded overrun cost. Its conservative older-response refund
  rule still stranded credit, and genuinely idle quota needed free observation.
- **Iteration 3 (current):** 35 checks added snapshot-minus-pending reconciliation,
  on-demand account-wide free-probe coalescing/recovery and actual-cost anomalies.
  The unresolved-liability, serving/polling and operator/deadline gaps above are
  explicitly carried forward rather than labeled as production passes.

Earlier JSON receipts/checkpoints retain their original hashes/paths as historical
records; they are not current-source manifests. Exact earlier source/report
archives and full logs stay outside Git in the durable chat visualizations
directory. `checkpoint-iteration-3.json` now verifies the current consolidated
document and unchanged Iteration 3 SQL/harness/receipt. The separate Iteration 2
and 3 report files are removed; this is the single report for the checkpoint.
