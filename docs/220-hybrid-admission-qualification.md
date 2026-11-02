# #220 hybrid admission qualification

Status: Iteration 4 review fixes are **uncommitted for owner review**, 2026-11-01.
PR #226 remains unchanged at 4df07f6; #220 stays open. No new commit, push, issue
posting, hosted execution or real provider call is authorized in this correction.
Branch: `feature/dfsEV-220-hybrid-admission-qualification`.
Durable worktree: `/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-220`.
Review-fix base: `4df07f62a36ad46e4d577518e860bd0231e43f40`. Earlier receipts
retain their original measurement bases.

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

### Iteration 4 review-fix basis (local, before implementation)

Probe recovery follows bounded exponential retry plus a terminal circuit breaker
with explicit operator reinitialization. Reject fixed one-second retries because
permanent misconfiguration amplifies free calls indefinitely; reject automatic
period/plan inference because it could invent credit or discard pending liability.
The transient cap is 60 seconds, limiting repeated probes while allowing recovery
within roughly a minute. Terminal health reasons are readable SQL state only;
no application or collector-health route changes belong to this correction.
The operator primitive preserves liabilities and refuses a period change while
old liabilities remain. A serving/audited production reset remains a #222 gate.

### Round 2 confirmation basis (before implementation)

Use a debounced circuit breaker: the first reduced-counter or plan-total mismatch
is a suspicion with normal capped backoff; only the next completed probe with
the same condition latches needs-init. Accepted/initialized state clears the
suspicion; a different completed outcome replaces it. Reject immediate latching
because an ordinary reordered reading can trigger manual-recovery downtime;
reject indefinite retry of a confirmed change because operator setup is needed
before trusting a changed account baseline. Missing budget and our own period
label mismatch remain immediately terminal. This is a confirmation policy, not
proof of provider ordering; repeated delayed/inconsistent provider readings still
need real-header qualification before enforce.

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
- Historical hosted 64.294 ms remains a miss against 50/35 ms. That figure was
  most likely measured across regions (iad1 functions and an AWS us-west-2
  database), is not evidence against the single-row debit design, and must be
  resolved by the hosted iad1/pdx1 comparison. Proposed warm
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
open a new period. Missing, malformed, future or mismatched headers do not
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

Transient failures (missing headers/network observations, older observations
and an expired current owner) back off exponentially: 1, 2, 4, 8, 16, 32, then
60 seconds, capped there to limit probe amplification while retaining recovery.
A replaced owner cannot change its replacement's lease or backoff. Missing
budget and our own period-label mismatch latch needs-init immediately, with
health_reason budget-uninitialized or quota-period-mismatch. A first lower-used
reading or plan-total mismatch instead records suspect_reason as
quota-counter-reset or quota-plan-mismatch and a suspected-* health reason,
sets normal capped backoff, and leaves needs_init false. Only the next completed
probe with the same condition confirms the terminal reason. An accepted probe
or initialization clears suspicion; a different completed outcome replaces it.
Follower/backoff claims and stale replaced-owner finishes do not confirm a
suspicion. claim_probe returns needs-init even
if another observation makes the budget fresh. These callers retain the flagged
stale/typed-unavailable policy and make no additional free call. Only the local
operator initialize_budget primitive clears this terminal state; it preserves
liability and sticky overrun and refuses an unresolved prior-period rollover.
This is not a production-authorized reset/health route or audited operator API.
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

## Iteration 4, review round 2 verification and per-finding report

**47 local behavior checks passed: all 44 prior cases (with reset/plan expectations
updated) plus three new confirmation/reordering regressions.**
Six full timing trials passed (one and 20 workers, three rounds each, four modes,
1,000 successful samples per mode). The fixture was PostgreSQL 18.6 / measured
524,288 KiB tmpfs / loopback 54362. Provider calls remain mocks only.

