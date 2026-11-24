# #224 C2 — rollback and work contracts

C1 is committed as `417186b13de305e4c2a3d4c022feaf50254d8812`; its exact-tree publication guard passed, its message has no attribution lines, and its worktree was clean before C2 started.

C2 adds app/mock contracts only. The tests use the real deployment-mode parser, mode projection, paid boundary, identity resolver and shared-cache kernel. The database admission result and Firebase SDK are mocked; they do not qualify GCRA SQL or hosted latency.

## Deterministic work

| Journey | Count asserted |
| --- | --- |
| Twenty leaders across two independent instance owners | 20 existing admission statements; 0 mode statements |
| Primed-denial fresh hit | 1 existing freshness read; 0 token checks; 0 admission |
| Signed request that becomes a follower | 1 coalesced signature check; 2 existing reads and 1 failed claim; 0 admission or added follower SQL |
| Five repeated cached denials | 5 existing reads; 0 added claim/admission/release statements |
| Another subject refreshes a denied subject's key | Fresh payload returned after 1 read; denial check bypassed |
| Enforce instance replaced with log-only | 1 existing admission per instance; replacement submits enforce=false; no reset statements |
| Quota refusal with counter failure | Refusal retained; one reason-only warning; no subject denial entry |
| Counter/storage failure in either mode | Allow; one reason-only warning; no fallback query or denial entry |

Existing boundary/subject suites additionally cover user-versus-network isolation and expiry while waiting for ownership. C2 explicitly exercises pre-claim memo expiry without a second verification. No raw identity, token or key material is exposed by the admission parameters.

## Rollback and rotation limits

Rollback is a compatible log-only replacement deployment, not a live mutation or state reset. An old enforced instance still retains its denial cache: drain old instances and reachable deployment URLs before calling rollback complete. No TAT, bucket, keyring or quota reset is sent.

During overlap, both versions are submitted for both user and network dimensions, with only the newest reporting key. The same inputs survive the log-only replacement. These mocks verify the adapter contract; stricter-dimension SQL behavior remains covered by #223's prior DB qualification. Retire the old key only after the longest limiter horizon and old-instance drain. Reports can split for up to 24 hours; emergency rotation can grant a fresh allowance. C3 puts these steps in the activation runbook.

## Checks

Node 24.21.0: 386 server mock tests pass, including 18 C2 cases. Lint, the CI gate and web typecheck are recorded in the accompanying validation receipt after completion. No DB suite, lane, hosted resource, WAF action, provider request or real credential was used. C2 is uncommitted pending review.
