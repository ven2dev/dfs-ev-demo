# #222 provider credits at the paid-call boundary

Status: roadmap approved; owner authorized ALT to create the implementation branch. Branch `feature/dfsEV-222-paid-boundary-reservation` starts at main `c15e6949c42f7288f09fcb3ad996ab5d19d51c1e`. Checkpoint 1 committed as `7db5eccef3b50c2bdaa1c6f9b18e1c04ea19c723`; checkpoint 2 is implemented and uncommitted for review. No push. #295 owns the deferred observer/reset/breaker work and is a verified dependency of #224; #294 owns provider/driver and hosted timing. #222 acceptance posting and #206 closing remain separate owner approvals.

The pre-branch synthetic spike passed 29 named checks plus 20-client/two-backend transaction pooling. Its source/log/receipt hashes remain in the private planning archive; this document distinguishes that historical prototype from new real-table implementation tests. No hosted/provider calls or real credentials are authorized.

## Design basis

**Pattern:** atomic durable conditional reservation on one shared account row with an idempotent attempt audit and maintained unresolved-liability aggregate. Web owns the paid-callback boundary; DB exports query primitives, not fetch orchestration. Commit reservation before the paid send; hold no database transaction over provider HTTP. Read current raw-owner or collector-checkpoint ownership without locking those rows; lock/debit the account only. Use a nominal accepted-reservation capability from the primitive and a structural source guard for the sole paid transport boundary.

**Alternatives:**

1. Post-call accounting cannot prevent concurrent overspend or collector-floor breaches.
2. Per-process counters, sharded accounts and batch credit leases weaken the chosen single-account truth and change recovery/durability; no new accounting model is approved.
3. Holding account/resource locks over HTTP retains pooled backends and serializes provider latency. Resource FOR UPDATE before reservation adds lock scope without a demonstrated correctness benefit; the scratch instead proved a plain ownership read after an account wait sees a replaced owner.
4. Copying #220's combined cache/GCRA admission coordinator would duplicate #221's lifecycle and pull #223 into this scope. Keep the existing cache authority and reserve in its prospective paid callback; later fairness can compose under the same admission allocation.

**Targets:** full warm pre-provider path **90 ms = four cache statements 10 ms + admission 53 ms + headroom 27 ms**. The 53 ms share is informed by **PlanetScale #220**, whose admission rounds were 55.07 / 53.16 / 57.71 ms, not a measured Neon guarantee. Reservation and later #223 fairness share 53 ms; neither gets a second allowance. Twenty distinct eligible leaders stay in the fixture; denials do not substitute for successful eligible work. #222 local qualification is correctness and deterministic work ONLY. Hosted timing and the production PostgreSQL provider/driver wait for #294 and separate authorization. No web-driver selection/change in #222.

**Requirement reasons:**

- Atomic reserve/audit prevents spend authority without its debit and history. Idempotent operation IDs bind account/period/class/owner/canonical request/cost, preventing duplicated debit and provider sends after replay or lost replies.
- Unknown outcomes keep worst-case liability until audited operator resolution; elapsed time, cancellation or a late quota snapshot cannot restore spend authority. This prevents refunds of still-possible paid work.
- Interactive work preserves collector floor; trusted collector work preserves zero, preventing interactive quota theft and negative balances. Disabling WAF/GCRA in tests makes this independent of other defenses.
- Zero reservation/reconciliation writes on cache hits/followers avoids amplification of cheap traffic. Existing cache poll/renewal budgets remain counted separately.
- Plain ownership validation after account-lock acquisition and a pre-send abort/deadline check refuse stale callbacks without adding resource locks. This does not promise exactly-once external execution or prove a provider stopped an accepted request.
- No session advisory locks, SET without LOCAL (including set_config(...,false)), named prepared statements, temp tables or LISTEN/NOTIFY in new reservation SQL/adapter, preventing transaction-pool session dependence. No implicit search_path. Normal parameterized calls and fully qualified names suffice.
- Server deadlines bound abandoned SQL; verify backend defaults before pool proof. Local volatile tmpfs/settings are not production durability qualification.
- Typed unresolvedLiabilityTotal/unresolvedLiabilityCount make stranded credit visible rather than a silent exhaustion. Owner-approved warning/critical policy affects visibility, not authorization/refunds.
- Enforce refuses uninitialized/stale/unknown budget and DB failure to prevent unaccounted sends. Log-only continues existing live refresh on storage failure because the owner explicitly selected non-protective rollout compatibility; sanitized accounting failure stays visible.
- Restricted audited operator operations prevent routine callers forgiving debt. No key, connection string, credential-bearing URL or unnecessary subject identity enters logs/receipts.
- Proposal-only DDL and no driver edit preserve separate migration/provider/activation decisions. No hosted apply or automatic production enforcement.

