# Private prediction helpers (#235)

The owner approved the [roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/235#issuecomment-6622741080).
Steps 1–2 supply descriptor compatibility, forecast arithmetic and response data
for #167. They remain private pipeline helpers; #167 supplies the guarded handler.

## Design basis

**Pattern.** Functional core with an imperative shell. The private pipeline
module `services/pipeline/src/featureStore/predictionHelpers.ts` accepts values
and returns owned values or bounded typed failures. #167 supplies acquisition,
the existing composite Q1/Q2 boundary, deadlines and delivery. Selection and
authorization remain in #231; these helpers grant no access.

**Alternatives rejected.** Reusing the evaluator as a serving reader repeats
eligibility/label work or nests authorization. An inference framework or public
helper API adds configuration and composition paths for one fixed descriptor.
Duplicating supported-policy constants risks drift; importing producer/reader
implementations at runtime pulls I/O into the core. Instead, trusted pipeline
code supplies policy values assembled from existing constants. Arithmetic uses
the existing public domain empirical kernel.

**Targets.** Descriptor dataset sets contain 1–2 entries; histories have n=2–16.
Helpers perform **0 SQL, 0 authorization calls, 0 ObjectStore/file/network
operations, 0 hashes, 0 per-example verification and 0 serialization/delivery**.
Step 1 validation depends on the bounded descriptor/pin set, not history size.

#167 retains context → Q1 → descriptor GET/parse → math → Q2 → response/
serialization → delivery: **3 SQL / 2 combined checks / 1 GET**, full-path
**p95 ≤210 ms per cohort**, at least **30% headroom under 300 ms**. Its final
benchmark uses #138's 16 retained nflverse files and natural 2,504-player-game
fixture, content SHA-256
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
#231's corrected-source 30.212 ms / 89.93% result proves the inherited flow,
not this implementation. The owner approved final benchmark only in #167 unless
the design changes. This issue adds no acquisition flow or arithmetic algorithm.

**Requirement reasons.**

| Rule | Risk prevented |
| --- | --- |
| Private value-only API; no package export, SQL, clients, stores or callbacks. | Hidden I/O, duplicate authorization or delivery outside Q1/Q2. |
| Trusted supported-policy input, exact recorded identity and exposed dataset-pin equality. | Caller-controlled allowlists, silent version fallback or provenance confusion. |
| Served mode occurs in run dataset modes, with no training-member or target lookup. | Incompatible evidence and outcome-dependent prediction availability. |
| No per-example verification or clock reinterpretation. | Repeating producer work or altering #231's point-in-time selection. |
| Own returned containers; preserve inputs. | Mutation changing policy or a later response across awaits. |
| #167 owns Q2, serialization and the final deadline gate. | Private/partial results escaping before delivery authorization. |

**Assumptions.** Trusted producer/database owner and pipeline caller; private
artifacts and research use. The descriptor has already been fetched and parsed
inside #167's trusted Q1 callback. Q1 provides authoritative immutable run and
dataset pins plus the authorized context. Q2 refreshes status/freshness before
delivery. Parsed descriptor JSON is data, not executable caller objects. These
helpers do not independently verify transport bytes or claim to be a public
security boundary. Type-only local imports avoid reader initialization. Runtime
imports are `node:util` for structural equality and the dependency-free public
`@dfs-ev/domain/empirical` arithmetic kernel.

## Step 1: descriptor compatibility

`validateModelDescriptor` takes an unknown parsed descriptor, explicit request
pins, Q1 run/dataset pins and context, and a trusted `SupportedPredictionPolicy`.
That policy is supplied from existing pipeline/domain constants; public request
or descriptor claims do not determine its membership.

The validator checks:

- Descriptor format `qb-model-descriptor-v1`, research scope, run identity format
  `qb-model-run-v1` and designation `uncalibrated-interim-hit-rate`.
- Explicit run UUID equality and complete structural equality of the descriptor
  identity with Q1's recorded identity, including code and preregistration pins.
- Supported model, feature, label, history, scoring and adapter policies, plus
  player/game/version/mode agreement with the resolved context.
- The exact unordered dataset set by `datasetId`, `mode`, `fileSha256`,
  `contentSha256`, `spec` and `rowCount`. Empty, duplicate, missing, extra or
  mismatched pins refuse. The set is bounded to one or two distinct modes.
- The served feature's actual evidence mode occurs in that set. A strict-only
  run refuses retrospective input; a run with both modes accepts either.

Q1's descriptor-only dataset projection omits transport `objectKey`/`byteSize`;
the validator makes no independent claim about those fields. `recordedAt` is not
a descriptor dataset pin. Reports, input artifacts, training membership, target
labels, histories and selection/freshness clocks remain unread. In particular,
knownAsOf spelling is not compared with resolver-canonical timestamp strings.

The result contains run/descriptor identity, validated policy values, actual mode
and dataset modes. It owns its adapter and mode-array containers and retains no
arbitrary descriptor or dataset-spec objects.

| Private `PredictionValidationError.code` | Meaning |
| --- | --- |
| `invalid-request` | Missing/malformed explicit run, player or game identity. |
| `unsupported-model-policy` | Requested or recorded policy is outside the trusted supported policy. |
| `descriptor-mismatch` | Descriptor shape, identity, context or exposed dataset pins disagree. |
| `evidence-mode-mismatch` | Otherwise-valid run has no dataset in the served feature's mode. |
| `materialization-refused` | Malformed/count-mismatched history, sample size outside 2–16 or non-finite/non-numeric support. |

JSON parse failures and mapping private errors to bounded unavailable responses
belong to #167. No partial response is constructed by this validator.

## Step 2: forecast and response data

`computePredictionForecast` accepts the private Q1 history, its declared sample
size and a finite numeric line. A non-finite/non-numeric line refuses as
`invalid-request`. An array/count backstop enforces integer n=2–16 and exact
length. The helper extracts only `yards`, constructs equal-mass support once and
evaluates the requested line once through `equalMassSupport` → `probabilityAt`.
A finite-numeric-support check refuses malformed materializations instead of
dropping values or manufacturing a forecast. This is an arithmetic backstop;
it does not inspect example game IDs, dates, eligibility, lineage or outcomes.
The existing kernel preserves duplicate mass, signed values, integer pushes,
half-lines and all-push results without smoothing. The result is sample count,
line and Over/Under/Push probabilities; history/support remains private.

`buildPredictionResponse` takes validated model/request pins, the forecast,
**Q2's final context**, and the boundary's `authorization` (Q1) and `delivery`
(Q2) receipts. It returns an available data object containing:

- Player/game and explicit run/descriptor identity, research/uncalibrated
  designation, supported versions/adapter and actual/dataset evidence modes.
- The requested line, sample count and probability triple.
- Exact selected feature identity/metadata, knowledge/cutoff/computed/checkpoint
  clocks, source snapshot IDs, selection reasons and final freshness flags.
- Both check receipts, including check clocks and profile/decision pairs.

Every container is owned and only named fields are copied. Microsecond clocks,
last-valid reasons, stale/superseded flags and retrospective
`historical-availability-unverified` pass through unchanged. No new clock is
read, selection/freshness/rights recomputed, or private descriptor/history/target
extra copied. The helper trusts the validated composition; it is not a second
authorization or consistency guard. #167 calls it only after Q2, then performs
serialization and its final cancellation/deadline/delivery gate. It adds session
disposition and maps failures to a bounded unavailable envelope with no partial
forecast. No standalone helper result permits delivery.

## Validation and CI work budgets

The focused in-memory tests cover actual publisher/Q1 shapes, one/two modes,
order independence, exact identity and every exposed pin/spec field, malformed
and unknown policies, same-run UUID spelling, context mismatches and mode
compatibility. Poisoned unused fields fail if history, labels, membership,
reports, transport-only claims or clocks are inspected. Hash/serialization spies
and frozen-input/output-mutation controls cover the Step 1 purity contract.
The fixtures are synthetic contract controls, not a new real-fixture benchmark.
The three focused files contain **145 passing cases**:
`prediction-helpers.test.ts`, `prediction-forecast.test.ts` and
`prediction-purity.test.ts`, all in the regular Node unit-test lane.

| Budget/contract | Deterministic proof |
| --- | --- |
| 0 SQL/authorization/ObjectStore/file/network work | Emitted runtime dependency graph allows only the named util/empirical functions; empirical is checked for no dependencies. Negative controls reject reader, evaluator, I/O, dynamic import and re-export paths. Helpers accept no client/store/callback. |
| 0 hash/serialization/delivery/clock work | Runtime throwing spies cover hash, JSON parse/stringify, fetch and clocks across all three helpers. Structural controls reject clocks, process/global access, timers, eval and randomness. |
| 0 per-example verification | At every n=2–16, a proxy permits only one `yards` access per row and throws on every other field. No target value, training membership or eligibility can affect arithmetic. |
| Shared math, fixed helper calls | Exactly one support construction and one probability evaluation at every n; hand-calculated triples, ties, half-lines, all-push and invalid/count/container controls. |
| Q2 semantics and field boundary | Q1/Q2 freshness differs; response uses supplied final flags and preserves exact microsecond clocks, reasons, lineage and both distinct receipts. Poisoned extras fail if read; two same-game QBs remain distinct with the same forecast for the same yards. |
| Ownership | Frozen inputs, repeat calls and mutation of every returned container prove no input mutation or output aliasing. |
| Private workspace API | Public and deep private package subpaths refuse resolution; normal import-boundary checks remain in place. |

Run the focused checks with Node 24:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts \
  services/pipeline/tests/feature-store/prediction-helpers.test.ts \
  services/pipeline/tests/feature-store/prediction-forecast.test.ts \
  services/pipeline/tests/feature-store/prediction-purity.test.ts
```

| #235 acceptance | Proof |
| --- | --- |
| Descriptor format/scope/version/identity/exposed pins | Step 1 mismatch matrix, order-independent one/two-mode sets and exact policy checks. |
| Feature mode compatibility without training eligibility | Strict-only retrospective refusal and both-mode acceptance; no membership/label reads. |
| Pure shared forecast over n=2–16 | Step 2 numeric/line/count matrix and deterministic kernel/yard-read budgets. |
| Response data preserving Q2 policy metadata | Exact passthrough, clocks/receipts, target poisoning and complete container-ownership tests. |
| Private API, no hidden work | Emitted import graph, negative controls, throwing spies and workspace resolution checks. |

#167 retains integrated SQL/rights/GET counts, races, LOGIN/deadline tests and the
final speed gate. No helper-only result qualifies the completed handler's latency;
CI contains no machine-speed assertions for this work.
