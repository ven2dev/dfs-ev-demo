# #222 provider credit operations

No production operation is authorized. The proposal uses separate restricted runtime/operator grants and parameterized, audited functions; the application runner cannot initialize or resolve liability or write authority tables directly. Local tests alone create public disposable fixture identities. No hosted role or operator action is authorized.

## Health contract and proposed policy (owner approval before enforce)

A valid authority read returns typed numeric `unresolvedLiabilityTotal` (credits) and `unresolvedLiabilityCount` (attempts), including legitimate zero. An unavailable authority read returns null totals/counts with explicit unavailable status, preventing missing state from concealing stranded liability as zero. They include in-flight and ambiguous attempts, so a positive value alone does not prove stranding. Also propose `oldestUnresolvedAgeSeconds`, `availableCredits`, `collectorFloor`, `mode`, `initialized` and stable reason codes. Ordinary in-flight work should not page an operator.

Proposed policy values, not approved defaults:

- Warning: at least one unresolved attempt older than 80 seconds (20-second external deadline + 60-second investigation allowance), or unknown/invalid reconciliation requiring attention. This age triggers investigation, never release.
- Critical: unresolved work older than 300 seconds AND (total liability >=10% of initialized period quota OR count >=20); also critical if aged unresolved liability prevents the next bounded interactive call above the collector floor.
- Owner-decided rule: `period-mismatch` is critical and visible, independently of numeric thresholds. Uninitialized enforce and cost inconsistency retain distinct refusal reasons, not “healthy.” Missing health-query data is unavailable, never numeric zero.
- These thresholds affect visibility only; they do not grant spend authority, clear breakers or alter the fixed 20-second cache cooldown. Owner approves actual warning/critical values before enforcing.

## Initialization and monthly/plan changes

1. Quiesce affected paid work and confirm the exact account/period, intended mode and operator authorization. Prevent stale deployments/scheduled callers from bypassing enforcement.
2. Obtain an authorized fresh provider observation through the separately reviewed path; record remaining, used, plan total, account identity/period and evidence reference without logging the API key or credential-bearing URL. A local receive timestamp does not prove provider processing order.
3. Call the audited initialization primitive once with a unique operation ID, actor, explicit floor and evidence. Preserve outstanding liabilities and audit history. For monthly rollover, carry every unresolved old-period liability forward against the new period. They reduce new-period availability but no longer block rollover. Preserve each original attempt period/evidence and audit the new initialization; a new period name is not forgiveness. Core #222 requires this operator step every month; automatic confirmed-reset rollover belongs to #295 before enforce. Explicitly record the confirmed period end and quota freshness interval; neither is inferred from the local calendar or a deploy.
4. Repeat the same operation ID/content safely on a lost operator reply. Different content under the same operation ID refuses. Validate typed health afterward.
5. Enforcement/rollback activation remains separately authorized. Log-only records shadow decisions and never debits the enforce ledger; storage failure continues the old paid path with a sanitized shadow-accounting error. Rollback preserves outstanding enforce debt and suspends the new quota-safety claim.

## Unknown-outcome resolution

1. Identify the exact attempt and bound request/cost, reserve time, process/deployment and whether any send may still start/resume. A timeout, elapsed 80 seconds or application cancellation alone is insufficient proof of no provider work.
2. Prefer provider confirmation that the particular request was not charged. Alternatively establish BOTH terminal send execution (cannot later resume/send) and a trustworthy covering provider observation that already includes the request's outcome. Record evidence references and the argument; don't merely assert a boolean in an application request.
3. Quota headers `x-requests-remaining`, `x-requests-used`, `x-requests-last` are useful same-account/same-period evidence for known responses and retained-snapshot reconciliation. Headers from a later-arriving HTTP response alone do not prove a linearizable covering snapshot or justify releasing a lost request. Missing/malformed/reset/mismatched counters are not refund evidence. Unknown account/key users make coverage uncertain and require owner/provider investigation.
4. If that evidence is absent, retain full liability and show it in health. Do not retry the original paid send automatically.
5. With explicit restricted operator approval, call the resolution primitive with immutable operation ID, actor, attempt ID, evidence reference and documented terminal/coverage finding. It atomically records the resolution and subtracts liability/count exactly once under the account-row lock. No resource lock is involved.
6. A carried old-period attempt remains resolvable after monthly initialization. An authorized resolution subtracts its remaining liability/count from the current account aggregate exactly once, without applying old-period quota headers to the new baseline. Repeated identical resolution returns its recorded result; changed evidence/content with the same operation ID refuses. Reconcile/operator races are serialized by the account row. Verify ledger/aggregate health after completion.