**Assumptions:** one trusted app-controlled provider account, fixed US event-odds selectors and bounded market cost policy, no uncoordinated external key spend, coherent same-period provider counters (not a linearizable provider epoch), explicit observed initialization and collector floor, PostgreSQL 18/Read Committed/normal durable commit policy, Vercel Node. External key users or unqualified header semantics block an account-wide safety claim. No inferred monthly quota reset or weaker durability. Weather and #221 payload freshness/cooldown semantics stay unchanged.

## Qualification and evidence

Spike: `222-paid-boundary-reservation`. Candidate SQL remains at `packages/db/proposals/222_provider_credit_reservations.sql` on this branch. The archived scratch has the same basename but remains separate historical evidence. No immutable migration is created/frozen here.

Synthetic fixture: `provider-credit-222-v1`, PostgreSQL 18/512 MiB lane-2 standard, 20 event identities × up to 12 canonical synthetic markets, one account/period, two app-query adapters, 20 concurrent prospective leaders, public disposable identities and mocked provider transport. Paid source/owner kinds include raw/interactive and collector; the scratch ownership table models the real tables rather than importing new production resource tables. Actual app/schema integration remains checkpoint work.

Results:

- **29 named correctness/work checks pass**: 25 main checks and four extra failure/race checks on the final 240-market-owner fixture. `qualification-final.json`, `multiplex-final.json` and `extra-checks-final.json` identify the current candidate; initial event-level receipts remain historical.
- Separate multiplexing proof: **20 clients, exactly two server backends, 20 reservation calls and 100 counted control/isolation calls**.
- Warm eligible leaders: exactly one reservation statement/round trip per leader, one audit/debit and one mock send. All 20 cost-12 leaders reserve 240 total against 1,000 credits. Exact-floor and mixed collector/interactive contention preserve the applicable floor/zero.
- All 20 initial backends report statement 5s / lock 2s / idle-transaction 5s defaults. Statement/lock cancellation, idle termination, fresh borrower recovery and disconnect rollback pass.
- Resource row held FOR UPDATE does not block reservation; ownership replaced during account wait is refused. No resource-lock exception is requested.
- Audit failure rolls back liability; replay does not resend; changed identities/cost conflict; lost reply/abort/no response retain liability past 80 seconds. Shuffled known responses and operator/reconcile races cannot double-release.
- Historical scratch result: operator initialization/resolution is audited, idempotent and refused to the runner; its old policy blocked rollover with prior-period liabilities. The owner has superseded that policy with carry-forward (below); checkpoint 1 implements and tests the replacement carry-forward behavior. Headers-only evidence remains insufficient for unknown release.
- Nominal type contract compiles with an expected rejection for forged plain objects. Runtime single-use capabilities reject casts/reuse. Binding a capability to the existing claim deadline/abort and refusing a paused late sender is required during real-path integration; the scratch does not claim that lifetime seam is implemented. Provider source guard scanned 202 application/package sources and rejects four injected bypasses. This is a trusted-source CI architecture guard, not a guarantee against arbitrary malicious obfuscation.
- 10,000 settled audit rows retain one reservation call and indexed attempt-ID lookup. Complete serving plans/buffer budgets remain implementation validation, not an inferred pass.

PgBouncer 1.25.2 is pinned at `edoburu/pgbouncer@sha256:4a8371e79d6627e74f553d0aaa8e4c5ace20e30034fb296e569b71c89c99e108`; transaction mode, pool sizes 20/2, named prepares disabled. Only `compose.spike.yml` adds the sidecar/commit settings; shared lane configuration is unchanged. PGDATA capacity measured 524,288 KiB. Owner confirmed the quiet window; both owned containers/network were removed and independent listings were empty. The test-run lifecycle's direct-admin session lock is infrastructure isolation, not reservation SQL.

