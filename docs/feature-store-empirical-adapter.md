# #163 empirical adapter — approved design and implementation roadmap

Owner-approved roadmap: [issue #163](https://github.com/ven2dev/dfs-ev-demo/issues/163#issuecomment-6250059648).
Implementation branch: `feature/dfsEV-163-empirical-adapter`, created in a separate
worktree from fresh `origin/main` at `20b712c7ec2a9a4e8cd3bbb5d780f5f4f559ac21`.
The owner approved starting the issue iteration. No adapter latency pass is claimed.

## Design basis

- **Pattern:** a pure equal-mass empirical-distribution kernel plus a versioned,
  research-only input adapter over trusted materialized QB passing-yards features.
  This remains an uncalibrated interim hit-rate model; it supplies no calibrated
  baseline, predictive-projection or population-completeness claim.
- **Alternatives rejected:** reconstructing raw evidence per prediction repeats
  ingestion work and risks the latency/work budgets; inventing availability
  timestamps to fit the strict wrapper falsely claims historical knowledge.
- **Layer placement:** the kernel goes in `src/lib/projection/empirical.ts`, ready
  for the future `packages/domain` move under #148. The database/rights adapter
  goes in `src/lib/featureStore/empiricalAdapter.ts`, on the server/pipeline side.
  No workspace migration belongs to #163. **The kernel imports nothing from
  Next.js, the database or server-only modules; a dependency-boundary test enforces
  this. The adapter depends on the kernel, never the reverse.** No deviation.
- **Targets:** p95 <=210 ms for both warm and cold request paths, against the
  unchanged 300 ms deadline; exactly three SQL statements and two batched current
  rights/status checks per successful request; zero raw-evidence or per-row
  validation reads. Prototype before expanding the implementation.
- **Assumptions:** trusted pipeline/database owner; a restricted local research
  reader; immutable, versioned features; season-scoped snapshot lineage; actual
  knowledge clocks; no hosted writes or production-readiness claim.

## Contract and requirement reasons

- Every success/refusal variant identifies `rightsScope: 'research'` and the
  adapter identity, so research authorization cannot be mistaken for serving
  clearance. Successful outputs identify the uncalibrated interim hit-rate model,
  sample size, feature/history-policy/evidence-mode versions, feature identity,
  actual selection/knowledge clocks, source lineage and freshness flags. Future
  serving integrations re-authorize their serving use at request and delivery.
- Keep the legacy fitter's validation order, numeric results, output shape and
  temporal refusals unchanged to protect its existing callers. Its existing
  histories longer than 16 remain supported; only the new adapter is capped.
- The new adapter accepts the existing policy's 2–16 eligible prior REG games.
  Two excludes the degenerate one-observation case, not statistical unreliability;
  the output remains explicitly noisy/uncalibrated. Sixteen preserves the approved
  recency and bounded-work policy; it is not an optimized window. Neither limit is
  retuned here, to avoid silently changing the registered experiment.
- Consume an exact pinned feature identity and explicit knowledge-as-of selection;
  preserve the feature's pregame cutoff and real timestamps, and carry
  `historical-availability-unverified` plus stale/superseded flags. Unknown
  versions, insufficient history, the target event, equal-cutoff and future events
  fail closed to prevent policy drift and event-time leakage. Earlier games'
  passing yards are outcomes already materialized as lagged feature history.
  The adapter reads that history from `feature_values`, not from the label table.
  It never reads the outcome label for the game being predicted.
- Use three short statements: (1) resolve pinned metadata/lineage and authorize
  research rights/current status; (2) read the authorized materialized history;
  (3) recheck that same feature/lineage and current rights before delivery. Compute
  in memory and withhold the response until the recheck passes, refusing deletion
  or revocation visible to that query. **Accepted limit:** changes committed after
  the third query's snapshot and before bytes leave the process cannot be
  guaranteed to be observed. This is check-and-recheck, not an atomic-delivery or
  in-flight-revocation guarantee. No reader locks, cache or per-record
  reconstruction is introduced to close that remaining window.

## Atomic delivery steps and acceptance mapping

1. **Extract the single math implementation with legacy parity — 30–45 minutes.**
   Move support construction and probability/pricing arithmetic currently inside
   `fitBaseline`, `probabilityAt` and `priceSide` in `baseline.ts` into `empirical.ts`.
   Keep strict qualification and compatible public exports in `baseline.ts`, which
   delegates to that kernel. Preserve the arithmetic operation order and leave
   one implementation of each calculation, including in the prototype. Enforce
   the domain import boundary and test signed/zero values, equal masses, ties,
   integer Push, half-yard Push=0 and the legacy >16 case, plus existing temporal/
   validation refusals. This small mechanical extraction is the prerequisite to
   the cheap proof; adapter expansion remains gated on that proof. Meets AC1/AC2.
2. **Cheap request-path spike before adapter expansion — 45–60 minutes.** Reproduce
   the #138 fixture from its 16 pinned objects using the local ObjectStore and disposable PostgreSQL;
   setup stays outside measurement. Prototype the exact three-query boundary over
   materialized features with restricted connections. Measure both modes and actual
   query counts. A target miss stops expansion and returns evidence to the owner;
   it does not trigger a looser budget. Meets the early-proof part of AC4.
3. **Finalize the versioned research adapter — 45–60 minutes.** Complete the
   pinned-input/output contract, explicit versions, rights scope, actual clocks,
   sample-size and retrospective/freshness disclosures. Cover n<2, n>16, malformed
   or unknown versions, target/equal-cutoff/future games and current-state refusal.
   Earlier games' outcomes come only from materialized lagged feature history;
   the adapter reads neither `outcome_labels` nor the target game's label. Meets AC2/AC3.
4. **Integrated probes, final evidence and review handoff — 45–60 minutes.** Test
   rights revocation and source deletion between queries, missing/pruned features,
   flags and clock boundaries. Prove the adapter works when its reader has no
   `fs138.outcome_labels` or normalized/raw-evidence read permission: earlier-game
   values remain readable through their materialized feature row. Measure constant
   work at 2, 8 and 16 history slots. Repeat the final hot-path matrix, record every miss, run focused
   kernel/legacy/adapter and affected PostgreSQL checks, typecheck and lint. Commit
   compact receipts after owner approval and hand off for owner-run Codex review.
   Meets AC1–AC4. No repeated full database gate after each small edit.

Planning range: approximately 3–4 hours including discovery, focused validation,
receipts and documentation; owner waiting time is excluded. If projected total
exceeds five hours, split the remaining scope and stop before taking it on.

## Measurement contract

- **Warm gate:** existing restricted connection; authorization through response
  serialization. **Cold gate:** inside an already-running process, start before
  opening a fresh restricted connection and finish after response serialization.
  Both gate at p95 <=210 ms; unexpected refusals/deadline failures remain failures.
- **Measured separately, not gated:** fresh Node/module startup and the full
  parent-observed startup-to-response total. Report connection setup, each of the
  three queries, calculation and serialization separately, plus request total.
- Alternate cold and warm cohorts across three rounds, at least 100 requests per
  mode per round. Report sample counts, nearest-rank p50/p95, maxima and misses for
  each round and the combined modes; each round meets the same p95 gate. Use
  deterministic cases spanning 2022–2025 and sample sizes 2–4, 5–8 and 9–16.
  Absolute gates use alternating cohorts; ABBA is only for a subsequent explicit
  optimization comparison and requires the same pinned fixture/boundary.
- No raw-file, per-row evidence or application-result cache on the measured path.
  Disclose unflushed OS/PostgreSQL caches. Local runs do not establish Vercel
  function boot or Neon compute-wake latency; neither is simulated or cleared by
  this proof. #168 remains the broader prediction-capacity deliverable.
- Compact receipts retain source/code/query/fixture hashes, runtime, fixture counts,
  boundaries/cache state, per-stage distributions, deterministic work counts,
  failures and per-target verdicts. Full logs stay off main; useful archived logs
  may receive an owner-approved evidence tag. Persisted artifacts use ObjectStore.

## Approval and scope boundaries

The owner approved this roadmap with the four incorporated amendments; this
issue comment is the durable roadmap record. The owner has approved the branch and starting implementation from fresh main.
Keep every other worktree/branch untouched to avoid modifying reference work.
Each atomic step is verified and summarized for owner approval before its commit.
The owner runs Codex review; each push needs fresh consent; the owner merges.

SQL changes stay in `db/proposals/` for later movement to `packages/db`. No frozen
migrations, retired #106/#118/#127 implementation, hosted writes, Production,
GCS, product route/UI, deployment, model registry or #164 evaluation is included.
Do not add attribution trailers. No initial capacity pass is claimed by this plan.

## Step 1 checkpoint

The shared arithmetic is implemented in `projection/empirical.ts`, with no module
dependencies. `baseline.ts` retains strict qualification and its existing public
API, delegates support/probabilities, and re-exports the same pricing/validation
functions. The model version, complete legacy output envelope and histories over
16 games are unchanged. The new adapter's narrower policy is not imposed here.

All 33 projection tests, typecheck and changed-file lint passed. A supplemental
comparison against the original main module matched 12,287 exact results/refusals;
committed regression tests cover hand-calculated values, arithmetic order,
temporal/refusal precedence, the 37-game case and the domain import boundary.
See the [compact receipt](evidence/feature-store-163/step-1-kernel.json).
This step makes no adapter latency, SQL-budget or database-permission claim.
Step 1 is ready for the owner's commit approval; the request-path spike follows.
