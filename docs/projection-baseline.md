# #54 Part A: pure projection and evaluation library

`src/lib/projection/baseline.ts` provides `empirical-integer-v1`, a deliberately
simple frequency baseline for the nine registry markets. It estimates a discrete
stat distribution from explicitly supplied prior offensive-participant outcomes;
the query line is applied afterward. It consumes no database, creator, odds,
game spread/total/moneyline, weather penalty or opponent coefficient. The existing
`computeEV` product heuristic remains interim and is not integrated with this library.

The narrow input consists of market, target event/time, cutoff, pinned feature and
label versions, a caller-selected minimum sample count (at least two), and one
versioned observation per historical event. There is no automatic last-N selection,
missing-game fallback, correction selection or source qualification. Callers must
select a complete, compatible player/season-type population and resolve revisions
before supplying it. The adapter to #52 is Part B. Every supplied dependency must
be available by the prediction cutoff; target and future events, duplicates,
unresolved participation, invalid outcomes and version mismatches fail closed.
No input is silently dropped. Zero requires explicit offensive participation.
These envelopes describe evidence; they do not verify source authenticity.

## Candidate rationale

| Family | Implemented research reference | Later candidates requiring evidence |
| --- | --- | --- |
| Signed passing/rushing/receiving yards | Integer empirical frequency, preserves negative values and exact equality | Discretized location/scale or volume/efficiency mixture; compare tails and role shifts |
| Attempts, carries, receptions, completions | Nonnegative integer empirical frequency, includes verified zero games | Poisson/negative binomial for volume; conditional binomial/beta-binomial for successes with verified denominators |
| Passing TDs and interceptions | Nonnegative integer empirical frequency | Exposure-aware Poisson/negative binomial and pooled rare-event rates |

Only the empirical reference is implemented and no candidate is selected as a
validated product model. Small samples and unseen support can produce extreme
probabilities: zero observed TDs are not evidence of a true zero TD probability.
The sample threshold is a recorded caller policy, not a statistical sufficiency
claim. All results remain exploratory, with sample counts and exact training IDs.
Parametric smoothing, uncertainty intervals, enriched feature regression and
model selection await Part B evidence rather than arbitrary coefficients.

## Probability, pricing and scoring

`probabilityAt` partitions mass into strict Over, strict Under and equality Push.
Non-integer lines have no equality mass. Unavailable models return null.
`priceSide` assumes a unit stake with equality refunded: profit expectation is
`P(win) * (decimalPrice - 1) - P(loss)`, and break-even decimal price is
`(P(win) + P(loss)) / P(win)`. No finite fair price is returned for zero win mass.
Conditional no-push probability is separately named and null when all mass pushes.
DNP, inactive, unresolved, unplayed and book-specific void rules are outside this
numeric-outcome contract; they must not become equality or losses.

`evaluate` refits for each event cutoff, pins evaluation labels available by its
separate evaluation time, and retains each model/support/training manifest.
Reports include code artifact identity, cutoff, versions, sample counts, per-market
three-class Brier (sum over classes, range 0–2), natural-log loss and ten calibration
bins per class. Impossible observed outcomes have infinite log loss; no clipping
conceals unsupported tails. Nonfinite metrics require an explicit encoding when
serializing to JSON (native JSON would silently turn Infinity into null).
Optional versioned comparison triples are scored separately and must be available
by the prediction cutoff. Two-way market odds must not be relabeled as three-way
unconditional probabilities without a documented push model. The empirical model
itself is the naive frequency reference. No market consensus trains the model.

Coverage has separate training, evaluation and feature-history covered/excluded/
unresolved counts and a ledger version; these are caller reports, not verified
population proofs. Even complete supplied counts cannot promote Part A to strict
validation. External feature-history version verification and qualified complete
population evidence are still required. Caller-selected histories/windows and
artifact identities must be retained durably by the future run recorder.

## Part B blocking ticket scope

Before training real features, the #52 follow-up must deliver usable real QB feature
bundles and applicable labels, plus qualified completion, identity and offensive
participation evidence including zero-opportunity participants. The current real-file
proof has zero usable feature/label records and cannot train this model.

The ticket blocking Part B must also deliver a bounded batch reader; indexed lookup
by player, game and cutoff; current-label reads with correction/version semantics;
a consistent cutoff snapshot across dependencies; and audited retention/pinning
that holds training features, labels and their evidence beyond the 90-day expiry.
Measure query counts, runtime and plans on realistic batches: roughly ten queries
per row plus re-verification is not a training API. Preserve rights and current
access checks when caching verification or retaining evidence. No database or
external ticket mutation is included in Part A.
