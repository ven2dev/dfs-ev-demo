# #118 reserved forward SQL drafts

These files are outside the ordered migration chain. #106 owns 0021 and has
not frozen it. #118 owns 0022–0024, but must first integrate the published frozen
0021 checkpoint and preserve every frozen earlier SQL/catalog artifact.

| Reserved slot | Draft | Purpose |
| --- | --- | --- |
| 0022 | `0022_predictive_training_liveness.sql` | Actual-consumer deletion cleanup; shared advisory lock before table locks; central guard/memo relation inventory |
| 0023 | `0023_predictive_training_indexed_closure.sql` | Indexed dependency traversal and kickoff lookup indexes, preserving historical closure |
| 0024 | `0024_predictive_training_readable_contracts.sql` | Static effective function definitions and memo initialization from the central inventory |

The focused cases in `tests/db/sourceClaims.test.ts` apply these drafts only to
disposable databases after frozen prefix20. They check behavior and rollback,
not an ordered catalog upgrade. They deliberately detect effective-body drift;
0021 may require changes before these proposals are promoted. In particular,
new validation context tables and edges must be represented in both the guard
and memo dependencies where appropriate.

The opt-in capacity benchmark accepts `PREDICTIVE_CAPACITY_REVIEW_DRAFTS=1` to
apply these exact files to its own scratch database and emits their separate
SHA-256 hashes. `PREDICTIVE_CAPACITY_REQUIRE_COMPLETE=1` fails on any measured
refusal; collecting bounded refusals is not a capacity pass. This does not alter
application deadlines or qualify any real sources.

See [the review-fix record](../../docs/predictive-training-review-fixes.md) for
remaining integration, capacity, independent-review and merge gates. These
drafts must not be applied to development, hosted or Production databases.