Retain four main attempt logs: first fixture bigint-inference correction, then SQL guard UPDATE SET false positive, then an initial 25-check pass, and a final 25-check pass on 240 per-market owner rows. Raw successful receipts and extra/multiplex logs stay unchanged with a separate SHA-256 wrapper. No real provider HTTP, real credentials, hosted activity, local timing acceptance or production durability claim.

## Owner decisions recorded

- Unknown-outcome worst-case liability remains until audited operator resolution, accepting conservative double-counting. This supersedes the old #220 proposal to automatically release after a covering snapshot/time interval; acceptance update needs separate posting approval.
- Log-only storage failure continues refresh with sanitized shadow-accounting failure; enforce refuses.
- Reuse bounded account-wide free-observation recovery with immediate follower returns is the selected eventual design; its implementation moves to the split follow-up below rather than being replaced by another mechanism.
- Retain #221's conservative 20-second cooldown after a budget denial; prompt next-subject release/fairness is #223. No cooldown-clearing cache proposal in #222.
- Owner approved lock-free resource ownership validation, typed structural choke point, visible stranded credits and the six-hour split. No concrete test warrants a resource lock.

## Scope split and release boundary

Including production free-observer recovery and the serving actual-cost breaker is re-estimated at **6.5–7.25 active hours**. Apply the approved split now: those two move together to #295, filed with owner approval, labelled phase:8/type:feature, added to the project board and made an explicit dependency of #224.

Core #222 keeps reservation, known-response reconciliation, conservative unknown liabilities, log-only/enforce contracts, collector floor, operator initialization/resolution, health fields/runbook and CI choke-point/work guards. Estimated **5.0–5.75 active hours total including qualification**, excluding independent review/approval waits and hosted work. Six hours remains the stop line; split further before exceeding it.

Before the follow-up is qualified, stale quota in enforce returns stale/unavailable and sends nothing until an authorized fresh observation/operator initialization. Log-only retains existing behavior and no quota-safety claim. Keep /events explicitly free with the existing breaker contract; do not replace it with the paid capability or weaken existing behavior. The deferred observer/actual-cost breaker, real header semantics and operator/provider review remain before-enforce release gates. Finishing #222 does not authorize enforcement.

## Implementation checkpoints after final approval and owner branch creation

1. **Checkpoint 1: SQL primitives, health and operator contract — 1.25–1.5 h.** Parameterized provider-neutral reserve/reconcile/initialization/resolution proposal, maintained total/count and stable reason codes; bind canonical selectors/owner/class. Derive collector cost from the checkpoint’s canonical market set, just as interactive cost is bound to owned markets, and refuse a supplied/mismatched collector cost before debit/send. Add a collector-cost mismatch regression. No synthetic resource-table family moves to production: check actual #221 cache or collector checkpoints with plain reads. Carry the runbook's evidence procedure and proposed warning/critical values; owner approves policy before enforce. Restrict operator calls and preserve history. The scratch only proves operator function-call refusal, not execute-only serving grants; replace its invoker/table-grant fixture with reviewed hardened functions and least-privilege grants, proving direct table writes are refused before claiming that permission contract. Implement operator-initialized monthly rollover carrying all unresolved old-period liabilities into availability against the new period without relabelling original attempt provenance. They no longer block rollover and still require audited resolution. Test stranded prior-period carry-forward, reduced new-period availability, later exactly-once release and no old-header overwrite of current-period quota. Health reports period-mismatch as critical; numerical warning/critical thresholds remain proposals. Add core concurrency/work/permission regressions. Report diff before commit.
2. **Checkpoint 2: structural web boundary — 1.25–1.5 h.** Only the reservation primitive mints accepted permit types; paid fetch accepts that type, runtime one-use checks and bound selectors. Wire legacy/current-schema live/discovery, shared live/discovery, forced refresh, collector and direct internal paid calls to the sole boundary. No caller can select collector class merely by supplying a public source string. Cache hits/followers do not invoke it. Keep free events separate. Log-only shadow accounting never debits authoritative state; conservative ambiguous cases never automatically resend. Preserve actual response/HTTP-error/header/decode/abort information for reconciliation. Do not change getSql or web driver. Report diff before commit.
3. **Checkpoint 3: CI guards and integration — 1.0–1.25 h.** Install source guard in normal CI, with mutation failures for escaped base/provider fetch and compile/runtime type/capability regressions. Full root application suite, test:ci-gate/secrets inventory, lint, typecheck, build, both DB suites and catalog/readiness/current/partial-schema compatibility. Port actual raw/collector ownership race regressions through the transaction pool. Carry existing cache follower/renewal budgets unchanged; count setup/probe/operator work separately. New compact receipts and final review before commit/push/PR.

