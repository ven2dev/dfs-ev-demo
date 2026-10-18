# #138 step 6 proposal: empirical evaluation and local predictions

Status: **Superseded as a single issue by the owner-approved scope split.**
See [the successor issues and foundation boundary](feature-store-foundation-scope.md).
This document is background only; it authorizes no implementation. Step 5 was
owner-reviewed and committed locally as `420710f`. At proposal time nothing had been pushed.
This document preserves the original proposal for the separately scoped issues. No step-6 code, proposal SQL,
model fitting, statistical evaluation or prediction benchmark has run.

## Design basis

**Pattern:** offline chronological forecast evaluation over an immutable,
version-pinned feature/label dataset, with a shared pure empirical-distribution
kernel and a small, read-only prediction path over materialized features.
Pipeline jobs publish immutable model/report artifacts through ObjectStore;
current rights and deletion status are checked at delivery boundaries.
This follows the approved feature-store design without rebuilding evidence at
read time. A model run records the evaluation cohort and policy; the empirical
baseline fits each player's own prior history independently, with no globally
learned parameters.

**Alternatives:**

1. Retrain or reconstruct raw evidence for each prediction: repeats ingestion
   validation, expands latency and revives the retired #118 design.
2. Reuse the strict legacy fitter by inventing historical availability clocks:
   creates a false point-in-time claim. Its strict behavior stays intact.
3. Add smoothing, tuning, another model or a fitted calibrator: changes the
   preregistered baseline and uses the evaluation cohort to choose the model.
4. Introduce an online feature server or new hosted service: unnecessary for
   this bounded local spike; the existing PostgreSQL/ObjectStore boundary is
   sufficient to test the approved design.

**Targets and fixture:** rebuild the pristine step-3 input set (16 exact wire
files), then reproduce the step-5 cohort of 2,504 usable 2022–2025 player-games.
2021 is warm-up only. Compare its natural-key/value hash with the step-5 receipt
(`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`);
new database IDs mean exact-file hashes may differ. The step-5 deletion fixture
was disposable; its reduced 1,871-row result is not the evaluation cohort.

Prediction target: p95 <=210 ms, preserving 30% headroom against 300 ms. Use
three cold and three warm trials, at least 100 successful requests per trial,
retaining individual durations and all refusals/failures. Proposed deterministic
prediction budget: one indexed context lookup plus two batched rights/status
queries, three SQL statements total, independent of history size (2–16).
No normalized/raw-source reads or per-history-row verification calls.

Dataset, ingestion and feature-job limits remain <=21 s, <=42 s and <=84 s
respectively. Step 6 does not claim to complete the pending repeated network
and revised feature-job matrices; step 7 owns the aggregate target matrix.
Statistical scores have no accuracy pass threshold: poor scores and infinite
log loss are findings, not reasons to tune the baseline or drop examples.

**Requirement reasons:** retain the committed scoring policy to prevent
outcome-driven metric choices; exclude the target and all post-cutoff games to
prevent event-time leakage; keep real knowledge clocks and evidence-mode flags
to avoid presenting reconstruction as captured historical availability; check
rights/status before access and delivery because they can change during work;
keep new derived writes pipeline-only to prevent forged model/report records;
use ObjectStore for artifacts so storage and mandatory deletion stay portable.

**Assumptions:** local research, trusted pipeline/database owner, read-only app
role, bounded 16-game histories, original immutable files retained locally.
No genuine historical player-prop lines have been qualified. This is a data-layer
spike, with no product UI, hosted deployment or accuracy/product-readiness claim.

## Premise checks before coding

Two existing interfaces need explicit adapters rather than fabricated inputs:

- `src/lib/projection/baseline.ts::fitBaseline` requires feature, identity and
  label availability before the prediction cutoff. The approved retrospective
  mode cannot meet that requirement using files published later. Extract/share
  only the pure equal-mass distribution calculation, keeping all existing
  strict validation behavior. A versioned materialized-feature adapter consumes
  job-produced histories and carries the real cutoff, checkpoint, versions and
  `historical-availability-unverified` flag. The empirical algorithm remains
  `empirical-integer-v1`; evidence mode and adapter version are part of run identity.
- The existing evaluation helper identifies cases by market/game/line, without
  player identity. Two QBs can share a game. The spike's orchestration keys folds
  by player/game and policy, and threshold cases by player/game/threshold; it
  reuses pure probability/scoring functions without inventing game IDs or
  silently changing the existing evaluator's contract.

These adapter choices are part of this proposal and require owner review.

## Implementation sequence and stop points

### 6A. Share pure math and prove the prediction hot path cheaply

Extract/share the existing unsmoothed empirical mass calculation without
changing the strict wrapper's results or refusal behavior. Add the explicit
materialized-feature adapter and hand-calculated metric fixtures. First run a
small local hot-path prototype on the real cohort's smallest/largest histories,
using the existing feature index and restricted reader login. Include context
lookup, both rights/status checks, tiny model-artifact access and serialization.
No final registry/DDL is committed or frozen before this cheap proof passes.

If the prototype misses its budget/latency target, retain the evidence and
report the finding before expanding the implementation. Do not raise the limit.

### 6B. Execute the preregistered chronological evaluation

Rebuild the pristine cohort and pin dataset ID, exact-file/content hashes,
feature/label/history versions, actual selection clocks, code identity and the
preregistration commit (`6aa7953`) plus its document hash before scoring.