Evidence JSON validation records the restricted operator’s finding; it is not a claim that software can independently verify a provider’s statement. A UI, provider-contact automation or production operator execution is outside this qualification.

## Checkpoint 1 required regressions

- Reserve a prior-period attempt, lose its response and initialize a new period. Initialization succeeds; the attempt’s original period/audit remains and its liability carries forward.
- New-period availability is reduced by that carried liability; no automatic refund or new provider send occurs.
- Resolve the old attempt through the authorized audited operation; liability/count are released exactly once even with repeats/races, and the current-period quota baseline remains unchanged.
- Derive collector cost from the checkpoint’s canonical market set; a mismatched collector cost refuses before debit/provider send, with the applicable denied audit accounted for.
- Retain denied-reservation audit rows and assert per-key #221 cooldown bounds and zero new audit rows on replay/follower returns.
- Period-mismatch health severity is critical. Numeric thresholds above remain proposals until owner approval before enforce.


## Proposal API and permissions

`packages/db/proposals/222_provider_credit_reservations.sql` contains only proposed DDL; `@dfs-ev/db/runtime` exports `createProviderCreditStore(query)` with one parameterized SELECT per operation. The caller owns connection/driver lifetime. No automatic query retry, driver initialization or provider call is inside this package. `apps/web/src/lib/db.ts` is unchanged.

- Runtime grants after separately approved activation: schema USAGE and EXECUTE on `provider_credit.reserve`, `provider_credit.reconcile`, `provider_credit.health`. No table access.
- Operator grants: schema USAGE and EXECUTE on `provider_credit.initialize` and `provider_credit.resolve_unknown`. No serving reservation grant or table access.
- Functions are owned by the reviewed migration authority, not the serving role. Local tests prove behavior under a separate non-login, non-superuser definer. All relations are qualified; `pg_catalog.set_config(...,true)` is transaction-local. Production role names/grants remain a separate release decision.

Initialize with a unique operation ID and actor; explicit trusted remaining/used/period/period-end/floor/freshness interval plus an opaque evidence reference. Values come from the approved observation procedure, never guessed allowances. The same operation ID/content is replay-safe; changed content refuses. Core performs no automatic provider reset inference.

Resolve with a unique operation ID/actor, attempt ID and evidence object `{kind, reference, sendCannotResume: true, period}`. Kind is `provider-confirmed-no-charge` or `covered-terminal-send`; evidence period identifies the attempt’s original period. References are opaque, bounded identifiers, never keys/URLs. The database also records the connecting login role. Do not submit raw provider diagnostics or credentials.

A new denied reservation retains one audit row with zero liability; a replay adds none. A batch has one audit, not one per market. CI asserts these counts through #221’s real cooldown. A collector request must match canonical checkpoint markets and cost; source labels supplied by clients do not grant collector privilege.

## Release limits

The authenticated `/api/health/odds-collector` response includes `providerCredits` with typed unresolved liability total/count/age and current authority state. Missing proposal tables or a failed authority read return unavailable/null fields; they do not pretend there is zero debt. Existing collector health remains compatible in log-only, while a critical authority state produces an unhealthy response. Numeric age/amount thresholds remain unapproved proposals. Paid wrappers now use the single-use reservation boundary in log-only; no public/environment enforce switch is enabled. #295 owns free-observer integration, automatic confirmed-reset rollover and the serving actual-cost breaker. The 90 ms split remains cache 10 / admission 53 / headroom 27, with 53 derived from PlanetScale #220. Hosted timing waits for #294. No schema migration freeze/apply or enforce activation is included.