Remaining allowance covers qualification already completed and contingency; no hosted estimate is included. If integration requires an API/identity subsystem or an extra warm pre-provider round trip, report it before expanding scope or consuming headroom.

## CI work budgets to install and prove on the implementation branch

| Path | New work budget |
| --- | --- |
| Cache hit/follower/cooldown | Zero reservation/reconcile statements, zero GCRA advance and zero paid send. Existing cache reads/polls remain separately asserted. |
| Newly eligible warm paid batch | Exactly one reserve/audit statement/round trip before send, plus #221's four cache statements; one debit and one audit, no per-market fanout. |
| Denied/replayed/conflicting attempt | At most one reserve call. A new valid denied reservation retains one audit row atomically, with zero debit/provider send. Replaying its ID adds zero audit rows. Shared-key followers/cooldown returns add zero denied rows; new denied attempts are bounded by #221’s durable 20-second cooldown per key. For a batch, one denied audit row covers the attempted owned subset, not one per market. Assert audit row counts in CI; do not omit denied rows to satisfy a budget. |
| Known response/late repair | One reconcile call per explicit operation, idempotent; existing telemetry/cache/observation writes counted separately after the boundary. |
| Ambiguous reserve/provider result | Zero automatic query retry or provider resend; retain liability, no hot-path ledger cleanup scan. |
| Operator action | One explicit audited call, no duplicate release/reset; bounded maintenance scans are separate from paid requests. |
| Log-only | At most one attempted shadow-accounting call per prospective send, no implicit initialization or enforce-ledger debit. |

No per-request SUM/scan over growing history. Preserve four-cache-plus-one-admission composition; #223 later owns fairness composition within the same 53 ms share. The split follow-up gets its own free-leader/follower/backoff and anomaly work budgets; this roadmap does not claim those paths qualified.

## Runbook policy proposals and pending owner approvals

Runbook: [222 provider credit operations](222-provider-credit-operations.md). Typed total/count includes active work, so age/state is needed to distinguish stranding. Proposed warning: unresolved attempt older than 80 seconds; proposed critical: aged >300 seconds with >=10% period quota or >=20 attempts, or aged liability blocking the next bounded interactive call above the collector floor. These are unapproved visibility policy values, never automatic refund thresholds.

Quota headers support validated known-response reconciliation, not automatic forgiveness of unknown requests. Unknown resolution requires a terminal send that cannot resume plus trustworthy coverage, or provider confirmation of no charge, recorded by a restricted operator with immutable operation ID/actor/evidence. A late HTTP arrival, a timeout or a caller's assertion alone is insufficient. Actual evidence collection/verification remains an operator procedure, not something the scratch independently proves.

The owner approved this roadmap and subsequently authorized branch creation and iteration. Before posting: owner approves the #222 acceptance update and #206 closing summary separately. The split follow-up is #295. Before enforce: owner approves health policy and completes free-observer/actual-cost/header/operator/provider/activation gates. #294 owns provider/driver and hosted timing; schema freeze/apply remains a separately approved release with migration tracking. No new 90 ms deadline decision is needed.


## Current checkpoint 1 scope and decisions

