# #223 subject limiter runbook — proposal, not activation

## Design basis

**Pattern:** DB-clock GCRA with sorted atomic dimensions/versions; minute bucket
upserts and provider-header quota lookup in one paid-leader statement.
**Alternatives:** Redis adds a service/round trip; WAF cannot know paid leaders;
route-entry checks charge cache hits. See docs/223-roadmap.md for targets,
requirement reasons and assumptions, and Q0 evidence for measured work.

## Scope and defaults

C1 introduced the SQL and factories. C2 registers the capability check and
threads lazy subjects through discovery, shared/legacy/live cache paths and the
single paid transport. Missing schema/key/policy retains #222's floor-only
behavior. No schema installation or enforcement is performed. Test policy
numbers are synthetic, not production defaults. ODDS_SUBJECT_HMAC_KEYS and
ODDS_SUBJECT_POLICIES are optional, centrally validated supplied inputs; the
keyring is secret, the policy is ordinary configuration. Both are absent by
default; owner provisioning is separate and local tests use synthetic values.

## Separately approved schema release

Before any hosted apply, freeze the proven proposal into an ordered migration
under its own release approval. #285's existing cache scope grants no new limiter
schema permission; #294 owns provider/driver choice. #299 must land before #224
can activate enforcement. No ledger/credit initialization step exists.

The release owner applies public.odds_subject_limits, odds_subject_buckets and
admit_paid_odds(jsonb,boolean,integer,integer), plus the partial latest-quota index
on existing request telemetry. The partial predicate prevents a long run of
headerless observations from making LIMIT 1 scan the whole history. At release,
build this index with CREATE INDEX CONCURRENTLY outside a
transaction, as a separately approved release step; do not run this local
transactional proposal verbatim against hosted telemetry. Confirm the index is
valid before the function is enabled. Function owner is a restricted,
non-login migration/function owner, not the application role. It needs only
SELECT/INSERT/UPDATE on the two limiter tables and SELECT on the existing
odds_api_request_log quota fields. The pre-send release helper,
release_shared_odds_limiter_denial(text,text[],text), additionally needs SELECT
on cache ownership/keys and UPDATE on its owner/lease/claimed-at columns.
Grant EXECUTE on both exact functions to the existing web role, with no direct
limiter table writes or function-owner membership. Capability remains off if
either function's execute grant is missing.
PUBLIC execute/table privileges are revoked by the proposal. Maintenance needs
separate reviewed deletion rights; the function grants none. No new hosted role
or grants are created by local tests.

The SECURITY DEFINER function fixes search_path to pg_catalog and qualifies all
application relations. This function-scoped configuration is automatically
restored by PostgreSQL, not a session SET or session-affinity dependency. Runtime
calls use unnamed parameterized statements; no session advisory locks, temp
tables or LISTEN/NOTIFY. Harness-only local coordination locks are separate.

## Identity and keyring

Production trusts only Vercel's platform-set x-vercel-forwarded-for, never a
client UID or arbitrary forwarded chain. Proposed network grouping is IPv4
address / IPv6 /64, mapped IPv4 normalized. Prefix/rate/burst choices remain
owner policy. Discovery supplies existing Firebase bearer headers in C2;
missing/invalid/expired tokens become anonymous. Invalid token logs one reason
only. Verify lazily at the actual paid leader, not a route hit or follower.
For rate-limit attribution use verifyIdToken(token, false): validate signature,
issuer/audience and expiry with cached signing keys, without a per-request
revocation/user lookup. Cold signing-key fetches and key-cache refreshes can
still use the network; no hosted latency guarantee is inferred. A revoked user
can retain their user allowance until token expiry (at most the token's remaining
lifetime, normally <=1h). Account actions keep requireUid's revocation checks.
The Admin module is dynamically imported only on a signed-in attribution attempt;
collector and anonymous paths do not load it here. With #299 deployed, live
requests carry bearer headers and use the same lazy verifier as discovery.
The request-local signed memo is fenced by the SDK-verified token expiry at each
paid resolution, including after follower waits and concurrent awaiters. Expired
identity becomes anonymous with one reason-only warning and no repeat verification
in that context. Each live tick creates a fresh lazy context; reconnect obtains
fresh client headers. Account authorization and its revocation checks are unchanged.

