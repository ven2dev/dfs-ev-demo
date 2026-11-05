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

## Remaining acceptance: Steps 2 and 3

Step 2 adds the single 300 ms deadline/cancellation latch, shortened caller
deadline, remaining query timeout and GET-abandonment containment, without SQL
changes. Pre-expiry/abort does no work. Interrupted SQL clients are ended;
abandoned GETs stay private and cannot trigger math, Q2 or delivery. Checks after
synchronous math and complete serialization withhold late results. Real LOGIN
tests exercise permissions, completion-time/correction semantics, deletion,
rights races, distinct refreshed receipts, no reader coordination locks, dynamic
2P budgets and matched n=2/16 database work. No machine-speed assertions run in CI.

Step 3 measures the actual final handler on the real fixture. Three cold and
three warm cohorts independently need p95 ≤210 ms / ≥30% headroom; cold connection
setup is included and its share reported separately. Keep every failed sample;
do not pool cohorts or add stage percentiles. Add new compact receipts and exact
deterministic compressed full records; the TypeScript auditor checks member
hash/size before recomputation from a checkout with no cache or database.

The issue remains incomplete until those stages pass. Stop and propose a split
if total work exceeds the owner-approved 3.75–4.5-hour estimate. Each step stops
for commit approval; pushes require fresh consent. Retain and report any
`artifact-cleaner.check.mts` failure from a full-suite run before retrying it.
