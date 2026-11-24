# #224 limiter rollout preparation runbook

Status: preparation only. No schema release, keys, mode setting, schedule or WAF rule is activated by this branch. The preparation PR uses `Refs #224`; #224 remains open while [#311](https://github.com/ven2dev/dfs-ev-demo/issues/311) and activation gates remain.

## Design basis

**Pattern:** immutable server-only deployment configuration, readiness-gated enforcement, observation followed by separately approved activation, and rollback through a compatible replacement deployment. Health projects cached readiness. WAF and paid-leader admission have independent controls.

**Alternatives:** a live flag service adds another control-plane dependency and consistency boundary without a need for runtime switching; direct database toggles add hot-path work and couple configuration to availability; WAF-only control cannot distinguish signed-in paid leaders and penalizes shared networks. These alternatives are rejected for this scope.

**Targets:** full warm path before the provider call is 90 ms: cache 10 + admission 53 + headroom 27. The 53 ms share comes from #220 PlanetScale measurements, not a guarantee on the current deployment. Preserve at most one coalesced verification on the enforce pre-claim path, zero verification on fresh hits, no added follower SQL, and zero repeat-denial claim/admission/release work beyond the existing freshness read. See [C2 results](224-c2-results.md). Mock qualification proves counts, not hosted latency or SDK cold-start behavior.

**Assumptions:** transaction-mode PostgreSQL pooling; shared cache and limiter schema separately released; platform-authoritative network headers; verified token identity; per-instance deny caches and deployment configuration; low initial traffic. No application credit ledger exists. Provider quota is advisory and the provider enforces its cap.

## Release prerequisites — owner records evidence, preparation does not perform them

- [ ] #95 migration tracking is live and verified **before** freezing limiter proposal SQL into an ordered migration, to prevent an untracked or irreproducible release. Keep the approved spike/behavior evidence with the freeze. Do not widen #285 or #309.
- [ ] Separately approve schema release, least-privilege grants and concurrent report-index build; record source SHA, migration identity, grants and index readiness. Avoid a blocking index build because it can interrupt production writes.
- [ ] #221 shared path is installed and selected at startup, and #299 live identity support is deployed. Drain legacy shared-cache writers as required by the cache activation plan; mixed legacy writers can duplicate paid sends.
- [ ] #311's synchronized two-session retention repair is proven and released before any retention run or completion of #224; otherwise prune can remove a subject between admission insert and lock, losing usage.
- [ ] Approve limiter rates/bursts, HMAC keyring and health warning/critical policy values. Existing thresholds remain proposals; do not interpret a proposed threshold as enforced policy.
- [ ] Confirm production hosts, Hobby WAF entitlement, rule slot and allowance/exhaustion behavior using the [written rule draft](224-waf-rule-draft.md).

## Log-only deployment and observation

1. Deploy compatible code with `ODDS_SUBJECT_MODE=log-only` (unset also selects log-only). Configuration is read once per instance: changing a dashboard value alone does not mutate running instances. Invalid values select safe log-only behavior, log a reason class once and appear as `requestedMode: null`, never as the raw value.
2. On the authenticated `/api/health/odds-subjects` and collector health route, record `requestedMode`, `effectiveMode`, `capability`, `sharedCache`, `modeReasons`, instance-scoped reason counts and recent reason. The compatibility `mode` field equals effective mode. Health adds no readiness probe; the subjects report still performs its existing report query. A single healthy instance is not proof that every reachable deployment is ready.
3. Observe at least 24 actual hours and run the journeys below. Keep HMAC-only report totals, would-deny/deny counts, anonymous versus signed dimensions, quota age/remaining/used, and sanitized error classes. Subject-dimension counts are not unique HTTP call counts; one-minute report edges are approximate. Never store raw IP, UID, token, HMAC secrets or authorization headers in evidence, to prevent identity or credential disclosure.
4. With low traffic, explicitly label rates and thresholds provisional. Empty traffic and mock clocks do not replace observation. The owner accepts the observation and journey evidence before enforce.

| Synthetic journey | Expected review evidence |
| --- | --- |
| Page and asset burst, sign-in/out, shared NAT | WAF would-block impact; no silent path exemption |
| Discovery and live stream, identity switch, reconnect | Correct user/network dimensions; expired identity becomes anonymous; fresh hits do not verify |
| Paid leader, eventual follower, repeated denial | One composed admission for a leader; coalesced verification <=1; follower and denial work counts preserved |
| Another user refreshes a denied subject's key | Existing freshness read returns fresh data before denial-cache checks |
| Quota floor, missing reading, failed read | Known floor refuses; missing/failed reading allows; failure is visible as unavailable on health, not zero |
| Limiter counter/storage or identity failure | Refresh allowed with reason-only warning; no raw error disclosure; known quota refusal remains a refusal |
| Cron and authenticated health, stream reconnect bursts | WAF impact reviewed across all paths; unauthorized health does no database work |

These journeys require separate authorization for any hosted traffic or provider calls. This preparation performs mocks only.

## Enforce one axis at a time

After observation acceptance and fresh owner approval, deploy `ODDS_SUBJECT_MODE=enforce`. Expected effective mode is enforce only when limiter capability is ready and the cached schema status is shared. Otherwise it remains log-only with readiness reasons; do not call an incomplete activation successful. Drain superseded instances and reachable old deployment URLs to prevent mixed mode behavior. Record requested/effective modes for the actual deployment inventory.

WAF starts log-only and reaches 429 only after its separate approval. Change one axis at a time so failures and rollback can be attributed. Do not silently tune approved thresholds during activation.

Requalify the actual warm path on the selected PlanetScale deployment after the DB changeover, with a separately cleared timing window and no unapproved paid calls. Preserve SQL/verification/buffer budgets, interleave baseline and candidate over repeated rounds, and require at least 30% headroom (p95 <=63 ms against 90 ms). A miss stops activation for owner review; these app mocks cannot establish that gate.

## Rollback to log-only

Deploy the same compatible code with `ODDS_SUBJECT_MODE=log-only`; confirm requested/effective log-only. Drain all old enforced instances and reachable deployment URLs before declaring rollback complete: old in-memory denial entries survive on old instances. Preserve TAT, buckets, overlap keys and quota observations; no database reset, credit initialization, liability resolution or ledger rollback exists. Existing admission statements continue with enforce=false for visibility. Roll WAF back independently to log-only and verify its separate dashboard control if that axis is affected.

## HMAC rotation

Provision secrets through the owner credential process, never this document or receipts. During overlap, retain both versions: admission checks/updates both and applies the stricter result; reporting uses only the newest. Keep the old version for the longest limiter horizon, then drain old-only instances before retiring it, to avoid granting another allowance. Reports can split for up to 24 hours. An emergency immediate rotation can grant a fresh allowance; record owner acceptance of that tradeoff. Compatible rollback preserves the same overlap keyring.

## Retention — blocked, manual first run

After #311's repair is released and separately approved, retain 7-day buckets and cap each batch at 1,000 rows. Perform and inspect the first run manually, including rows affected and safety checks for future debt, overlap horizon and referenced rows. No cron or schedule is part of initial activation: unattended repetition could amplify a defect before the first run is reviewed. Do not execute SQL from this runbook; the released, tracked maintenance API and its approved operator procedure are prerequisites.

## Completion evidence

Record owner approvals, release/deployment identities, observation start/end, synthetic outcomes, effective modes, warm requalification, key overlap/drain, manual retention result and WAF entitlement/allowance decision. Keep credentials out of receipts. #224 stays open until its blockers and separately approved rollout are complete; a merged preparation PR is not activation evidence.
