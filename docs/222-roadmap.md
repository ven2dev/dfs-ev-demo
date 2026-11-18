# #222 paid-call boundary, quota floor and alerts

Status: owner rescope approved 2026-11-17; checkpoint 4 replaces the ledger implementation on the existing feature branch with new commits, without rewriting history. Earlier checkpoint evidence is superseded and removed from the final tree if publication checks permit. No push or commit before review.

## Design basis

**Pattern:** a single guarded provider transport with an advisory floor from the latest recorded provider quota observation. Reuse the existing request telemetry and its descending requested-at index; keep cross-instance singleflight as #221 designed it. Plan capacity and billing forecasts belong to the owner, not an application ledger.

**Alternatives:** durable reservations/reconciliation were rejected by the owner because application credit accounting exceeds the desired product responsibility. Per-instance quota counters were rejected because they disagree across instances and invent another source of truth. Polling the provider to learn its quota was rejected because it adds calls where existing response headers already supply the observation.

**Targets:** retain the approved 90 ms warm pre-provider budget (cache 10 / admission 53 / headroom 27; the admission allocation comes from PlanetScale #220). Local checks prove correctness/work counts, not production latency. Interactive paid leaders add at most one indexed latest-quota SELECT per batch; cache hits/followers/cooldown add zero quota reads. Collector sends reuse the collector's existing quota decision and add zero floor reads. Record real response headers in existing telemetry with no extra quota-update statement.

**Requirement reasons:** a floor at `collector reserve + one trackable collector batch` (the existing collector scarcity rule) protects collection capacity from interactive refreshes. At or below the floor, return stale data with original capture time, or an explicitly unavailable result, with zero provider calls; do not publish stale data as fresh. No reading permits the first call so its response can supply one. The owner selected allow on read error: emit one reason-class-only warning and proceed, because the floor is advisory and the provider enforces its cap. Health still reports a failed read as unavailable/null, so the failure remains visible without turning a quota-read outage into an odds outage. No automatic retry of a failed provider send prevents duplicate billable work. A guarded entry point and CI mutation tests prevent a future caller from bypassing the check. Telemetry failure stays isolated from an already received provider response.

**Assumptions:** one provider account, trusted server callers, the current fixed US/market cost policy, and quota headers recorded by existing telemetry. Latest means the latest request-time-ordered non-null remaining reading, matching the existing collector-health query. Reading age uses the database-created timestamp and database clock. The floor is advisory: concurrent leaders and delayed observations can pass together; no atomic accounting or hard no-overspend guarantee is claimed. Provider resets, purchased plan capacity and choosing capacity are owner forecasting/operations decisions.

## Checkpoint 4 scope

- Remove provider_credit SQL, all ledger/period/enforce/operator/unknown-liability code, tests and compact evidence. Preserve historical commits. Verify publication after removal.
- Keep one guarded `fetchEventOdds` entry point; remove the ledger permit when it no longer provides independent value. Preserve deadlines/abort checks and collector checkpoint/market-set binding. Public telemetry labels do not choose collector authority.
- Read the existing latest quota once only inside an interactive paid callback. Reuse the configured collector reserve and trackable batch size. Preserve prior raw payload and timestamp on denial, and expose unavailable when no real payload exists. Keep weather on its existing path.
- Add authenticated quota health: remaining, used and DB reading age; missing/failed readings are unavailable/null. Propose warning/critical thresholds for owner approval, without activating them.
- Keep the unconditional provider-source CI guard and test escaped URLs/calls and omitted floor checks. Prove indexed lookup and cache-hit/follower/collector work budgets on lane-2 standard.
- Run full app, lint, typecheck, default build, boundary/CI guard and both remaining DB suites in the cleared lane-2 window; remove owned resources afterward. No hosted work, provider calls or credentials.

## CI work budgets

| Path | New quota work |
| --- | --- |
| Interactive paid leader | At most one indexed SELECT, once per owned batch; no writes before send. |
| Refused interactive leader | Same one SELECT, zero paid fetches, zero provider telemetry inserts. Existing lease release is counted separately. |
| Cache hit/follower/cooldown | Zero quota SELECTs and zero paid fetches. |
| Collector paid call | Zero interactive floor SELECTs; canonical checkpoint markets and existing collector admission remain authoritative for that call. |
| Paid response/error | Existing single telemetry INSERT with response quota metadata; no ledger/snapshot write and no automatic retry. |
| Health | One independent indexed quota read, outside serving budgets. |

## Proposed health policy — owner approval required

Propose warning at remaining <= collector reserve + two trackable batches, critical at <= reserve + one batch. Propose age warning after 15 minutes and critical after 60 minutes only while an active refresh/collector is expected; idle overnight age alone should not page. Missing reading is unavailable, never zero. These are proposals, not active alert defaults; the interactive floor itself is the explicitly approved behavior.

## Issue housekeeping — drafts only unless separately approved

Draft retitle/replacement acceptance for #222; draft #295 not-planned closure; draft removing #295 from #224 dependencies and flagging its credit-initialization steps for a later amendment. The #223 amendment is approved for posting, and was posted with the owner-approved “#295 is proposed for closure” correction. #206's separately approved summary was posted and the issue closed.

## Checkpoint 4 review status

The ledger SQL, primitives, permit, health/operator paths, tests and three compact checkpoint receipts are removed. No migration or schema change is required for the replacement; it uses the existing telemetry table/index. The candidate preserves branch history and has not been committed or pushed.

Quota-floor tests cover below/equal/above threshold, missing versus failed reading, first response telemetry, collector bypass only with matching checkpoint markets, delayed/aborted ownership, fresh cache hits, denied refreshes, cooldown followers, legacy fallback, and unavailable live-stream flags. Real prior payloads retain their capture time and are never written fresh. Existing #221 publication-failure behavior remains unchanged outside quota refusals.

Validation: 63 core DB cases plus mandatory catalog/migration/readiness/Node contracts, and 301 feature-store cases, passed on lane-2 standard. The 10,000-row fixture uses `idx_odds_api_request_log_requested`, returns one row and stays within 16 shared buffers. Full app/static/build/CI results and exact source/log hashes are recorded in the compact rescope receipt. Both lane-2 containers and network are removed after verification. These are local correctness/work-budget results; no production latency or hard quota guarantee is claimed.

The old receipt paths are not referenced by the publication disposition policy; their removal is checked against the full staged candidate using the unchanged guard in a disposable local Git fixture. The feature branch stays uncommitted until owner review. Raw logs, including initial fixture failures and the corrected passing runs, remain private with separate hashes.

Housekeeping done: [#206 summary and closure](https://github.com/ven2dev/dfs-ev-demo/issues/206#issuecomment-6967573539); [approved #223 amendment](https://github.com/ven2dev/dfs-ev-demo/issues/223#issuecomment-6967791584). The #222 title/acceptance, #295 not-planned closure, and #224 dependency removal/amendment-needed notice remain drafts in `docs/222-acceptance-amendment-draft.md`, pending separate owner approval.

### Allow-on-error amendment

The owner superseded the earlier failed-read refusal. `checkInteractiveQuotaFloor` now logs `[providerQuota] quota-read-failed` exactly once per failed check and returns normally. No raw exception details enter the warning. The only `InteractiveQuotaUnavailable` reason is `quota-floor`, so unavailable stream/fallback handling from this class is reserved for an actual at/below-floor refusal. Missing reading still allows; health behavior is unchanged. Focused quota/cache/live/stream tests, the provider-boundary guard and whitespace checks qualify this amendment; the preceding full-suite receipt remains a historical snapshot of the pre-amendment policy. No commit, draft posting or push is authorized yet.
