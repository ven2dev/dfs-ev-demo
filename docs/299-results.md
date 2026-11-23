# #299 final validation

Tested implementation: `f7bdfbeffddf28e292bdc1143a79dd34968c1535` on
`feature/dfsEV-299-verified-live-stream`, based on main `0b15f80`.
Design basis and Q0 proof: [approved roadmap](299-roadmap.md).

## Resulting behavior

The live odds client uses authenticated fetch-based SSE with the exact direct
`eventsource-parser@4.1.3` dependency. The existing hook owns reconnect and stale
timers. Each attempt obtains fresh headers once; identity/prop changes cancel
the old reader and await teardown. Only server Retry-After deadlines survive an
effect replacement; local network backoff restarts. Idle/MAX_TICKS and malformed
or oversized responses terminate without automatic cap-restarting reconnects.
Existing quote, history, sample-window, provenance and stale timestamps remain.

Each live tick creates a fresh lazy paid context. Only SDK-verified UID/expiry
can create signed subjects; post-await expiry checks also fence concurrent
waiters and ownership waits. Expired identity downgrades to anonymous without
repeat verification within that context. No `networkOnly` suppression switch
remains. Missing/invalid tokens still allow anonymous public odds; account-action
revocation checks are unchanged. Health's live-attribution marker reports code
support separately from capability, configuration and enforcement readiness.

## Final checks

ALT ran the following final checks on Node 24.21.0 against the tested implementation:

- `npm test`: **984 browser tests**, **1,028 Node tests**, one existing skip.
- After removing the obsolete network-only test: **349 app server tests**,
  **63 CI-gate checks**, lint including 12 import-boundary probes, root and
  DB-package typechecks, and whitespace checks pass.
- `npm run build -- --webpack`: production compilation, TypeScript, all
  **16 static pages** and build traces pass.
- Exact-commit publication guard passes with zero unapproved findings.
- Both branch commits have no attribution lines. The tree was clean after C2;
  only this final report/evidence checkpoint is now uncommitted for review.

ALT's default Turbopack build was previously blocked by this environment's local
worker-port restriction. The reviewer independently ran the default Turbopack
`npm run build` on `f7bdfbe` with Node 22.23 and reported a pass. This establishes
a default-build pass on the final implementation in the reviewer's environment;
ALT's successful final build used Webpack on Node 24.21.0. The earlier C1
Turbopack result was also reported by the reviewer, not the owner.

## Work budgets and limits

The CI cases cover every byte split of a 2 KiB representative frame (2,057
placements), UTF-8/framing, pending and completed-event 65,536-code-unit caps,
one header lookup/fetch for 20 frames, teardown/late-generation fencing and the
approved retry scopes. Live integration covers one existing read and zero extra
verification/odds/weather on fresh hits in both cache paths. Two mock clients
share one raw-cache admission/send/publication; fresh reconnect adds only its
existing freshness read. Expiry tests include three concurrent cached waiters
and expiry during verification, with one fixed invalid-token warning per context.

These are deterministic mock budgets, not hosted latency proof. The approved
90ms warm pre-provider budget remains cache 10ms + admission 53ms + headroom
27ms (the admission share came from #220 PlanetScale timing). Real signing-key
cold fetch/refresh latency and deployed proxy streaming are not qualified here.

No DB suites, lane resources, hosted work, real tokens or provider calls were
used. No migrations, driver changes or schedules were added. Enforcement remains
hard-coded off. #221 shared-cache readiness and #224's owner activation gates
remain required; this change does not activate them.

## Commits and next approval

- `66a41b4`: authenticated client transport and retry-scope review fix.
- `f7bdfbe`: expiry-fenced server attribution, with `networkOnly` removed.

Final evidence: [receipt](evidence/stream-299/final-validation.json) and
[hash wrapper](evidence/stream-299/final-integrity.json). Earlier Q0/C1/C2 receipts
remain snapshots of their own checkpoints. Final documentation/evidence commit
awaits owner approval, then its own exact-commit publication check. No push or PR
has been made; each requires fresh consent.
