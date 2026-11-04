# Private prediction helpers (#235)

The owner approved the [roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/235#issuecomment-6622741080).
Step 1 supplies descriptor compatibility and the private value contract for
#167. Forecast arithmetic and response-data composition remain Step 2 work.

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
code supplies policy values assembled from existing constants. Step 2 will use
the existing public domain empirical kernel rather than duplicate arithmetic.

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
security boundary. Type-only local imports avoid reader initialization; runtime
Step 1 imports only `node:util` for structural equality.

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

JSON parse failures and mapping private errors to bounded unavailable responses
belong to #167. No partial response is constructed by this validator.

## Validation and remaining work

The focused in-memory tests cover actual publisher/Q1 shapes, one/two modes,
order independence, exact identity and every exposed pin/spec field, malformed
and unknown policies, same-run UUID spelling, context mismatches and mode
compatibility. Poisoned unused fields fail if history, labels, membership,
reports, transport-only claims or clocks are inspected. Hash/serialization spies
and frozen-input/output-mutation controls cover the Step 1 purity contract.
The fixtures are synthetic contract controls, not a new real-fixture benchmark.

Step 2 will add shared-kernel arithmetic for n=2–16, response data from Q2,
hand-calculated probability controls, target invariance, preserved clocks/flags/
receipts and final structural work/import/export checks. #167 retains integrated
SQL/rights/GET counts, races, LOGIN/deadline tests and the final speed gate.
No helper-only result qualifies the completed handler's latency.