For each player-game, fit only its 2–16 eligible prior games and then score its
separate target label. Order folds by target event time with deterministic
player/game tie-breaking. Record when previously evaluated games enter a later
history; overlapping histories are reuse, not independent replication.

Compute exactly the committed preregistration:

- Thresholds 199.5, 224.5, 249.5, 274.5 and 299.5; Over/Under/Push probabilities.
- Three-class Brier, binary Over Brier and natural log loss. Preserve any
  positive infinity as `"positive-infinity"`, including aggregate means, and
  report the count/fraction; no finite-only averages or clipping.
- Whole-distribution integer RPS, with no arbitrary yard cap or negative-yard
  truncation; prove agreement between the CDF sum and pairwise empirical formula
  on small exact fixtures.
- Fixed ten-bin Over/Under calibration, extreme-probability counts and empty bins.
- Every metric/calibration view pooled and by season, stratified into n=2–4,
  5–8 and 9–16, including empty cells, denominators, exclusions and flags.

Count distinct player-games separately from the five threshold cases. The
existing empirical model is the naive baseline; do not claim an independent
comparator was beaten. Market-line comparison is explicitly unavailable unless
genuine cutoff-compatible captured lines are qualified. Keep strict historical
results separate, including a zero-usable result if that remains the evidence.

### 6C. Publish and govern the local run/report artifacts

Use a minimal pipeline-written model-run manifest linked to its pinned dataset,
with database knowledge time, algorithm/policy/code identity, ObjectStore
addresses and hashes. Put any SQL in `db/proposals/138_baseline.sql` only. Store
the model descriptor and detailed report through ObjectStore; publish references
with step 5's upload-first, address-lock and HEAD-check protocol.

Extend existing rights/deletion handling to model/report dependencies and
`models/` / `audits/` addresses. Deleting a cited source/dataset invalidates the
run/report immediately and queues bytes for the same configurable grace; the
last-valid policy cannot resurrect deleted evidence. Preserve accepted
season-scoped conservative invalidation. Avoid a second row-level evidence graph.

The local prediction handler accepts identifiers, requested line and version/
evidence-mode policy, then reads the materialized history and model descriptor.
It does not accept caller-computed derived values or use the target label to
predict. Return sample count, probabilities, feature/model identity, cutoff,
mode and stale/superseded flags, or an explicit unavailable reason. No request
writes to the database and no public Next.js route/UI is added in this step.

Use one batched authorization and one batched pre-delivery check over the full
read/compute operation; do not add checks per row or wrap an already-completed
two-check reader with another unnoticed pair. Ordinary reads trust producer
validation, with current state rechecked and no reader table locks.

### 6D. Run correctness probes, repeated latency trials and report

Required probes:

1. Existing strict fitter retains temporal refusals and numerical results;
   retrospective adaptation never backdates availability or loses its warning.
2. Target/equal-cutoff/future events are refused in both modes; changing the
   target label cannot change its prediction.
3. Two QBs in the same game remain distinct; duplicate player-game folds and
   duplicate history games are refused; n<2 remains unavailable.
4. Exact hand fixtures cover negative/zero outcomes, ties, Push at integer lines,
   half-yard Push=0, RPS formula parity, score conventions and infinity encoding.
5. Strata/bin boundaries, empty cells, denominator accounting and walk-forward
   reuse counts reconcile with the immutable cohort.
6. Non-pipeline publication is refused; run clocks are DB-stamped; publication
   rollback and upload/cleanup races leave no dangling references.
7. Rights revocation/deletion during artifact access or calculation withholds
   delivery. Corrections preserve permitted last-valid values with flags.
   Mandatory deletion reaches model/report artifacts and resumes after a crash.
8. Repeated scoring from identical logical inputs produces the same logical
   result hash; artifact IDs/recorded times are tracked separately.

Preselect the request mix deterministically across evaluation seasons and the
three sample-size strata, with the selection hash recorded before timing.
For cold trials, each measured request uses a new process/connection with no
application cache, and includes startup through serialized response. Warm trials
reuse a process/connection but still perform fresh lookups and both state checks.
Alternate three cold/warm trials; compute p95 with a documented fixed quantile
rule. A refusal is recorded and cannot count as a successful prediction.
OS/DB cache state is disclosed. ABBA is needed only for an actual optimization
comparison; none is claimed by the absolute-target matrix.

Retain machine/runtime/DB versions, source/code/policy hashes, per-request times,
measured SQL/rights/source-read counts and per-target verdicts in compact receipts.
Detailed outputs go through the local ObjectStore/private evidence storage;
commit no megabyte-scale report JSON. Run focused unit/projection tests for math,
affected PostgreSQL permission/retention cases for new SQL, then one combined
step-6 integration check. Repeat a green check only for a relevant change/failure.

Stop for owner review with metrics, coverage, all misses and remaining targets.
No automatic step-6 commit or push is authorized by this plan.

## Explicitly deferred / gated

- GCS remains a later, owner-gated live test. Carry forward custom `sha256`
  metadata, size+hash comparison on HEAD and `ifGenerationMatch=0` for atomic
  create-only writes. Blaze, budget and a dedicated pipeline service account
  precede that test; the app's Firebase admin key is never used.
- No migrations, hosted writes, Production commands, public UI or deployment.
- Repeated network ingestion/revised feature benchmarks, scheduled recompute
  audits, external license/configuration confirmations and final main integration
  remain visible later acceptance gates. Step 6 alone does not close #138 or
  establish #54 population/training readiness.
