# #222 rescope and related issue updates — owner approval before posting

These are drafts. The existing branch is reworked through new commits; historical commits are not rebased or rewritten.

## #222 proposed title

feat(odds): guard the paid-call boundary with a quota floor and alerts

## #222 proposed replacement acceptance and scope

Owner decision (2026-11-17): the app does not maintain a provider-credit ledger. Plan capacity is an owner forecasting decision. Remove reservations, reconciliation, initialization, operator resolution, periods, unknown liabilities and enforcement modes, with their SQL/tests/evidence. Preserve historical commits, and retain old evidence in the final tree only if a publication guard requires it.

- [ ] All paid live, discovery, forced-refresh, collector and internal calls converge on one guarded `fetchEventOdds` entry point. CI rejects provider URLs/calls outside `oddsApi.ts` and a missing interactive floor check. No ledger permit is needed after ledger removal.
- [ ] Interactive paid refreshes read at most one latest recorded non-null `remaining` observation from the existing telemetry index, once per leader/batch. At or below the configured collector reserve plus one trackable collector batch (the existing collector scarcity rule), they make zero provider calls and return flagged stale data with its original capture time, or unavailable when no real prior payload exists. No denial is published as fresh.
- [ ] No reading allows the first call, whose existing response telemetry supplies a reading. A failed quota read allows the interactive call and logs one warning containing only a bounded reason class (no SQL, target or credentials); health reports the reading as unavailable/null. This is the owner-selected availability policy because the floor is advisory and the provider enforces its own cap. Database-free local setup has no recorded reading. There is no new quota snapshot write, polling call or automatic provider retry.
- [ ] Cache hits, followers and cooldown results add zero quota reads. The collector keeps its existing admission check, adds zero interactive floor reads, and binds the paid market set to its claimed checkpoint. A public `scheduled` telemetry label alone cannot bypass the interactive floor. Free `/events` stays free of this floor.
- [ ] Existing telemetry retains provider `remaining`, `used` and actual request cost on successful and HTTP-error responses, including before a decode error. A persistence error cannot discard an already received provider response.
- [ ] The authenticated health route reports remaining, used and reading age. Missing reading reports unavailable/null, never invented zero. Age uses the database receipt stamp and database clock. Warning/critical thresholds remain proposals requiring owner approval; no arbitrary alert thresholds are activated in this change.
- [ ] Full app, lint, typecheck, default production build, provider-boundary guard, core DB/catalog/readiness and feature-store DB suites pass on lane-2 standard in a quiet window. Prove the existing index at 10,000 historical readings and keep serving work counts in CI. Remove the owned fixture afterward.

The approved warm pre-provider budget remains **90 ms = cache 10 + admission 53 + headroom 27**, with the 53 ms allocation informed by PlanetScale #220. Local tests establish correctness and work budgets, not hosted latency. #294 still owns production provider/driver qualification. This floor is advisory: concurrent distinct leaders can pass the same observation; no atomic no-overspend guarantee or purchased-plan forecasting is claimed.

Proposed health policy for review: warning at remaining <= reserve + two trackable batches, critical at <= reserve + one batch. Proposed reading-age warning after 15 minutes and critical after 60 minutes only during expected activity; idle overnight age alone should not page. These thresholds are not active until approved.

## #295 proposed comment and closure

Close as **not planned**, after approval:

> Owner decision (2026-11-17): #222 no longer maintains a provider-credit ledger. Plan capacity is an owner forecasting decision; the app instead guards the paid-call boundary with a provider-header quota floor and quota health. The ledger free-observer/reset/automatic-rollover/actual-cost-breaker scope in #295 is no longer planned. See the approved rescope recorded in [#223's amendment](https://github.com/ven2dev/dfs-ev-demo/issues/223#issuecomment-6967791584) and the owner-approved replacement acceptance for #222. Remove #295 as a blocker of #224 after approval of that dependency change. No hosted cleanup or provider operation is authorized by this closure.

## #224 proposed dependency removal and flag

After approval, remove only the native **#295 blocks #224** dependency edge; keep the other dependencies intact. Add the following amendment-needed notice (do not silently rewrite the remaining acceptance criteria):

> The owner rescoped #222 to a single paid-call boundary, an interactive quota floor and quota health, with no application credit ledger. #295 is no longer a rollout prerequisite and is proposed for not-planned closure. This issue's credit initialization, unknown-liability handling, ledger rollback and account-safety enforcement steps are obsolete and require a separately reviewed acceptance/rollout amendment before implementation. WAF, per-subject limiter observation/enforcement, HMAC rotation and the #223 abuse-visibility rollout remain separately reviewed work. The approved warm pre-provider budget is 90 ms; the old statement that a replacement deadline is unapproved also needs correction in that later amendment.

## Already authorized housekeeping

- #206 approved summary posted and issue closed: https://github.com/ven2dev/dfs-ev-demo/issues/206#issuecomment-6967573539
- #223 approved amendment posted, with the separately approved “#295 is proposed for closure” correction: https://github.com/ven2dev/dfs-ev-demo/issues/223#issuecomment-6967791584

No #222/#295/#224 mutation is authorized by this draft.
