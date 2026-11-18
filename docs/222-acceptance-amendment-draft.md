# #222 acceptance amendment — owner approval required before posting

Draft only. This text updates #222's acceptance/targets and supersedes its old statement that the paid-path deadline is unapproved. It does not authorize enforce, hosted work or a schema apply.

## Proposed acceptance criteria

- Twenty distinct eligible paid leaders, with WAF/GCRA disabled, cannot overspend or breach the collector floor. Each newly eligible batch performs one atomic reservation/audit statement before its mock provider send, with no per-market reservation fanout. Contention denials are not counted as successful eligible leaders.
- Cache hits, followers, cooldown returns and explicitly free `/events` calls perform zero reservations and zero paid sends. New denied reservations retain one audit row per batch; shared-key denial audits are bounded by #221's durable 20-second per-key cooldown. Replays add no audit or send authority.
- All paid live/discovery/forced-refresh/collector/direct wrappers converge on the permit-only transport. Only the reservation primitive mints process-local, single-use permits bound to canonical selectors, owner signal and pre-send deadline. A late, aborted, forged or reused permit cannot send. A public telemetry source cannot select collector class; collector cost is bound to the checkpoint's canonical market set.
- Unknown or ambiguous outcomes retain worst-case liability until restricted, audited operator resolution. There is no automatic reserve retry, provider resend, or time/header-only refund. Known-response reconciliation is idempotent and runs before HTTP/decode errors discard response metadata; missing actual cost never becomes an invented zero. Quota headers alone do not forgive an unknown send.
- Ship log-only first: shadow accounting has no authoritative debit or quota-safety claim, and storage failure preserves existing live refresh with sanitized failure visibility. Test log-only, explicit observed initialization, enforce and rollback to log-only. Enforce refuses uninitialized/stale/unknown budget, expired ownership and storage failure. No production enforcement switch is enabled by this issue.
- Operator initialization of a new period carries every unresolved old-period liability forward against new availability without blocking rollover or changing original provenance. Core #222 requires manual monthly initialization. Later audited resolution releases the carried liability/count exactly once; old-period headers cannot overwrite the current baseline. Health reports period mismatch as critical.
- The authenticated health contract exposes typed unresolved liability total, count and age. A failed/missing authority read is unavailable/null, never fabricated zero. Numeric warning/critical thresholds remain owner proposals until approved before enforce.
- SQL remains proposal-only in `packages/db/proposals/`. Use account-only locking and ordinary parameterized SQL, safe through transaction-mode PgBouncer: no session advisory locks, session SET, named prepared statements, temp tables or LISTEN/NOTIFY. Preserve the existing web driver. Schema freeze/apply, roles and activation need separate owner approval.

## Targets and qualification boundary

The owner-approved full warm path is **90 ms = four cache statements 10 ms + admission 53 ms + headroom 27 ms**, before the provider call. The admission allocation comes from PlanetScale #220; reservation and #223 fairness share it. Historical #206/old 50 ms misses remain historical evidence, not current passes.

Local qualification uses `provider-credit-222-v1`, PostgreSQL 18, lane-2 standard 512 MiB, 20 distinct leaders, a mock provider, restricted test roles and transaction-mode PgBouncer. It proves correctness and deterministic work budgets only. Neither elapsed local test time nor historical PlanetScale timing qualifies the production provider/driver; hosted timing waits for #294 and separate approval.

#295 owns the deferred bounded free observer, confirmed provider-reset detection and automatic rollover, and actual-cost serving breaker. It blocks #224. Real header semantics, health policy, provider choice, schema release and activation remain before-enforce gates. Completing #222 does not complete or authorize those gates.

## Separate #206 closing-summary draft — approval required

Recommend closing #206 as the completed historical admission profiling spike. Its Neon contention/durability findings and original receipts remain valid historical evidence, including the 64.294 ms candidate miss and earlier 152–162 ms guarded profiling. #220 supersedes the next admission-screening step; it does not invalidate those findings or choose a production provider. #294 owns the provider/driver decision and any new hosted comparison. The owner has approved a 90 ms full warm pre-provider budget (cache 10 / admission 53 / headroom 27); this is a design budget, not a reclassification of #206 as a pass.

Do not post this summary or close #206 without the owner's separate approval.
