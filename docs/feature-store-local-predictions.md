# Local governed QB predictions — #167

[Approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/167#issuecomment-6622004321).
#138, #163, #166, #231 and the private #235 helpers are merged prerequisites.
This document records the handler's approved design and staged acceptance.

## Design basis

**Pattern:** thin local inference over producer-materialized point-in-time
features and an explicitly selected immutable model run. Follow the functional
core / imperative shell pattern: #235 owns pure compatibility, arithmetic and
response construction; #231 owns context selection and composite authorization.
The handler composes those boundaries rather than implementing their policies.

**Alternatives rejected:** training-membership eligibility excludes new/unlabeled
games and couples service eligibility to outcomes; nested readers duplicate
checks; reimplemented authorization SQL creates policy drift; raw reconstruction
or per-example verification repeats producer work. A mutable latest-model alias
would hide model changes, so requests name the run and supported version/policy
pins explicitly. No cache, new table family, serving framework or HTTP route is
introduced.

**Targets:** every available n=2–16 request uses exactly **3 SQL / 2 combined
rights-status checks / 1 descriptor GET**, with actual rights calls equal to
**2P**, where P is the independently derived distinct union profile count.
Model-only #166 calls remain at **2 SQL**. No per-example SQL/verification,
reader DML, explicit coordination lock or transaction across I/O/calculation.
The completed handler's final full-path p95 is **≤210 ms in each of six separate
cohorts**, leaving **≥30% headroom under 300 ms**. Timing assertions stay outside
CI; deterministic work and behavior are CI gates.

Fixture: Node 24, loopback PostgreSQL 18.6, 512 MiB data tmpfs / 128 MiB shared
memory, the 16 retained nflverse files and real 2,504-row retrospective cohort
(content SHA-256 `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`).
Real historical strict eligibility is zero; synthetic strict/prospective
controls are labelled separately. #231's inherited hot-path spike is supporting
proof; it does not qualify this final handler's speed.

| Requirement | Risk prevented |
| --- | --- |
| Capture named scalar request pins before awaits; never read target labels or caller-supplied histories. | Caller mutation, outcome leakage and forged feature selection. |
| Use one resolver and one composite boundary with descriptor-only selection. | Missing feature lineage, duplicated checks and report outcome leakage. |
| Validate the descriptor against Q1's exact identity/dataset pins and canonical producer policies. | Unpinned or unsupported model execution. |
| Require the served evidence mode among the run's dataset modes. | Retrospective inputs under a strict-only model; training membership is not a gate. |
| Use Q1's selected feature sampleSize, not history.length or a request count. | Concealing inconsistent materializations by silently substituting the array length. |
| Construct the response only after Q2, using Q2 context and both distinct receipts. | Stale flags, omitted delivery authorization or delivery of a private pre-check result. |
| Refuse withdrawal/rights failures without selecting a fallback or returning partial fields. | Reviving deleted evidence or leaking data during revocation. |
| One monotonic deadline covers lookup through complete serialization; interrupted SQL clients are discarded and late GETs cannot resume work. | Late queries, late delivery and reuse of an unsafe connection. |
| New receipt/bundle filenames only; hash each full record before audit. | Overwritten or unavailable measurement evidence. |
| No frozen migrations, hosted commands, route/UI/service or push without fresh consent. | Unapproved rollout or scope expansion. |

**Assumptions:** trusted producers/database owner, private ObjectStore, research
use, and an exclusive connected idle READ COMMITTED client. Histories are bounded
to 2–16. The automatic SELECT AccessShareLock and accepted post-Q2 statement
snapshot gap remain. Resolver metadata stays private until successful delivery.
Local qualification establishes neither hosted round-trip latency nor calibration.

The repeated candidate-selection query in #231 was deliberately left in place
to preserve its measured SQL shape; #167 does not consolidate it.

## Carried #233 corrections and main integration

Step 0 pins UTC in the three proposal functions, distinguishes missing/null
feature references (P2317) from genuine pruning (P1666), and limits date-error
mapping to context reads. Model-only mapping stays as #166 defined it. Only the
existing #231 proposal changed; frozen migrations did not change. Reviewed
Step 0 receipts and the metadata-only receipt relabel are append-only under
`docs/evidence/feature-store-167/`.

Main integration `c6c7136` includes #235 and main's dataset/object-store/dependency
updates. Fresh work controls retained 3/2/1 at every n, 2P rights calls, matched
database work and model-only 2 SQL. The recorded integration passed 1,399 unit
tests, 220 feature-store checks, typecheck, lint and all three evidence audits.

## Step 1: thin handler composition

Public workspace entry: `@dfs-ev/pipeline/feature-store/predict` exports
`predictQbModel` and its request/result types. It accepts the dedicated connection,
a descriptor-only GET capability and an explicit request. There is no provider
setup or application route. The existing readers supply every SQL statement.

| Stage | Work |
| --- | --- |
| Context | `resolveModelContext`: one metadata query; release nothing. |
| Q1 | `withModelArtifacts`: combined model/served-feature authorization and value pins. |
| Descriptor | One GET, private JSON parse and `validateModelDescriptor`. No report/dataset/raw GET or request-path hash. |
| Math | `computePredictionForecast` with Q1 history, Q1 feature sampleSize and the captured line. No example requalification. |
| Q2 | The same composite boundary rechecks the original immutable scope and refreshes context. |
| Delivery | `buildPredictionResponse` receives Q2 context plus Q1 authorization and Q2 delivery receipts; serialize one complete response. |

The result is `{ response, serialized }`. Available responses include the explicit
model and feature identities, versions/mode/policies, line/sample count and
Over/Under/Push probabilities, clocks, last-valid/freshness flags, lineage and both
receipts. Histories, descriptor bytes and reports remain private. Each response
includes `connectionDisposition`. Refusals contain only status, stable reason
and connection disposition, including when Q2 fails after private computation.

Existing P2311–P2316 diagnostics, P2317 reference refusal, P1666 withdrawal,
P1665 rights and other typed reader errors retain their existing names. Handler
validation adds invalid-request, unsupported-model-policy, descriptor-mismatch,
evidence-mode-mismatch and materialization-refused. Unknown errors expose only
prediction-unavailable. Dropped or unsafe SQL connections are discarded without
retry or extra cleanup SQL. Storage/validation refusals leave an idle client
reusable. Provider diagnostics and causes are not serialized.

Step 1 tests call the actual handler, resolver, composite reader and helpers with
synthetic transport replies. They prove all-n 3/2/1 order; selected-count mismatch
refusal; Q2 flags/clocks and distinct receipts; immutable request capture; mode
compatibility; same-game QBs; poisoned labels/caller histories/example fields;
and exact prefix traces with no partial fields for refusals. These are contract
controls, not PostgreSQL rights/race or latency qualification.

## Step 2: one deadline and integrated delivery proofs

`predictQbModel` accepts optional `signal` and absolute monotonic `deadlineAt`.
One 300 ms deadline/cancellation latch, shortened caller
deadline, remaining query timeout and GET-abandonment containment, without SQL
changes, covers the complete operation. Pre-expiry/abort does no work. Interrupted SQL clients are ended;
abandoned GETs stay private and cannot trigger math, Q2 or delivery. Checks after
synchronous math and complete serialization withhold late results. Real LOGIN
tests exercise permissions, completion-time/correction semantics, deletion,
rights races, distinct refreshed receipts, no reader coordination locks, dynamic
2P budgets and matched n=2/16 database work. No machine-speed assertions run in CI.

The interruption promise races the whole private task. Its persistent latch is
checked before/after SQL and GET, before/after math, after response construction,
after serialization and immediately before return. An ignored/late GET or SQL
completion cannot resume a refused request. Each SQL call receives the remaining
`query_timeout` in its existing query configuration; no SET, BEGIN, cancellation,
rollback, retry or health-check query is added. Options and request scalars are
captured before the first await. A non-finite caller deadline refuses immediately.

SQL interruption initiates one `client.end()` and returns a discard disposition
without waiting for a possibly broken close handshake. The eventual end/task
outcomes are observed. Cancellation during storage or calculation keeps an idle
SQL client reusable because the latch prevents any later query. JavaScript
synchronous work remains non-preemptible, so post-work clock checks withhold an
over-budget success even if the timer has not run. Timeout/cancellation reasons
win over a lower reader's wrapper error and reveal no partial fields.

The actual-handler PostgreSQL tests independently measure distinct union profiles
for every invocation and assert exact prefix work even on refusals. Thirty all-n
success controls cover shared and separate lineage. A measurement-only wrapper
samples database counters around the original Q1/Q2 functions during matched
n=2/16 handler calls; deliberate scan/DML controls prove the observers detect
hidden work. Pauses in descriptor GET and after private math show an idle backend
with no transaction or locks while another writer deletes a cited dataset. This
is test-only instrumentation; proposal SQL and production authorization remain
unchanged. Model-only delivery retains its two-query compatibility control.

The real database probes also exercise selected-count mismatch, label
create/change/removal invariance, same-game QBs, evidence-mode refusal,
job-completion knowledge time and last-valid flags, P2311–P2317/P1666 distinctions,
independent model/feature rights races, both deletion APIs, missing/corrupt
descriptors, lost Q2 reply, pre-expiry/cancellation, late GET containment and
sleeping SQL timeout/cancellation at all three query stages. Deterministic unit
clocks additionally cover a shared shrinking allocation, hung GET/end handshakes,
abort during math and synchronous math/serialization exhaustion.

## Step 3: final qualification and durable evidence

Final local-fixture qualification passed: cold cohort p95 values **38.466,
31.846, 35.091 ms**; warm **8.169, 10.948, 7.043 ms**. The worst cohort retains
**87.18% headroom**. All 600 candidate samples meet 3 SQL / 2 checks / 1 GET;
the separate model-only compatibility control remains 2 SQL. See the evidence
README below for setup shares, precise receipts and reproduction commands.

The opt-in `prediction-benchmark.ts` runner calls the public `predictQbModel`
unchanged. It first measures 45 unchanged #163 reference requests before
installing model/composite proposals. Six separate cohorts follow: three fresh
connections and three dedicated warm connections. Each uses ABBA, 50 reads per
position (100 candidate and 100 reference); every n=2–16 appears in both arms.
The reference authorizes features only and repeats its original per-row
qualification; its ratios are informational, not a substitute gate.

Each candidate cohort independently needs nearest-rank full-path p95 ≤210 ms
and ≥30% headroom under 300 ms. Cold setup starts before Client construction and
consumes the same absolute deadline passed to the handler. Connection close is
outside timing. Each individual duration includes lookup, Q1, descriptor GET and
validation, math, Q2, complete response/serialization and final delivery check.
SQL/storage/hash observers and output assertions add included overhead. Math and
serialization are not individually instrumented: their sample stage fields are
zero, while their actual work remains in total duration. Never add stage
percentiles or pool cohorts to qualify a slow one. Failures stop qualification
and remain in the full record.

The same real fixture is rebuilt from 16 retained inputs and checked against the
2,504-row content hash above. Request selection uses feature metadata only, with
one real player/game at each n; neither labels nor training membership gate
selection. Model-only compatibility and independently derived 2P/database work
are measured outside timing; instrumentation is restored before timed reads.
Step 2's handler probes additionally prove matched n=2/16 work and no locks.

New compact receipts and exact deterministic compressed full records live under
[the final #167 evidence guide](evidence/feature-store-167/final-qualification-20261105T1615Z.md). Each measured
SQL/TypeScript source has SHA-256 and a git blob ID, including uncommitted harness
bytes; the base HEAD alone does not identify a candidate. The TypeScript auditor
checks each member's hash and size before recomputing the schedule, six
percentiles, setup shares and work counts. Database-free CI checks membership,
hashes and recorded arithmetic without a speed assertion. Synthetic negative
controls prove the opt-in gate rejects one slow cohort, duplicate coordinates,
tampered counts, missing cohorts and incorrect setup arithmetic.

Local-fixture qualification does not establish hosted RTT/region (#220), cold
data/OS caches, fresh-process startup or product clearance. Both arms share a
running Node process and unflushed OS/file/database caches. Historical strict
eligibility remains zero; synthetic strict/prospective behavior controls do not
qualify speed.

| Acceptance | Proof |
| --- | --- |
| Session-independent clocks and typed malformed/withdrawn references | Reviewed Step 0 cross-zone and refusal receipts; append-only relabel retained. |
| Explicit pins, compatible evidence mode, unlabeled contexts and target independence | Handler descriptor/refusal tests and real handler label/same-game probes. |
| Selected sample count and Q2 flags/both receipts | Actual-handler mismatch refusal and paused-GET refreshed-context probes. |
| Fixed n-independent client/server work | Thirty all-n controls, 2P per probe, matched n=2/16 database counters and negative controls; model-only 2 SQL. |
| Permissions, deletion, pruning and rights races with no reader coordination locks | Real restricted LOGIN and concurrent-writer handler probes. |
| One deadline, no late queries or partial delivery | Shrinking timeout, sleeping SQL/abort, late GET, math/serialization and lost-Q2 controls. |
| Final speed and reproducible evidence | Six actual-handler cohorts, exact samples in-tree, hash-first TypeScript audit. |

Each step stops for commit approval; pushes require fresh consent. Retain and
report any `artifact-cleaner.check.mts` failure from a full-suite run before
retrying it. Stop and propose a split if work exceeds the approved estimate.