- Carry-forward (owner option b): operator initialization of a new period preserves unresolved debt/count from all original periods against new availability. Preserve original attempt provenance. A later audited resolution releases once. Do not automatically roll over; that is #295 before enforce. Period expiry/mismatch reports critical and refuses enforced admission until operator initialization.
- Collector cost is derived from the checkpoint’s canonical market set; declared cost and selectors must agree. Mismatch refuses before debit and retains its denied audit.
- Denied reservation audits remain counted. #221’s durable 20-second per-key claim cooldown bounds new denied attempts on the shared path; followers/replays add no new reservation/audit. Legacy log-only compatibility makes no equivalent enforce-safety claim.
- Existing owner/checkpoint rows are plain reads; only the single account row is explicitly locked by reservation. No transaction spans provider HTTP.
- Runtime and operator functions are separately granted; tests use a non-login definer owner and deny serving roles all direct table writes. DDL creates/grants no hosted roles and freezes no migration.
- New guarded DB file providerCredits.test.ts is part of the complete core-suite report inventory, so CI cannot omit its rollover/collector/floor/audit cases. Pool checks stay in a spike-only override; production driver remains unchanged.
- Before each commit report diff and validation. No attribution trailers, no push without fresh consent.

### Checkpoint 1 validation (committed)

The proposal, provider-neutral primitives and typed health/operator contract passed 35 focused unit/policy cases, 83 core DB tests, and all 23 reservation cases through each transaction-mode pool (20 and 2 server slots). The core runner verified its mandatory Node contracts. Coverage includes carry-forward and exactly-once release, canonical collector cost, denied audit budgets, account-only locking, current-schema shadow compatibility and restricted roles. Pool diagnostics verified every allocated backend's 5s/2s/5s timeout defaults; diagnostic transactions are separate from paid-path work budgets.

Lane-2 containers and its network were removed and confirmed absent after verification. These are local correctness/work-budget results, not hosted latency or production durability qualification. See `docs/evidence/provider-credit-222/checkpoint-1.json` for hashes and limitations. The structural paid-fetch capability and provider-source CI guard remain checkpoint 2/3 work; full application/build and feature-store regression runs remain checkpoint 3. Numeric health thresholds remain proposals, not active policy. Checkpoint 1 was committed with owner approval; no push has been made.

### Checkpoint 2: paid transport boundary (uncommitted)

The reservation primitive now mints a nominal, process-local single-use permit bound to canonical markets, event, signal and a monotonic pre-send deadline. Runtime validation rejects forged, copied, reused, aborted and expired permits. Reserve replay or denial cannot mint another send; an ambiguous enforce result cannot send or retry. Explicit log-only storage failure continues compatibility with a bounded, sanitized notice and no authoritative debit. The application selects log-only in code; there is no public or environment switch that enables enforcement.

`oddsApi.ts` retains the sole paid fetch. Its public wrappers validate selectors then reserve before invoking the private permit-only transport. Shared live/discovery and forced refresh forward their raw owner and original claim deadline without a new cache query. Collector sends pass the checkpoint identity, owner, and a deadline conservatively measured before the batch claim; their canonical market cost reaches the existing SQL check. A `scheduled` telemetry string alone does not grant collector class. Legacy/current-schema and direct calls stay shadow-compatible; ownerless direct calls are refused by the enforce factory. This is not authority to activate enforce on the legacy schema.

Provider response headers are processed before HTTP/decode exceptions. Qualified enforce orchestration reconciles known costs once; missing costs retain liability, storage errors do not create another send, and shadow headers never mutate the enforce ledger. Telemetry uses the reservation ID for correlation and retains response/error metadata. Monthly period interpretation is only a local contract here: real provider reset/header semantics remain #294/#295 and before-enforce gates. Free `/events` remains outside reservation with its existing call path.

Validation: full application regressions passed 947 browser and 991 Node cases (one opt-in live R2 case skipped). The final focused paid-boundary/telemetry/permit rerun passed 86 cases after adding reservation-ID telemetry correlation. Typecheck, lint/import boundaries, CI gate (36 cases) and whitespace checks pass. Initial unprivileged Node failures were loopback `listen EPERM`; the authorized local socket rerun passed without implementation changes for those failures. No DB DDL or driver changes in this checkpoint; checkpoint 3 still owns provider-source guard mutation checks, build and final real-table/pool/both-DB-suite integration. No hosted work, credentials or provider calls occurred. Report before commit; no push.
