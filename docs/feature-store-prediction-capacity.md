# Prediction capacity (#168)

Approved [measured roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/168#issuecomment-6674037913),
based on merged #167/#239 at `17e07d6`. Owner waived the issue’s 5-hour split
rule on 2026-11-05; #168 includes step 0 at an approved 5.5–6.5 h. Stop and
report if scope grows past 6.5 h. Each step needs commit approval; pushes need
fresh consent.

## Design basis

**Pattern.** Caller-owned connection lifetime around the existing thin local
prediction boundary, then absolute workload qualification with pinned stratified
requests and repeated fresh-process/warm trials. Reuse #167's fixture, runner,
work observers and TypeScript evidence auditor. #231 continues to own context
selection and combined authorization; #235 owns pure compatibility/math/response
helpers. Step 0 changes resource/API contracts without adding SQL or locks.

**Alternatives.** Handler-owned end/release violates the lifetime of a borrowed
connection. A client timeout alone rejects a promise while leaving backend work
unbounded; use immediate owner disposal plus a server startup timeout. Reusing
#167's cold-connection evidence omits process startup and precedes these source
changes. Restarting once per 100 cold predictions hides startup behind 99 warm
requests. Selecting one player or using label/training membership misses workload
diversity or makes availability depend on outcomes. A cache or serving framework
changes the operation and risks stale authorization instead of qualifying it.

**Targets.** The same 16 retained inputs, natural 2,504-row retrospective fixture
with content SHA-256 `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`,
Node 24, loopback PostgreSQL 18.6 with 512 MiB data tmpfs / 128 MiB shared memory.
Final qualification: three cold and three warm trials, 100 available predictions
each, every trial nearest-rank full-path p95 ≤210 ms and ≥30% headroom under
300 ms. A refusal never counts as success; stop on a miss and retain its samples
so fast refusals or retries cannot hide failure. Each cold sample starts its own
process and connection; timing includes spawn through complete serialized receipt.

CI budgets: exactly 3 SQL / 2 combined rights-status checks / 1 descriptor GET
at every n=2–16; rights work 2P for independently derived union profile count P;
model-only reads remain 2 SQL; zero request hashes/per-example verification,
reader DML or explicit coordination locks. These prevent nested authorization,
row-dependent work and blocked writers. No machine-speed assertion runs in CI.

Pin/hash the workload before timing, including ≥20 QBs, ≥16 teams, no player
above 5%, all five seasons × three history bands (2–4/5–8/9–16), every exact n
and 100 distinct player/game coordinates per trial, to prevent cherry-picking.
Persist full records through ObjectStore and retain an exact compressed in-tree
mirror with compact hash-first receipts so clean-checkout audits stay durable.
#167 evidence remains unchanged; new evidence identifies final committed sources
so the old qualification is not misrepresented as proving the changed code.

**Assumptions.** Trusted producers/connection owner, private store, research use,
serial calls on an exclusive idle non-pipelined READ COMMITTED connection. Pool
configuration and session settings remain under the owner's control. OS/file/DB
caches remain unflushed; fresh process means fresh application/module/JIT state,
not cold disk/database. The post-Q2 snapshot gap and non-preemptible synchronous
JavaScript limit remain. No hosted, concurrency-throughput or product-clearance
claim is made.

## Approved feasibility proof

Disposable sources outside every repo checkout, Node 24.18.1 native type
stripping, pg 8.23.1, Apple M3 Pro / 18 GiB RAM. One cold and one warm trial each
returned 100/100 available predictions. Cold full-path p95 **122.412 ms** / **59.20%**
headroom; warm **5.328 ms** / **98.22%**. Cold phase p95: spawn-to-bootstrap
29.539 ms, import 54.745 ms, store setup 4.581 ms, connect 10.847 ms, handler
28.723 ms. Phase percentiles are not additive. Per-sample startup p95 was
94.458 ms, maximum 125.569 ms. Both trials covered 100 QBs / 32 teams / maximum
player share 1%, every n and all 15 season/history cells (6–7 requests each).
Manifest SHA-256: `131a7a585289af195807b652edcd44be8a7bf1e678538066480b680115a1a2f2`.
All samples used 3/2/1; all-n 2P, model-only 2 SQL and ownership controls passed.
This is feasibility proof only. The final six trials run after measured sources
are approved and committed, and preserve every sample on failure.

## Step 0 contract

`predictQbModel` borrows query-only access. It returns
`{ response, serialized, connectionDisposition }`; disposition stays outside
both delivered response and JSON to avoid leaking internal connection plumbing.
Refusals deliver only status and stable reason, with no private partial result.

`deadlineAt` is an absolute **same-process performance.now()** clock value. It
can only shorten the 300 ms default; a later or non-finite value refuses with
invalid-request before SQL/GET instead of being silently clamped. Already elapsed
deadlines refuse with deadline-exceeded. Numeric validation catches impossible
values such as Date.now(), not every coincidental value from another clock;
using the correct clock remains the caller contract.

The handler never ends/releases its borrowed client. Its persistent interruption
latch prevents later SQL/math/delivery after SQL/GET settles late. It marks
interrupted or unsafe SQL sessions discard. A storage/calculation interruption
can leave an idle session reusable because no later SQL is allowed.

The exported connection owner opens/acquires a serving connection, runs the
handler and disposes exactly once: release() for reusable pool clients,
release(true) for discard, end() for an owned standalone client. Acquisition and
handler share one deadline; a late acquisition is discarded without running the
handler. Failed connect and error paths also clean up. Close starts immediately;
an unresponsive close handshake does not delay refusal indefinitely.

Startup statement_timeout is bounded to ≤300 ms without SET/BEGIN/request SQL.
The server timeout bounds a statement from arrival, not to the exact request
deadline. Disposal initiates termination; it does not promise immediate backend
cessation. The probe's backend-inactivity/no-late-query controls completed
255–281 ms after disposal began, including a 30 ms quiet period. This accepted
fallback prevents unbounded SQL while the handler latch prevents late delivery.

Step 0 tests cover delivered shape, deadline boundaries/wrong clock, no handler
end/release, real standalone/pool disposal, failed/late acquisition, sleeping SQL
at context/Q1/Q2, delayed disposal/server timeout, late GET/query settlement,
synchronous overruns, no partial delivery, all-n/2P/matched-work and model-only
compatibility. Run Node 24, exclude codex-briefs/**, and retain/report any full-suite
artifact-cleaner failure before rerunning. No SQL/migration/hosted changes.

## Step 0 verification

Fresh implementation on `feature/dfsEV-168-prediction-capacity`, based on
`17e07d6`. Node 24 passed 1,511 repository unit tests, the 249-check feature-store
suite (including the cleaner), typecheck, lint and 11 import-boundary controls.
The subsequent 17 evidence checks include two new #168 checks. Hash-first audits
pass for #166/#231/#167/#168; the #167 directory remains byte-for-byte unchanged.
The focused owner tests cover normal/failed/late acquisition, no late SQL and
exactly-once disposal. A broken monitoring observer in the initial DB test run
was corrected; its failed output remains in the local review logs. No cleaner
failure occurred.

[New Step 0 evidence](evidence/feature-store-168/README.md) retains the 16-probe
handler proof (30 all-n lineage controls, matched relational work, 2P and model-only
2 SQL) plus six real owner controls. Both raw records were persisted through
ObjectStore and mirrored exactly in a deterministic 19,838-byte bundle. Receipts
record SQL/TypeScript source SHA-256 and git blob IDs. Every available request
retains 3 SQL / 2 checks / 1 descriptor GET; the handler has no end/release capability.
This is behavior/work verification only. Final capacity qualification remains
pending approved commits for the remaining measured sources.