| Finding | Result and regression evidence |
| --- | --- |
| 1. Probe recovery (round 2) | Fixed: capped exponential delay; missing budget/period mismatch latch immediately. First counter-reset/plan-total suspicion backs off without a latch; a second consecutive matching probe confirms it. Twenty reset claims make exactly two free calls before the latch, then one more after initialization. Reordered paid/free readings recover, acceptance clears suspicion, and different completions replace it. All previous stale/coalescing cases pass. |
| 2. Late-stale duplicate retry | Fixed: refresh retry gets a fresh UUID; late stale deletes its newly denied audit row. A fixture-only BEFORE INSERT subject trigger ages the budget after the early check but before reserve. Fresh-ID and accidental same-ID retries both become leader with exactly one reservation. |
| 3. Historical baseline | Fixed at both occurrences: 64.294 ms most likely crossed iad1/us-west-2, does not disprove the debit design, and needs the hosted iad1/pdx1 comparison. The 50/35 ms targets are unchanged. |
| 4. Redundant state | Removed the unreachable state branch; a comment explains that fixed-total validation already determines remaining when used is unchanged. |
| 5. Validation ownership | Reconcile settles only on observe's validated accepted/older/older-or-reset result plus used >= actual cost. Invalid period/sum/future/missing metadata remain unsettled; valid older repair settles without additive credit drift. |
| 6. Reproducible evidence | Explicit output argument and exclusive write; an existing-file run exits 1 before DB setup and leaves the receipt unchanged. Current receipt carries exact script and SQL Git blob OIDs. Older measured values are unchanged and marked superseded. |

Terminal-window regressions advance retry_after on the disposable fixture past
the 60-second cap, rather than sleeping for wall-clock windows. They prove that
elapsed backoff alone cannot clear needs-init; they do not claim an elapsed-time
production trial. Full live free-provider and hosted behavior remain untested.

Command executed (exit 0):

```sh
/Users/vernonneilly/.nvm/versions/node/v24.18.1/bin/node scripts/spikes/220-qualification.mjs pg /Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-220/docs/evidence/220-qualification/local-iteration-4.json
```

Captured output summary: **47 PASS lines, 6 TRIAL lines, RECEIPT saved at the
explicit path**. Full command output:
[220-iteration-4-round-2.log](/Users/vernonneilly/.codex/visualizations/2026/10/20/01a15791-1e78-7a32-835c-66df7c6a005a/220-iteration-4-round-2.log).
Every behavior-case name and trial result is also in the generated JSON.

| Current 20-worker round | Baseline p95 | Distinct-subject atomic p95 | Shared-subject atomic p95 | Warm mock paid path p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1.116 ms | 12.630 ms | 15.273 ms | 9.787 ms |
| 2 | 0.918 ms | 9.789 ms | 13.503 ms | 9.704 ms |
| 3 | 1.169 ms | 10.719 ms | 15.132 ms | 16.466 ms |

These local timings do not establish a hosted pass. The run used **50,263 counted
query messages under 60,000**. Schema setup has 16 top-level statements in one
message; the two fixture trigger create/drop pairs add four extra top-level
statements beyond counted messages. Two final schema cleanup/absence queries are
outside the counter. Conservative top-level statement bound: 60,021; internal
PL/pgSQL statements remain separate from submitted round trips. Normal admission
still makes one submitted combined call; initialization's liability scan is
operator/test setup work, not admission work.

Schema absence was verified, then the owned compose fixture was removed. Node
syntax and targeted script ESLint passed; no application or migration source
changed, so no application-suite claim is made for this scoped spike correction.

### Evidence index

| Receipt | Status |
| --- | --- |
| local.json | Historical; measured values preserved; superseded by local-iteration-4.json |
| local-iteration-2.json | Historical; measured values preserved; superseded by local-iteration-4.json |
| local-iteration-3.json | Historical; measured values preserved; superseded by local-iteration-4.json |
| local-iteration-4.json | Current review round 2; deleted/regenerated by exact final script, identified by Git blob OID |
| checkpoint-iteration-4.json | Current source, command/output, scope and cleanup checks |

