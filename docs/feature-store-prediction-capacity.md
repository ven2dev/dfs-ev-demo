# Prediction capacity (#168)

The #168 results below retain their original contract. The approved
[#242 startup-gate update](https://github.com/ven2dev/dfs-ev-demo/issues/242#issuecomment-6718023389)
is described at the end of this document; its new qualification is pending.

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

## Step 1 measurement contract

`prediction-benchmark.ts --capacity` extends the existing benchmark entry
point; its original #167 ABBA mode and evidence remain available unchanged.
The capacity mode refuses uncommitted measured source bytes. Setup rebuilds the
same fixture, publishes the model, derives requests from feature/job and
roster/schedule metadata, and writes a hashed manifest before any request runs.
The manifest includes all pins, expected feature/cutoff, season/team and the
approved diversity rules. No labels or dataset membership select requests.

The fixed trial order is C1/W1/C2/W2/C3/W3. Each has 100 attempts in the same
manifest order. Each cold attempt forks a fresh Node 24 process with native type
stripping, disabled compile cache, no inherited loader options and a fresh
restricted connection. A tiny bootstrap sends only a boot notice before its
dynamic application import. Timing starts in the parent before fork and ends
when the complete serialized result arrives. Cleanup is outside timing. Warm
trials have one dedicated process and idle pool connection, with setup disclosed
separately. Every request still reads current rights/status twice and GETs the
descriptor; there is no forecast, descriptor or rights cache.

The parent enforces the full 300 ms deadline and ignores late messages. Only a
remaining duration crosses IPC; the child derives its deadline on its own
performance.now() clock. The production owner helper controls checkout and
exactly-once disposal. A terminal parent deadline/abort kills that worker and
prevents later delivery; the configured server timeout remains the accepted
statement-relative backend fallback. No refusal or failed attempt is replaced.

Every cold record separates parent spawn-event time (overlapping bootstrap),
spawn-to-bootstrap, dynamic import, ObjectStore setup, connect, handler through
serialization and the IPC/observer residual. Bootstrap + import + store + connect
defines startup; per-sample startup above 210 ms stops for owner direction. Full
durations alone determine nearest-rank per-trial p95; phase percentiles are never
added. The 210/300 ms gates apply independently to every trial, never to a pool
of the six groups. Failures and all preceding samples are retained immediately.

The existing TypeScript hash-first auditor additionally recomputes the request
hash/coverage, trial schedule, every sample's 3/2/1 and zero-hash work, process
provenance, setup shares, independently derived 2P probes and model-only 2 SQL.
Separate warm-process controls prove rights revocation and legal deletion are
visible without restarting it. Normal CI uses synthetic durations and structural
work proofs; it does not measure machine speed. Audits still need only Node and
tar, without node_modules, a database or local cache.

`--capacity --controls-only` is an explicitly unqualified Step 1 control run:
it exercises one cold and one warm request, all-n server work/model-only controls,
and the warm revocation/deletion controls. It cannot qualify the six-trial speed
target. The final qualification runs only after Step 1 approval and commit.

## Final qualification — 2026-11-06

The first final run passed on committed measurement/runtime sources at
`a9a81e1ade238deb61df6491f1332ecc692c71f4`. All 59 recorded source SHA-256s
and Git blob IDs matched HEAD before the run and remained unchanged afterward.
The combined source digest is
`63f3f88e82a8b71725f5788b69e08f376c2d7b698afdd8e6452073c86bc47280`.
The following evidence/documentation commit does not change those sources.

| Trial | Available / attempts | Full-path p95 | Headroom under 300 ms | Maximum | Startup p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| C1 | 100 / 100 | 123.947 ms | 58.68% | 142.130 ms | 97.734 ms |
| W1 | 100 / 100 | 6.022 ms | 97.99% | 26.326 ms | setup separate |
| C2 | 100 / 100 | 127.873 ms | 57.38% | 235.586 ms | 101.509 ms |
| W2 | 100 / 100 | 5.722 ms | 98.09% | 24.613 ms | setup separate |
| C3 | 100 / 100 | 137.044 ms | 54.32% | 215.118 ms | 104.952 ms |
| W3 | 100 / 100 | 5.682 ms | 98.11% | 30.349 ms | setup separate |

Each trial independently meets p95 ≤210 ms and ≥30% headroom; the minimum
headroom is 54.32%. There are no refused/failed measured samples, retries,
replacements or pooled gates. The two expected warm rights/deletion refusals
are retained separately and contribute no successes or latency samples.

There are 300 distinct cold worker PIDs and three distinct warm worker PIDs.
Cold timing includes spawn/import/connect, the complete handler and serialized
IPC delivery. Across cold samples, startup p95 is 101.791 ms, maximum
209.445 ms and aggregate setup share 77.42%. That maximum remained below the
approved 210 ms startup stop threshold; startup tail variation remains visible.
Warm worker setup is 86.186 / 82.841 / 86.702 ms for W1/W2/W3, disclosed outside
warm request timing. Warm handler-only p95 is 5.279 ms; full-path trial gates use
the larger complete parent-observed durations above.

The manifest was written and hashed before timing:
`d10d1238dad39bcf8bc3621f8f1f7567f4aca09aaae355dbac82ce76e02dbce2`.
Every trial uses the same 100 distinct QB/game coordinates: 100 QBs, 32 teams,
1% maximum player share, every n=2–16 and all five seasons × three history bands
(6–7 requests per cell). Feature/job and roster/schedule metadata alone select
requests; neither labels nor training membership participates.

Every one of the 600 measured predictions has exactly 3 SQL / 2 combined
rights-status checks / 1 descriptor GET / 0 request hashes. All-n server probes
independently derive P (16 profiles here) and observe 2P rights calls, zero
reader DML, hidden example-table work or explicit coordination locks. Model-only
reads retain 2 SQL. The warm controls demonstrate current rights and deletion
status are observed on the same existing process/connection. Earlier matched
n=2/16 relational-work and full-path/deadline controls remain in Step 0 evidence.

This is local-fixture qualification: Node 24.18.1 native type stripping,
Apple M3 Pro / arm64 / 18 GiB RAM / Darwin 27.2.0, loopback PostgreSQL 18.6,
512 MiB data tmpfs / 128 MiB shared memory. OS/file/database caches were not
flushed and fixture preparation warmed them. Fresh application processes do not
establish cold storage/database, hosted latency or concurrency throughput.
The retained 16 input files reproduce the natural 2,504-row dataset and expected
content hash. Strict historical eligibility remains zero; retrospective outputs
retain historical-availability-unverified. No population-completeness claim is
made, and no producer knowledge clock is backdated.

Final Node 24 validation passes 1,545 repository unit tests, 253 feature-store
checks, typecheck and lint. The 22 evidence tests and 11 import-boundary checks
also pass, including a final rerun after making the shared Step 0 bundle check
hash-only in CI. No artifact-cleaner failure occurred. Both compressed bundles
reproduce byte for byte, and an isolated checkout without node_modules or cache
passes the four issue audits plus final/owner evidence tests.

## Acceptance mapping

| Requirement | Final proof |
| --- | --- |
| Step 0 payload/deadline/ownership fixes | Separate response/serialization/disposition; same-process shortening-only deadline; query-only handler; exported owner helper. Step 0 behavior/unit/real-LOGIN records qualify disposal, fallback timeout and no late work. |
| Pinned diverse requests and exact response boundary | Pre-timing manifest hash, complete ordered requests and coverage in the final full record; nearest-rank p95 on parent-observed spawn/send through serialized receipt. |
| New process/connection for every cold sample | 300 distinct cold PIDs, positive per-sample bootstrap/import/connect diagnostics; three dedicated warm workers with separate setup. |
| Current warm rights/status and cache disclosure | Separate retained same-process allowed → rights-refused → deletion-refused controls; unflushed OS/file/DB caches disclosed above. |
| Six independent ≤210 ms / ≥30% headroom gates | Six 100/100 trials above; 600 retained individual durations and no replacement/pooled pass. No optimization comparison or ABBA claim is made. |
| Fixed work and no per-example verification/locks | Per-sample 3/2/1 and zero hash traces; independent all-n 2P/server-counter/lock probes and model-only 2 SQL. |
| Durable compact receipts and detailed ObjectStore records | Every duration/status/work verdict, pins, environment/input/source hashes and safe member SHA-256/size; exact deterministic bundle persisted through ObjectStore before the in-tree mirror. |

[Final evidence and audit instructions](evidence/feature-store-168/FINAL.md)
include cold-phase diagnostics and the exact full-record digest. The new final
evidence tests hash before parsing and recompute schedule/work/provenance with
the speed gate disabled in CI. The opt-in audit also enforces all six recorded
speed gates. #167 and earlier #168 evidence remain unchanged history.

## Trial-level startup qualification (#242)

### Design basis

**Pattern.** Versioned benchmark contracts, with one shared pure trial summary
for the runner and auditor. The process driver reports outcomes and phases,
enforcing individual deadlines without deciding a trial percentile. This follows
the existing capacity pattern and changes no handler, owner helper, SQL or work
budget. Implementation is limited to the capacity process driver, runner and
auditor; tests, documentation and new evidence accompany those changes.

**Alternatives.** Dropping startup qualification loses an explicit requirement.
Changing only the runner leaves the process driver and auditor in disagreement.
Changing the formula globally would reinterpret #168's accepted historical
records. A separate benchmark framework adds another source of policy drift.

**Targets and reasons.** Each cold trial's startup nearest-rank p95 is ≤210 ms,
so isolated tail samples do not replace the agreed trial statistic. An individual
startup above 300 ms fails the sample and stops qualification, preventing a
pathological tail from qualifying under a percentile. Exactly 300 ms meets this
inclusive numeric bound; the parent still enforces its real-time deadline and
ignores late replies. Startup is part of the parent-observed full path, not an
extra interval outside request timing. The explicit startup bound also guards
inconsistent phase metadata.

Startups above 210 through 300 ms remain eligible subject to the trial p95.
Every cold trial reports its maximum and five slowest startups, with original
sample indices, PIDs and feature IDs; descending duration and ascending index
break ties deterministically. Every full-path trial still has p95 ≤210 ms and
≥30% headroom under 300 ms. Refusal, error, work mismatch or either sample
duration above 300 ms stops the run after retaining the sample, preventing
retries or fast refusals from disguising failure. Trials are never pooled.

Keep 3 SQL / 2 combined checks / 1 descriptor GET, zero request-path hashes,
independently derived 2P rights calls and model-only 2 SQL to preserve serving
work. Keep 100 requests per trial, ≥20 QBs, ≥16 teams, ≤5% per player, all five
seasons × three history bands and every n=2–16 to prevent cherry-picking.
CI proves work and synthetic/recorded arithmetic without live timing gates.

**Assumptions.** The unchanged real 16-file / 2,504-row fixture, Node 24 native
type stripping, loopback PostgreSQL 18.6 and standard compose.test.yml database
(512 MiB data mount / 128 MiB shared memory), with no setting changes. OS/DB
caches remain unflushed and fixture preparation warms them. Each cold prediction
starts a fresh process/connection; warm setup stays separately disclosed. These
results make no hosted, concurrent-throughput or cold-storage claim.

### Contracts and feasibility

Schema 1 / issue 168 keeps the original per-sample 210 ms startup rule and exact
summary/receipt shape. Schema 2 / issue 242 records the fixed startupGate policy
(trial-p95, 210 ms p95, 300 ms sample deadline, five tail samples). Unsupported
schema/issue/policy combinations refuse, including on failed-run receipts, so a
new record cannot silently select a different rule. The existing hash-first
auditor dispatches by that recorded contract. #168's receipts and bundles stay
byte-for-byte unchanged and continue to audit under their original rule.

Read-only recomputation of #168's hash-verified final record gives cold startup
p95s 97.734 / 101.509 / 104.952 ms and maxima 121.868 / 209.445 / 186.025 ms.
All pass both rules. Synthetic nearest-rank arithmetic over 100 samples confirms
five slow values leave p95 at the 95th fast value; six move it into the slow
group. This is feasibility evidence, not a new qualification or live timing run.

### Approved delivery

Step 1 changes and tests the contract, including runner stop/persistence,
inclusive thresholds, historical compatibility and tail tamper controls. It
needs commit approval before timing. Step 2 qualifies only committed sources
with the existing C1/W1/C2/W2/C3/W3 schedule and appends new timestamped evidence
under docs/evidence/feature-store-242/, through ObjectStore and a deterministic
in-tree mirror. The runner also pins the merged #241 proposal SQL loaded by the
harness; no SQL changes are part of #242.

The owner confirms a quiet host window with ALT before fixture preparation and
timing. A miss stops the run and keeps its samples; there is no larger-disk or
settings substitution. Estimate is 2.5–3.5 hours. Each step stops for commit
approval; push/PR needs fresh consent. #169 waits for #247 to merge.
