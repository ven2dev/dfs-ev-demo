# #299 approved roadmap and implementation checkpoints

2026-11-23. Main basis: 0b15f80dba241fb63ffd70a81d5ccbe402a23c1b.
Q0 is complete. The owner approved this roadmap and branch creation on 2026-11-23.
Implementation is on `feature/dfsEV-299-verified-live-stream`, based on the main
commit above. C1 is client transport; C2 adds expiry-fenced server attribution.

## Design basis

**Pattern.** Authenticated fetch-based SSE with a maintained streaming decoder,
a single abortable connection/reconnect state machine, and generation-fenced
application delivery. Reuse the current hook's state transitions and the merged
#223 paid-leader boundary. On the server use expiry-bounded request-local
verification singleflight; only trusted SDK verification results can supply a
user identity. This follows the established transport/parser separation and
request-scoped memoization patterns; no new shared cache/table/auth service.

**Alternatives.** Native EventSource cannot carry the existing bearer header.
A full maintained client (eventsource-client/eventsource) is credible but would
also introduce reconnection/iterator lifecycle behavior to reconcile with the
hook. Parser-only integration minimizes that change. Session cookies require a
new login/session/revocation/CSRF lifecycle. URL tokens expose credentials to
URL logging and referrer paths. Polling changes request cadence and work.
A short-lived signed stream ticket in the URL is also rejected: it still enters URL/access logs, requires a new endpoint/key, and native reconnect reuses an expired ticket. A custom SSE grammar is rejected because framing and UTF-8 edge cases are
already solved by a maintained decoder. No DB driver or schema change is needed.

**Targets.** Preserve 90s server polling, MAX_TICKS=20, 270s stale timeout,
prop/sample-window identity and history-session semantics. Preserve 1s initial
/ 30s exponential fallback reconnect, reset on accepted stream open as today.
Owner-approved whole-seconds Retry-After can extend the wait beyond that fallback ceiling, up to 300s.
At most one current fetch/reader, one reconnect deadline/timer and one stale
callback per hook generation; retired generations have zero delivery effects.
One getAuthHeaders call per connection attempt, refreshed on each reconnect;
zero token verification on a mere SSE open, fresh hit or follower. Coalesce
verification within one paid context; fence cached identity at trusted exp
before actual paid admission, without added SQL. Actual provider-boundary work
and limiter advances remain equal to #223's baseline for each scenario.

The 90ms full warm pre-provider deadline remains cache 10ms + admission 53ms +
headroom 27ms; the 53ms share came from #220 PlanetScale measurements. Mock auth
cannot prove real Firebase certificate-fetch/verification or hosted DB latency.
Q0 reports mock verifier latency separately and includes any injected verifier
cost in the mock end-to-end pre-provider measurement, never as free work.
Hosted/full-path proof remains a separate activation qualification.

No client parsing wall-clock screen is required: ticks arrive every 90s. Q0 proves deterministic work and buffer bounds, not a client latency target.

**Requirement reasons.** Bearers stay in headers and diagnostics are fixed
reason classes to prevent credential/identity disclosure. One lifecycle owner,
abort-before-replacement and generation checks prevent overlapping readers and
stale writes. Terminal idle prevents reconnect from restarting MAX_TICKS.
Parser bounds and terminal malformed-JSON handling prevent unbounded buffers
and repeated bad-response reconnect loops. Expiry checks prevent request-local
memoization from preserving an expired user allowance. Anonymous fallback keeps
public odds available consistently with #223; existing quota-floor refusal
still applies. No DB or provider work in the spike avoids interference with
Relay's physical changeover and paid usage. Exact direct dependency ownership
prevents relying on a dev-only transitive installation.

**Assumptions.** Current Next 16.4.6/React 19.3.1/Node 24 app, same-origin public
odds stream, existing Firebase client/auth store and #223 HMAC policies. Modern
ReadableStream/TextDecoder/AbortController support; validate the chosen parser's
ESM/browser build with the installed Next guides and a later app build. Serving
infrastructure must preserve streaming; no deployed proxy/buffering claim is
made by mock tests. Public odds identity is for rate attribution, not account
authorization; requireUid's account-action revocation behavior stays unchanged.


## Owner changes carried forward

- Exact direct apps/web runtime pin eventsource-parser@4.1.3; only app manifest
  and required lock entries change during integration. No transitive override.