The reviewed script Git blob is `477c47e141ae68ca6bbd276f0163f5a91ade3101`. Files are still
uncommitted under the owner's review gate: the receipt does not claim the new
script is already in HEAD. After commit approval, verify the committed script
blob equals this OID. This permits exact committed-script provenance without
committing before the requested review or inventing a self-referential commit ID.

## Historical Iteration 3 verification and measurement


**35 historical local behavior checks passed** against Iteration 3 source. Receipt:
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
- Historical Iteration 3 run: 49,932 counted query messages under 60,000.
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
is **still unauthorized**. Historical 64.294 ms versus 50/35 ms remains a miss.
That figure was most likely measured across regions (iad1 functions and an AWS
us-west-2 database), is not evidence against the single-row debit design, and
must be resolved by the hosted iad1/pdx1 comparison. Local pg results neither
pass that target nor prove the proposed hosted SLO.
No user cap, weaker durability or lower worker fixture can manufacture a pass.

### e. Admission retry identity and probe recovery hand-off

A quota-stale → refresh → retry takes a fresh attempt UUID. An attempt identifies
one admission try, not a logical request. The late stale branch removes its own
newly denied audit row before returning; a deterministic regression also proves
that an accidental same-ID retry is not trapped as replay. Only the successful
try installs a lease and one reservation. Preserve this behavior in #222.

Carry forward the bounded transient backoff, two-completed-probe confirmation
rule, terminal health reasons and operator-only clearing rule. A free reading
may arrive after a paid reconcile has advanced provider_used, so one lower-used
reading must remain a suspicion rather than cause an operator-recovery outage.
The same applies to one plan-total mismatch. Only a matching condition on the
next completed probe latches; accepted/initialization clears suspect_reason,
and a different completion replaces it. Missing budget and our own period label
mismatch are immediately terminal. This reduces single-reading false positives;
it is not a guarantee that a provider cannot return repeated reordered readings. The local initialization primitive preserves
liability and sticky overrun; the fuller audited reset/runbook/health integration
in gate b remains required. Reconcile now relies on observe's validated result
and used >= actual cost rather than duplicating provider-header rules; observe
validates before returning any accepted/older/older-or-reset state.

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
- **Iteration 3 (historical):** 35 checks added snapshot-minus-pending reconciliation,
  on-demand account-wide free-probe coalescing/recovery and actual-cost anomalies.
  The unresolved-liability, serving/polling and operator/deadline gaps above are
  explicitly carried forward rather than labeled as production passes.

Earlier receipt measurements are preserved. local.json, local-iteration-2.json
and local-iteration-3.json now carry historical/superseded metadata; their measured
values are unchanged. Older checkpoint hashes describe the pre-annotation JSON
and earlier SQL/script/doc bytes, not current-source manifests. Archives and
full logs remain outside Git. The current checkpoint manifest is
checkpoint-iteration-4.json; the new generated receipt includes exact script and
SQL Git blob IDs for commit verification after owner approval.


## Round 2 review return

The final SQL/script implement the two-completed-probe confirmation policy.
The reordered-reading test claims a free probe, records a paid reconciliation
first, then finishes the older probe: no latch, backoff/suspected health state,
accepted next probe, resumed paid refresh and intact liability invariant. Reset
and plan mismatch require consecutive confirmation; an accepted or different
completion clears/replaces suspicion. Missing budget and period mismatch still
latch on the first probe. Initialization clears both terminal state and suspicion.

Round-1 uncommitted receipt/checkpoint were archived outside Git as
220-round-1-local-iteration-4.json and 220-round-1-checkpoint-iteration-4.json.
The old untracked receipt was deleted, then regenerated exclusively from the
final script and SQL. No old measured values in historical Iterations 1–3 were
changed. Current Git blob IDs were verified against disk and recorded in the
receipt/checkpoint. As before, committed-blob verification awaits owner approval;
no commit, push, hosted work, migration or application edit occurred.
