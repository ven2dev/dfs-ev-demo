# #223 subject limiter runbook — proposal, not activation

## Design basis

**Pattern:** DB-clock GCRA with sorted atomic dimensions/versions; minute bucket
upserts and provider-header quota lookup in one paid-leader statement.
**Alternatives:** Redis adds a service/round trip; WAF cannot know paid leaders;
route-entry checks charge cache hits. See docs/223-roadmap.md for targets,
requirement reasons and assumptions, and Q0 evidence for measured work.

## Scope and defaults

C1 adds proposal SQL, runtime primitive and dependency-injected subject/startup
factories only. No startup registration, route wiring, environment delivery,
schema installation or enforcement is performed. On today's schema the running
application remains unchanged. Policy numbers in tests are synthetic, not
production defaults. Secret names/delivery are registered through the existing
configuration boundary in C2; no real keys are required for local validation.

## Separately approved schema release

Before any hosted apply, freeze the proven proposal into an ordered migration
under its own release approval. #285's existing cache scope grants no new limiter
schema permission; #294 owns provider/driver choice. #299 must land before #224
can activate enforcement. No ledger/credit initialization step exists.

The release owner applies public.odds_subject_limits, odds_subject_buckets and
admit_paid_odds(jsonb,boolean,integer,integer), plus the partial latest-quota index
on existing request telemetry. The partial predicate prevents a long run of
headerless observations from making LIMIT 1 scan the whole history. Hosted
index-build locking/online release needs its own review. Function owner is a restricted,
non-login migration/function owner, not the application role. It needs only
SELECT/INSERT/UPDATE on the two limiter tables and SELECT on the existing
odds_api_request_log quota fields. Grant EXECUTE on this exact function to the
existing web role, with no direct limiter table writes or owner membership.
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
state is cached per instance. Factory registration and authenticated health
integration follow in C2/C3, with failures isolated from auth/other routes.

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
The exact zero-SQL repeat budget is a C2 test, not claimed passed by C1.

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
