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
collector, anonymous and network-only live paths do not load it here.

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
enforce. Live requests are deliberately network-only until #299. Configured
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