- HTTP 429/503 are temporary. Retry-After accepts only whole delta-seconds,
  capped at 300s; dates, fractions, negatives and invalid/missing values use
  existing 1→2→4→8→16→30s fallback. No timer slicing. #224 may revisit longer
  waits/date forms if actual edge rules require them. Current main already has
  a historical-stats 503 path, but no 429 or Retry-After producer.
- Login/logout/account switch retires the old generation; reuse the existing
  identityGeneration including A→B→A. A retained server deadline delays the new
  network attempt rather than letting an identity change evade Retry-After.
- No client parsing latency benchmark: ticks arrive every 90s. Keep work counts,
  framing conformance and bounds. Framework test duration is not a speed claim.
- Signed stream ticket alternative rejected: URL/access-log exposure, a new
  endpoint/key and native reconnect reusing an expired ticket.
- About 3–3.5 active hours including Q0; 4h cap. Report before exceeding it.

## Q0 result and scope

Fixture **223-live-auth-stream**, actual parser 4.1.3 installed only in scratch.
**67 passed, zero failed**: 10 React/jsdom hook tests; 57 Node parser/server tests,
including the unchanged 24 main stream-route tests against the candidate route.
Main's UI state handlers, request context, shared cache kernel and live repository
code were reused with mock auth/query/provider responses. Main is still unmodified.

- Canonical 2KiB tick: all 2,057 byte-split placements deliver exactly once.
  An additional UTF-8/BOM/CRLF frame passes all 81 splits, plus one-byte chunks,
  LF/lone CR, multiline data, comments/unknown fields and incomplete EOF.
- Pending parser buffer and completed JSON event are both bounded at 65,536
  UTF-16 code units after UTF-8 decode. Feed slices <=8,192. The complete-event
  guard is required in addition to the library's pending-buffer option.
- Malformed JSON, null/array messages, over-limit events and wrong Content-Type
  terminate once rather than starting a retry loop. Unrelated named SSE events
  remain ignored, matching today's onmessage-only behavior.
- Idle/204 are terminal; EOF/network/transient failures retry. Tests preserve
  backoff, stale timeout, retained quote/history, sample-window and prop isolation,
  delayed auth, real identity generation changes, StrictMode and queued late frames.
  Cleanup leaves zero fake timers; one current reader on replacement scenarios.
- Auth lookup failure/5s timeout yields one anonymous attempt and no late second
  fetch. getIdToken's underlying promise is not falsely claimed abortable.
- Trusted SDK-expiry metadata invalidates cached signed dimensions at raw
  admission, including a verification completing after expiry. Calls remain
  signature-only; missing token silent, invalid/expired reason-only once/context.
- Both actual live repository modes carry the same context to their odds fetcher.
  Fresh hits/reconnects perform one existing view read and no SDK/weather/odds
  work; there is no additional SQL/limiter advance.
- Reader→mock endpoint→real shared-kernel composition: two clients, one admission,
  one mock paid send/publication and one verification. Four connection attempts
  produce four header lookups/fetches/deliveries. The last fresh reconnect adds
  one existing freshness read, zero additional SQL versus baseline, zero sends.

The initial failed receipts are preserved. They led to the complete-event-size
and non-object JSON guards; an EOF test counter also needed normal-close
bookkeeping. Raw final receipts, source hashes and a separate hash wrapper are
in this scratch directory. No DB server/suite, lane, real provider or credential
was used. Q0 does not qualify Firebase cryptography/certificate-network latency,
a real browser deployment, Next production build or hosted streaming buffering.

## Implementation plan and acceptance to preserve

### C1 — client fetch/SSE transport and lifecycle (about 1h)

On an owner-created/authorized feature branch from current main, add the exact
runtime dependency and a typed single-attempt reader using the maintained parser.
The hook owns the only retry/stale state machine; the reader owns no retry loop.
Keep today’s query identity and history session. Authorization stays in headers;
use no-store same-origin fetch and explicit abort/reader cancellation.

Carry the qualified guards: retire/cancel before replacement, await reader cleanup,
check current generation before every delayed fetch/frame/timer effect, refresh
headers on each attempt, retain the Retry-After deadline, handle terminal idle
and malformed payloads without restarting MAX_TICKS. Route JSON type:error is an
in-stream status, not a reconnect trigger. Diagnostics contain fixed reasons,
not response text, raw SDK failures, bearer values or identity.

Port the existing EventSource-mocked hook tests to a fetch/reader fixture without
dropping their provenance/history/retention assertions; add the Q0 regression
cases. Read the matching installed Next streaming/request guides before route
changes. Report diff/results before committing. The feature branch is created; C1 awaits its own commit approval.