Validated keyring has one or two entries {version,keyHex}, lowercase 32-byte
hex keys and distinct short versions. The real secret is owner-provisioned;
never put it in SQL, receipts or chat. Domain-separated HMAC subjects are the
only identities sent to the database. SQL rejects unbounded/malformed dimensions;
the runtime also strips extra metadata and rejects raw identities before query.

Signed-in uses user policy plus a much looser signed-network backstop; anonymous
network policy is separate. No one-size-fits-all production rate is activated by
this proposal. All dimensions and key versions advance together or not at all.

## Startup/error behavior

Capability checks the exact function signature, table presence and EXECUTE
privilege. Missing key/schema means shadow off, one not-installed reason, and
retry after >=5s. Transient errors return unavailable, log a reason class and
retry; a rejected promise never remains latched for instance lifetime. Ready
state is cached per instance. C2 isolates registration failures from unrelated routes and exposes reason-only
instance health counters; the bounded top-consumer view/thresholds remain C3.

Limiter/counter failure allows refresh in both modes. Counter errors roll all
TAT/counter changes back together. A known quota-floor refusal survives that
error. Whole invocation failure allows with limiter-storage-failed, no retry
query, one warning and bounded instance-local recent-error health state (C3).
Never log SQL, driver errors, IP/UID/token or connection data. Counts can be
incomplete during failures. Existing quota-read errors remain advisory under
#222; missing reading is not a zero balance. Cancel/deadline behavior is not
turned into a limiter failure or an automatic provider retry.

## Denials and C2 cache

SQL returns retry_after_ms plus only the actual failing HMAC keys. C2's bounded
instance-local enforce-only deny cache uses these keys and monotonic expiry,
never raw identity. A per-user denial must not blacklist all network sharers.
Advisory cached denials skip claim/admission and preserve stale/unavailable
fallback; database remains the allowance authority. Log-only never denies.
Repeated cached denials add zero claim/admission/release SQL. The existing
freshness SELECT still runs and is counted as existing work; a subsequent
publication by another subject is served fresh. No local payload snapshot is
used. Cache-only factory tests and real-kernel tests enforce that split.

## Rotation and counters

Deploy overlapping old/new derivation; stop old-only instances before starting
the longest limiter-horizon clock. Check/update both, stricter result, sorted
locks. Retire old key only after horizon; late old-only admissions restart that
clock. The newest key is the sole reporting version, not double-counted.
Reports may split for up to 24h; no aliases. Emergency immediate rotation can
grant one fresh allowance per affected subject, an accepted limitation.

One-minute buckets count admitted-to-send, actual denials and would-deny. They
are not exact network sends or a credit ledger. 1h/24h reports can include <1
minute of excess at cutoff, at most 61/1,441 minute positions. Proposed 7-day
retention and 1,000-row maintenance batches remain off paid path. Buckets reference
subject state: retire old buckets before subject rows, and never remove future
TAT/debt or prematurely reset a rotation horizon. Top view/health thresholds
remain C3 and owner-approved policy before enforce.

## C2 rollout boundary

The application boundary is fixed to log-only; no supplied flag activates
enforce. With #299 code deployed, live requests support verified user attribution;
`liveUserAttribution: true` in health is a code-support marker, not schema, keyring
or enforcement readiness. Configured
ready admission replaces, rather than duplicates, the floor read. Not-installed
or null-subject paths use #222's floor alone; null subjects increment the
identity-unavailable reason in authenticated instance health. Warm metadata
checks are cached; startup/5s retries are a separate cold/failure-path statement,
not concealed inside the one-admission budget. No actual secrets were provisioned.

## Enforcement prerequisite: shared cache (C3 gate)

Legacy discovery coalesces requests into its creator's in-flight promise. If
that creator were denied, eligible joiners would inherit stale/unavailable data.
Legacy live must be covered by the same release review. Production is log-only,
so subject denials are not active today. Before any enforcement activation,
require #221 shared-cache capability ready on every serving instance, together
with #299 live identity transport and the separately approved #224 activation.
Legacy paths remain log-only even if a future operator asks for enforce. C3
must add the acceptance criterion and a regression proving that downgrade; do
not assume legacy paths satisfy immediate eligible-subject handoff. Drain old
legacy instances before activating enforcement. No such activation is made here.

