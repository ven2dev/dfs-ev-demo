# #138 scoring preregistration v1

Status: prepared for owner review; no evaluation has run. This document becomes
the preregistration only when the owner approves its commit. The first evaluation
records that commit SHA and this document's SHA-256. Later policy changes get a
new version and explicit deviation record, preventing selection after seeing scores.

## Design basis

- **Pattern:** preregistered chronological forecast evaluation with proper scoring
  rules; deterministic empirical distributions from a fixed history policy.
- **Alternatives:** historical prop lines cannot be reconstructed from outcome
  data; choosing thresholds after scoring invites selection bias. Random splits
  mix future information into historical fits. Smoothing or tuning on 2022–2025
  would change the approved baseline and consume the evaluation set.
- **Targets:** the #138 platform deadlines are unchanged: ingestion 60 s per
  file, season features 120 s, dataset 30 s, prediction 300 ms p95, each with
  30% headroom. Statistical metrics are measurements, not an accuracy pass bar
  or a claim that the baseline is calibrated.
- **Requirement reasons:** commit this policy before evaluation to prevent
  outcome-driven choices; preserve infinity to expose zero assigned probability;
  disclose cohort gaps to prevent selective coverage being presented as complete.
- **Assumptions:** local research only; 2021–2025 corrected public snapshots;
  observed QB participants are a narrower population than all future prop offers.

## Population, history and temporal policy

- Market: QB passing yards, regular season only. Candidate coverage starts with
  weekly-roster QB rows joined to the matching team's scheduled game; also record
  any observed QB stat row that fails that join. Do not choose only starters,
  positive-yard games or a minimum number of attempts.
- Score only a valid integer outcome with unambiguous GSIS identity, matching
  team/game and positive offensive-participation evidence. Zero attempts or zero
  yards can be valid; a missing stats row or missing player-on-offense evidence
  cannot be converted into zero. Retain excluded/unresolved candidate counts and
  reasons by season. Gaps do not block the spike or establish #54 completeness.
- History: the same QB's latest at most 16 eligible prior regular-season games,
  ordered by kickoff descending and deterministic game ID. Minimum usable sample
  count is 2. An unresolved history candidate remains in the coverage ledger;
  selecting eligible records does not erase that gap or claim complete history.
- Cutoff: target kickoff minus one hour. The target game and all games at or
  after the cutoff are excluded from history. Conflicting identity/order refuses
  the affected case rather than arbitrarily selecting a rival.
- 2021 is warm-up only. Score targets in 2022, 2023, 2024 and 2025 in chronological
  order. Each player-game fit is its own walk-forward fold; no target game enters
  that fold's training set. A previously evaluated game can become later history,
  with this reuse recorded; it is not independent replication.
- Label cutoff for this retrospective experiment is the pinned successful
  ingestion checkpoint. Labels use that checkpoint's latest valid historical
  stats. Record the actual snapshot publication/capture/ingestion times and
  correction state; they are not backdated to a historical game.
- Owner-approved mode: `retrospective-reconstruction-v1`, with
  `historical-availability-unverified` on every reconstructed example and report.
  Use today's corrected prior-game facts, not claims of captured pregame evidence.
  This can contain later corrections, revised schedules and postseason-published
  participation. It is an exploratory counterfactual, not a no-look-ahead proof.
- Keep `strict-point-in-time-v1` results separate: both provider availability and
  database knowledge must precede the feature cutoff. Missing historical snapshots
  produce unavailable results in that mode. Do not rewrite those clocks to make
  the retrospective dataset pass the strict mode or relabel reconstructed model
  input times as observed availability.

## Model and fixed threshold scores

Use the existing `empirical-integer-v1` distribution: equal mass on the selected
history outcomes, no smoothing, clipping, hyperparameter search or post-hoc
calibrator. This is the naive empirical-frequency baseline itself; do not claim
an independent naive comparator was beaten.

Fixed yard thresholds, selected before evaluation:

`199.5, 224.5, 249.5, 274.5, 299.5`

At each threshold, compute strict Over, Under and Push probabilities. Integer
yards imply zero Push mass at these half-yard thresholds. Report:

- `brier_three_class`: sum over Over/Under/Push of `(p - observed)^2`, range 0–2,
  matching the existing projection scorer.
- `brier_binary_over`: `(p_over - I[y > threshold])^2`, range 0–1. At these
  thresholds it equals half the three-class score; report the convention explicitly.
- `log_loss`: natural `-ln(p_observed)`. A zero probability is positive infinity;
  serialize it as `"positive-infinity"`. Report its case count/fraction. An
  aggregate containing any such case remains infinite, not a finite-only average.
- Calibration: fixed ten bins `[0,.1), ... [.9,1]` for Over and Under separately,
  with count, mean forecast and observed rate. Show empty bins with zero count and
  null rates. Report extreme-probability counts. No fitted calibration is applied.

For each threshold, average over available player-games, weighting each case
equally. Any combined threshold summary is the equal-weight mean of the five
threshold means. Report distinct player-game count separately from the fivefold
threshold-case count. Unavailable cases never silently disappear from denominators.

## Whole-distribution score

Report the **unnormalized integer ranked probability score**, once per available
player-game, using the complete discrete yard distribution:

`RPS(F,y) = sum over integer k of (F(k) - I[y <= k])^2`.

Summands are zero outside the interval spanned by forecast support and observed y.
Implement without an arbitrary yard cap, negative-yard truncation or division by a
data-selected category count. Equivalent empirical formula, for n history values:

`mean_i |x_i - y| - (1 / (2*n*n)) * sum_i sum_j |x_i - x_j|`.

This is the integer-distribution form of CRPS, with one-yard spacing, and lower
is better. Check both formulas against small hand-calculated fixtures before
real evaluation. It is not an average over only the five prop thresholds.
Scoring basis: [Gneiting and Raftery (2007)](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf).

## Reporting and comparison policy

Every metric, calibration table and comparison gets prior-sample strata **2–4,
5–8, 9–16**, both pooled and per evaluation season. Show empty strata and their
counts. Histories with 0–1 usable games are unavailable; unresolved populations
are reported separately rather than forced into a scored stratum.

Report input cohort, usable labels, available forecasts, exclusions, unresolved
cases, their reasons, zero-opportunity outcomes, distinct players/games and
superseded-input flags. Keep the reconstructed and genuine point-in-time evidence
bases separate throughout. If a flagged-value policy affects training, record it
in the dataset identity; the owner policy retains the last valid permitted value
with its flag. Mandatory deletion overrides retention of affected data.

Market-line evaluation is a separately identified supplemental report only for
genuine captured player-prop lines available at the prediction cutoff. Record
the capture identity/time and price conventions. Without compatible genuine
market probabilities, market comparison is `unavailable`, with a reason. Game
spreads/totals or today's prices are not historical player-prop lines. Do not
search for new thresholds or tune a model in response to this spike's metrics.

No statistical win, ROI or calibrated-product claim is an acceptance criterion
for this infrastructure spike. An infinite log loss is an expected possible
finding for this unsmoothed model; a performance deadline miss remains a failure.