### C2 — expiry-fenced live attribution and final validation (about 1.5h)

Retain a fresh paid context per live tick and remove only its networkOnly=true
restriction. Keep verified user identity request-local and coalesced, but fence
its memoized validity at trusted exp before each actual paid admission. Reuse
#223's signed-user + loose-network and anonymous policies, floor/admission path,
shared/legacy context plumbing and no-extra-work behavior. Preserve discovery
and account-action auth tests; no revocation lookup is reintroduced.

Update the live-attribution code-support marker/docs after tests, keeping schema/
configuration readiness distinct. Enforcement remains hard-coded off; #221's
shared cache, #299 and separately approved #224 activation are still required.
No SQL/schema/driver change, ordered migration, schedule, secret or hosted apply.

CI work budgets: one header lookup per connection attempt; one current reader/
fetch/retry timer/stale callback; zero retired-generation effects; zero extra
SQL/limiter advances on hits/followers; <=1 coalesced verification per paid
context; no expired signed result at admission; zero extra mock provider sends
for fresh-data reconnect; bounded parser/frame data and one termination on a
bad response. The ordinary freshness SELECT remains counted as existing work.

Run focused and full app tests, CI gate/provider boundary, lint, web/DB package
typechecks and production build. No DB suites are planned for this JS/transport
change. If a genuine DB concern emerges, report and obtain a cleared scope/window
first: Relay owns the physical changeover. Preserve compact receipts and report
before any C2 commit, then owner full-branch review. No automatic posting, push,
PR, schema or enforcement activation follows from this roadmap.

## Estimate and approval boundary

Total estimate remains **3–3.5 active hours including Q0**, with a **4h cap**.
The Q0 slot is complete; approximately 2.5–3h remains for typed integration,
complete regression/build checks and receipts, subject to review findings.
Review/approval waits and hosted work are excluded. Report before exceeding 4h.

Owner final-roadmap/branch approval is recorded above. Each commit needs its own approval;
push and PR need fresh consent. No attribution trailers. The #224 retention race
is separate activation work, not an unapproved addition to #299.

## Remote action completed

Approved #224 comment posted, no other issue edits:
https://github.com/ven2dev/dfs-ev-demo/issues/224#issuecomment-7107715995


## C1 review report — 2026-11-23

Branch: `feature/dfsEV-299-verified-live-stream`, fresh worktree from the main
basis above. No commit or push has been made.

- Added the exact app runtime parser dependency and only its lockfile entries.
- Added a typed one-attempt fetch/SSE reader. The hook remains the sole reconnect
  and stale-timer owner. Headers are refreshed once per attempt; identity-generation
  changes abort and replace the connection, with cross-effect teardown serialization.
- Preserved the existing 24 hook regression cases using real byte-stream fixtures;
  added ten lifecycle cases and 25 parser/attempt cases. Slow cancellation,
  queued retired frames, StrictMode/identity ABA, retry deadlines and terminal idle
  are covered. Existing quote/history/provenance and stale timestamps are retained.
- Preserved the Q0 receipt unchanged with a separate receipt hash wrapper.

Validation on Node 24.21.0: **346 browser app tests** across 41 files (including
**59 focused transport/hook tests**), **63 CI-gate checks**, lint and all 12 import
boundary probes, and the root typecheck pass. The default build could not finish
because this environment refuses Turbopack's CSS worker port binding; the supported
`npm run build -- --webpack` build passes compilation, TypeScript, all 16 static
pages and build tracing. No build-script or framework configuration change was made.
The original default-build font download restriction was resolved with build-only
network access; no hosted application or provider endpoint was called.

Receipt: `docs/evidence/stream-299/c1-validation.json`. No DB suite or lane resource
was used. C2 has not started: the server still uses its existing network-only live
attribution. Full server app regression and final activation/readiness documentation
remain C2 work. The publication guard checks an exact commit and will run after
owner approval creates C1's commit. C1 awaits owner commit approval.


### C1 owner review fix and commit approval

The owner approved C1 after separating retry scopes: only a server-provided
Retry-After sets the cross-effect deadline; local 1→30s backoff remains in each
effect. A prop change during 16s network backoff connects immediately; an identity
change after a 429 honors the remaining 120s server deadline. All focused/browser,
CI gate, lint and typecheck checks above were rerun after this fix and pass.
The owner separately reports the default Turbopack build passing on Node 22.23;
ALT's Node 24.21.0 Webpack build passed. These are distinct build observations.
C1 commit is approved, with publication guard verification after commit. C2 may
then start and must be reported before its own commit.