## C3 authenticated report, health and retention

GET /api/health/odds-subjects uses the existing ODDS_HEALTH_SECRET bearer
contract and no-store responses. Unauthorized requests do no database work.
Ready requests do one aggregate statement for both fixed 1h/24h windows and
three deterministic top-20 lists (admitted-to-send, denied, would-deny).
Only versioned HMAC keys are exposed. Namespace identifies anonymous network,
signed network or user. Counts are per subject dimension, not distinct HTTP
requests: one signed-in request contributes a user and a network admission.
Traffic totals follow the same dimension semantics. Window cutoff rounding can
overcount by less than 60 seconds; rotation can split reports for up to 24h.
Missing capability/query failures report unavailable, never invented zeroes.
A health/report call is off the paid path, and never resolves identities.

The report function's restricted owner needs SELECT on the buckets; only
EXECUTE on report_odds_subjects() is granted to the web role. Startup checks
that exact grant alongside admission/release, so a partial release stays off.
Do not grant direct bucket/subject writes to the application role.

Policy proposals (inactive pending owner approval before enforce): warn at
100 admissions or denials/would-denials per subject/hour, critical at 500.
These are initial review values, not traffic-derived recommendations. The
endpoint reports policy-pending and thresholdsActive=false. The evaluator
supports explicit approved thresholds; no configuration or activation is added.
Instance-local recent-error/reason counts remain visible separately; they are
not fleet-wide totals, survive neither recycle nor scale-to-zero, and failures
may undercount DB buckets. Current mode remains log-only in production.

Retention remains an inactive proposal: 7 days of buckets, at most 1,000 per
delete, followed by at most 1,000 unreferenced subject rows whose TAT has been
expired for at least 24 hours (the maximum supported limiter horizon). The
maintenance helper uses two separate statements, SKIP LOCKED and no paid-path
invocation. Future debt, recently expired rotation state and referenced rows
are preserved. A separately authorized maintenance role/schedule is needed;
no route, cron, hosted grant or maintenance activation is created here. Release
must set a bounded statement timeout and run one batch at a time, observing
rows remaining rather than draining history inside a user request.

C3 acceptance addition: an enforce request is downgraded to log-only when the
shared-cache capability is legacy or unavailable. This applies to discovery
and live alike. The boundary sends enforce=false to SQL and never populates or
consults an enforced-denial cache in that mode. Tests cover both legacy paths
and a rejected capability check. Shared-ready test fixtures retain actual
refusals; this does not activate enforcement in the application.

## Owner-approved C3 measurement correction (2026-11-20)

Warm each admission branch on throwaway subjects before CI measurement. At
10,000 subject rows, allow, first denial, repeat denial, rotation and overlap
each have a <=80 shared-block / zero-temp ceiling. Production PK lock/update
and partial-quota-index plan checks reject sequential-scan regressions. Debt
is captured by the sorted lock read, then evaluated from that bounded locked
snapshot; this avoids a second read of the same PK rows per dimension. Input
validation, atomic all-or-none updates and sorted lock order are unchanged.

The <=512 first-use CI ceiling is explicitly replaced by owner decision. Cold
PL/pgSQL branch compilation/catalog loads are recorded separately using
pg_statio catalog/user deltas; instrumentation makes those approximate, not
an exact partition of EXPLAIN counts. Timing is opt-in against the admission
slice and needs its own clear timing window. No cold latency claim follows
from a shared-hit count. The local pg comparator cannot qualify hosted Neon.

The report materializes one conditional aggregate over the 24h range for both
windows, then uses ORDER BY ... LIMIT 20 for each ranked list. CI checks one
base scan, bounded top-N sorts, <=1024 shared blocks and zero temp IO on 100,000
buckets / 10,000 actual-length HMAC subjects. No work_mem increase or shortened
identity fixture is used to make the budget pass.


## C4 validation status (2026-11-20)

Local timing and all required suites/build now pass; see 223-results.md and
checkpoint-4.json. This evidence does not activate schema, keys, retention,
health policy or enforcement. Production remains log-only, live identity awaits
#299 and enforcement activation awaits #224 plus its owner gates. The 90 ms
full-path deadline remains unchanged; only the local admission screen is proven.
