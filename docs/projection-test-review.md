# #54 Part A adherence QC

Reviewed 2026-10-13 against the repository's
[predictive test reasoning standard](predictive-test-review.md): independent
expectations, specific failure assertions, valid controls, selected fault
injection and explicit evidence limits. No separate named adherence-QC policy
was found in AGENTS.md or the repository docs.

| Contract | Independent evidence |
| --- | --- |
| Integer/signed distributions | Outcomes -2, 0, 2, 2 independently imply Over=.5, Under=.25, Push=.25 at zero and .5/.5/0 at .5. A 37-outcome integer sequence is checked by direct counting across 81 lines, including negative, fractional and support-extreme queries. |
| Push settlement | All-zero outcomes at zero imply all-push, undefined conditional/fair price and zero profit. .4/.4/.2 at decimal 2 is break-even; decimal 3 yields .4 unit profit for either side. |
| Availability | Each of feature, identity and label availability is tested at cutoff (accepted) and one millisecond later (specific refusal). Target/future games and at-event prediction cutoffs refuse. |
| Input refusal | Valid input is a positive control; empty history, invalid sample policy, missing version/identity, invalid timestamp, non-integer outcome, absent participation and version mismatch assert their precise reason. Duplicate and unresolved states also refuse. |
| Determinism/versions | Reversing history preserves the complete fitted artifact; version changes refuse mismatches. Recorded model identity, sample policy, support and training IDs remain explicit. |
| Scoring | Hand-calculated three-class Brier is .875 for the first push and .5 for the later Over. Their mean is .6875. Log loss is the mean of -ln(.25) and -ln(.5). A wrong certain forecast yields Brier=2 and infinite log loss. |
| Walk-forward/accounting | Two distinct cutoffs use independently supplied histories; a third unavailable case leaves scored count=2, unavailable=1 and does not dilute the metric. A uniform comparison has Brier=2/3 on its one matched case and retains its version/count. Calibration bins separately retain push frequencies 1 and 0. |
| Evaluation provenance | Label/event/time/version mismatches and unavailable labels refuse; corrected label IDs cannot evade duplicate event/line detection. Late comparisons refuse even for unavailable model cases. Per-case event, line and label manifests are retained. |
| Population | All three caller coverage partitions are preserved, including unresolved/excluded counts. Even a supplied synthetic ledger version leaves the report exploratory. No source or population qualification is inferred. |

The initial review found weak status-only assertions, no multiple-cutoff metric
oracle, missing grouped comparison metrics, incomplete evaluation manifests and
duplicate detection keyed by label revision. The strengthened checks and
implementation address these gaps before the first commit.

## Fault sensitivity

An isolated temporary copy first passed all 24 tests at that stage (25 after the final label/coverage check). Each of the following
single injected faults then caused a failed assertion (not startup/configuration
failure); the fault was restored before the next case:

- Remove equality mass from distribution queries.
- Change dependency availability `>` to `>=` at cutoff.
- Disable feature/label version comparison.
- Classify equality as Under in evaluation.
- Divide Brier by all cases, including unavailable cases.

All five were detected. Working-tree source was never mutated by this exercise.
This is selected fault sensitivity, not exhaustive mutation coverage.

## Limits and continuation

Synthetic caller-supplied envelopes establish library arithmetic and refusal
behavior only. They do not prove historical source truth, ledger completeness,
real-data performance, calibration or sufficiency. Nine markets share a naive
empirical reference; parametric candidates are documented but not implemented.
Caller history selection and cutoff-honest features still need the Part B adapter.
Unseen outcomes yield infinite log loss intentionally. The continuation exporter
uses a versioned envelope and the explicit string `positive-infinity`; its
independent test requires Brier=2, infinity in both case and aggregate metrics,
preserved counts, deterministic bytes and NaN refusal. There are now 26 tests. No database, hosted activation or product
integration was introduced. Part B remains blocked on real features/labels and
the batch/indexed/label/retention reader work documented in
[the baseline contract](projection-baseline.md).
