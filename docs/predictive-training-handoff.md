# #106 / #118 feature and label handoff proposal

Status: **contract agreed by the owner on 2026-10-13 at reviewed proposal
`b7db281`; #118 implementation authorized**. #106 retains existing v1's
multi-season policy: one QB/game proof, target-relative three-season schedule
coverage and at most 16 numerical history slots. The 2026-only proposal is
withdrawn.
Prepared 2026-10-13 from merged-main `716d7559f6b3d402b098810efa5e6646f99e6709`
(PR #105). Relay owns [#118](https://github.com/ven2dev/dfs-ev-demo/issues/118);
the real-slice session owns [#106](https://github.com/ven2dev/dfs-ev-demo/issues/106).
This document specifies the agreed contract, not a claim that its entire API is
implemented or real data is qualified. Both branches start from merged main.
Relay branch: `feature/dfsEV-118-training-reads-retention`. This checkpoint
initially published this contract without runtime/schema changes. Implementation
progress and remaining gates are recorded below.

## Shared boundary

The initial reader supports **QB `player_pass_yds` only**, with stat
`passing_yards` and label version `source-final-label-v1`. Feature support is
defined by the explicit candidate/version/history matrix below, not by accepting
any passing-yards version string.
It consumes the verified source-consumer ledger introduced by 0010. There is no
fallback to ordinary feature/label tables. #114 gates additional markets; an
unsupported market/version refuses explicitly rather than sharing label keys.

#106 supplies evidence-backed source consumers and its selected QB/event/history/
opponent scope. #118 selects, verifies, batches and retains their exact versions.
Neither changes the other's statistical, completion or participation policy to
make an example usable. The existing absence policy remains: a confirmed missed
game occupies its history slot with a quality flag; unknown evidence withholds;
absence never becomes a numeric zero. A zero outcome requires affirmative,
market-compatible offensive participation and qualified finalization.

#107 supplies population qualification. Until it exists, all datasets retain an
explicit **population-unqualified / exploratory** disposition, including a
successful single QB proof. #118 does not create qualified participants by
enumerating whichever rows happen to have labels. #54 Part B must independently
apply the population and historical-version gates before validated training.

## History policy and version compatibility

**#106's approved history scope uses existing v1.** Neither session may silently
change it to make a slice usable. The history-policy identifier below names the
existing producer's fixed rules; it does not rewrite legacy recorded bodies.

The existing three-season policy remains the default reader contract. A 2026-only
option would bound one engineering proof, not the project's collection or
evaluation horizon. The registered creator corpus remains **2024 Week 1 through
2026 Week 4** ([corpus contract](creator-corpus-persistence-contract.md)); creator
transcripts are separate from NFL numerical feature history. A candidate limited
to 2026 targets cannot cover the older creator picks in a historical comparison.
Cross-season evaluation needs a compatible policy and qualified historical NFL
evidence for each target; collecting older final statistics now does not establish
their availability at a past cutoff. The owner's request for broader creator
context led to withdrawal of the 2026-only option.

| Candidate | Feature version | History policy | Compatibility / activation |
| --- | --- | --- | --- |
| `stats-v1:player_pass_yds` | `passing-yards-source-v1` | `qb-passing-history-three-season-v1` | Existing producer; player history only, without team/opponent summaries |
| `player-opponent-v1:player_pass_yds` | `passing-yards-source-v1` | `qb-passing-history-three-season-v1` | Existing producer; player, team and opposing-offense histories plus scheduled rest; current compatible choice for the enriched #106 proof |
| `player-opponent-2026-v1:player_pass_yds` | `passing-yards-source-2026-v1` | `qb-passing-history-2026-v1` | **Withdrawn and unsupported**; no producer/reader activation is authorized |

The two existing candidates share these implemented history rules:

- Independently evidenced schedule coverage spans the target season and its two
  preceding seasons for relevant teams, including known former teams; coverage
  does not assert that three full seasons of player statistics are required.
- Numerical history uses the latest at most 16 expected games before the feature
  cutoff, matching the target's REG/POST season type, with 4/8/16 summaries. An
  available shorter history is flagged; missing evidence cannot shrink the
  expected chronology or silently move a window backwards.
- Player slots preserve the approved absence policy. Enriched team and opponent
  windows use their own expected games; opponent values are the offenses that
  faced that opponent. Scheduled rest crosses REG/POST boundaries and uses the
  prior scheduled team game under the existing intervening-game rules.

These rules follow [scheduleContext.ts](../src/lib/predictive/scheduleContext.ts)
and [passingYards.ts](../src/lib/predictive/passingYards.ts) at base `716d755`.
The coverage range is target-relative: a 2024 target requires 2022–2024 coverage,
whereas a 2026 target requires 2024–2026 coverage.
For legacy v1 records, #118 derives the history-policy identity from the verified
candidate/feature pair and this fixed definition; it does not invent a field in
or rewrite the recorded body.

The withdrawn 2026-only policy is not an alternative selection or fallback. Any
future history-policy change requires a new agreement and separately versioned
producer, database recording, verification and historical replay support. #106
will inventory prior-season source qualification and enforce its file-size limit
under the existing policy.

Feature selection and the sealed dataset identity include **candidate, feature
version, history-policy ID/version and definition digest**, plus resolved season
bounds and window sizes per slot. Exact consumer IDs must match these fields as
strictly as latest-match selection. No v1 body may be relabeled 2026-only, and a
2026 body cannot satisfy a v1 request. A dataset has one fixed combination;
comparisons across policies use separately identified datasets/runs. The selected
policy, its approval reference and evidence-basis disposition remain visible to
#54, including `population-unqualified` where applicable.

The proposed reader activates only allowlisted combinations whose producer,
database recording, verification and historical replay paths support that exact
contract. Unknown or inactive candidates, feature versions, policy hashes or
combinations refuse explicitly, even when no matching record exists. Label version
`source-final-label-v1` is independent of feature history and remains compatible
with the supported candidates only when its own identity/finality/rights checks pass.

## Objects exchanged by #106 and #118

#106 records ordinary identity/schedule/completion evidence and the source
bindings/decisions using the existing verified publication paths. It then records
features with `recordSourcePassingYards` and final labels with
`recordSourceFinalLabel`, rather than sending #118 unverified JSON or CSV values.

For each requested player/event slot, the handoff names:

| Field | Meaning |
| --- | --- |
| Slot identity | Fitting-run/fold reference, canonical GSIS player ID, canonical game ID, season/season type, kickoff version, market and training/evaluation partition |
| Pregame feature request | Exact candidate/feature/history-policy combination, definition digest, profile IDs, prediction cutoff, resolved season bounds and windows; enriched first-real-slice proof uses opponent context |
| Feature reference | Source-consumer ID, input digest, body hash, artifact recording time and feature version, or an explicit missing/unavailable disposition |
| Label reference | Source-consumer ID, predecessor/head identity, input digest, body hash, recording time and label version, or explicit finalization/participation missingness |
| Evidence provenance | Exact binding/revision/capture references, raw player bridge, reconciliation/participation/completion decisions and rights decisions already cited by the consumer |
| Qualification | Synthetic/real provenance, prospective/historically verified/reconstructed evidence basis, and population qualification reference/status |

Existing `SourceConsumerRecord`, `SourceFeatureBody`, `SourceFinalLabelBody` and
their manifests are the canonical payloads. #118 wraps them with selection and
access metadata; it does not invent another numerical feature or label ledger.
All requested slots, including missing features or labels, stay in the manifest.
An expected-population manifest from #107 may later supply this enumeration.
Caller-supplied enumeration must retain its origin and cannot claim completeness.

## Time and label selection

The interface keeps the following clocks distinct and records each one:

| Clock | Enforcement |
| --- | --- |
| `featureCutoff` per example | Pregame, strictly before that target's eligible kickoff; replay enforces the existing source availability, receipt and decision rules at this cutoff |
| `labelsAsOf` for training | Latest information the fitting run may use, at or before its fit cutoff; label recording and all relevant evidence must be eligible at this time |
| `labelsAsOf` for evaluation | Separate scoring cutoff; may follow the event, but evaluation labels cannot enter model inputs or training history |
| Dataset snapshot/seal time | Database clock, fixing which consumer versions and slot enumeration the dataset contains |
| Access/pin/release time | Database clock; historical permission never overrides permission required now |

Availability and ingestion comparisons retain the foundation's inclusive `<=`
boundaries. Completion retains its own existing stricter rules. A newly imported
capture cannot acquire an earlier receipt time. A feature computed retrospectively
must preserve its actual recording time separately from its cutoff and evidence
availability; #118 will not claim that its artifact existed before it did or
promote reconstructed history to strict historical validation.

Feature selection is explicit: either an exact consumer ID, or the last matching
sealed record visible at dataset snapshot time for the **exact** player, game,
candidate, feature version, history policy, profile set and feature cutoff. Ties
use `(recorded_at, id COLLATE "C")`
and are recorded. There is no nearest-cutoff substitution, older-window fallback
or preference for a usable record over a later unavailable matching record.

Label selection supports an exact pinned version and a head **as of** a requested
label cutoff. A current-label call takes its as-of time from the database; a
historical call uses an explicit eligible time. Both expose chosen ID,
predecessor, availability and supersession metadata. Historical supersession at
the requested cutoff and present-day supersession are separate metadata; the
historical query must not expose a future outcome value. If a known chain/head
is removed or invalid, report it; do not revive an older numeric value silently.

All requested instants use explicit timezones and schema millisecond precision;
prediction, fitting and historical-label cutoffs cannot be future-dated relative
to the database snapshot. Feature artifact visibility is checked at snapshot time
and evidence eligibility at feature cutoff; those are not interchangeable tests.

Ordinary labels cannot satisfy this reader through the weaker path tracked in
#116. #54's adapter receives a feature object and a separate outcome object.
It must not put a target/evaluation label into `fitBaseline.history` or replace
actual availability with the prediction cutoff merely to pass its checks.

## Fitting-run identity and enforced evaluation separation

Each dataset belongs to a sealed **fitting run**, not a free-standing partition.
Its immutable identity contains `fittingRunId`, `evaluationPlanId`, `foldId`,
`fitCutoff`, the split-policy version/hash, the exact feature/history combination,
profile scope, model/configuration/code identity and the complete requested
training/evaluation inventory hash. One fitting run represents one fit for one
fold. Reusing its ID with different inputs refuses; another fold or changed fit
requires another run ID. An evaluation plan declares its folds and their run
identities explicitly, including walk-forward reuse.

Before any member dataset is sealed, a role-checked atomic operation seals the
complete run inventory, including every requested partition/slot and every shard.
It rejects the intersection of canonical **target game IDs** in training and
evaluation across that whole inventory. This is an event-level rule: different
players, cutoffs, kickoff revisions, consumer IDs, candidate versions, missing
labels or unavailable features cannot make the same game independent. No row is
dropped before this check. Unresolved event identity refuses run sealing. Within
a partition, duplicate player/game targets refuse, including repeats with another
cutoff or in another shard. Different players in one partition may share a game,
but counts disclose that shared event.

Every dataset/shard references that run's sealed inventory/hash and contains only
its exact assigned slots. Run preparation materializes the selected consumer IDs
and missing states for all shards from one coherent database snapshot. Subsequent
dataset preparation verifies and pins that already-fixed subset; it cannot run
a fresh latest-selection query. If evidence loses eligibility before sealing,
refuse instead of substituting it; reselection requires a new run/snapshot. No
transaction stays open across API calls, and pages never discover additional
members. Enforce the event/partition constraint in the database across all shards,
concurrent preparations and direct
SQL callers, rather than just validating each request in application code. A run
is not available for fitting/scoring until every declared shard is sealed and
their slots/counts reconcile to the complete parent inventory. A late new shard
or partition change requires a new run; it cannot extend a sealed inventory.

Training label eligibility is at/before `fitCutoff`. For a prospective or
walk-forward fold, each evaluation slot must satisfy
`fitCutoff <= featureCutoff < eligible target kickoff`; its scoring cutoff is
separate. Actual feature/label recording times and historical evidence basis
remain disclosed, so retrospectively recorded artifacts do not become a claim
of prospective validation. Evaluation outcomes must never enter the fitting
inputs, including `fitBaseline.history`. Any supervised history used to fit is
part of the declared training inventory, even if supplied through a different
adapter. Legitimately prior feature context still follows its own cutoff rules;
shared context alone is not counted as another supervised target.

Explicit walk-forward folds may reuse an event across **different fitting runs**
(for example, an earlier evaluation event can become a later run's training event
once its label is eligible). Each run still enforces its own disjoint target
sets. The evaluation-plan inventory records these memberships and reports unique
target events, player/game targets and repeated memberships separately. Repeated
predictions or folds are correlated uses of the same evidence; they cannot be
reported as independent events or silently pooled as additional sample size.
An evaluation plan fixes its aggregation/reuse policy before scores are inspected;
#118 exposes the accounting, and #54 must enforce that policy when evaluating.

## Proposed versioned service surface

The run/dataset/pin, page/label and complete-run verification operations below
are exported by the local store. Audited invalidation remains outstanding.
Every request carries `version: "qb-training-read-v1"`.

| Operation | Result / restriction |
| --- | --- |
| `prepareFittingRun(request)` | Atomically seal the complete run/fold inventory, shard assignments, split/history policies and fit/score clocks; reject cross-partition target-event overlap and materialize metadata selections/missing states for all shards at one snapshot |
| `prepareDataset(request)` | Verify an exact assigned selection from the sealed fitting run, seal its immutable manifest with feature/history identity, clocks and population reference; create its durable pin atomically or refuse the whole request |
| `readDatasetPage(datasetId, cursor, limits)` | Return exact rows from that sealed manifest, deterministic ordinal order and a next cursor; verify current access and evidence before payloads |
| `readCurrentLabels(keys, limits)` | Bounded batch of heads at one database-clock cutoff, including explicit missing/finalization/refusal states; separate from pregame feature selection |
| `readLabelsAt(keys, labelsAsOf, limits)` | The same batch semantics for historical label heads, including exact version/correction metadata |
| `pinDataset(datasetId, pinId, fittingRunRef)` | Audited idempotent additional pin on the existing immutable selection, matching its owning run/hash and subject to rights, quota and evidence availability |
| `releaseDatasetPin(pinId)` | Append a database-clock release event; it cannot rewrite the pin, extend provider retention or restore erased evidence |
| `readFittingRunReadiness({ version, fittingRunId, inventorySha256 })` | Verify every sealed dataset under one guard, list all unsealed assignments and reconcile the complete inventory; report verification, pin durability and usable pairs separately while retaining `fittingReady: false` |

A dataset row carries its ordinal and requested key/cutoffs, selected feature
and label references, separate feature/label states and reasons, participation/
finalization state, quality flags and exact provenance. Numeric payloads exist
only where the appropriate component is verified and usable. Absence, unresolved
participation, missing/expired/stale/refused evidence and unavailable bundles stay
distinct; none is silently dropped, converted to zero or scored as a Push.

The manifest records requested versus selected identities, original request,
selection-policy/code versions, candidate/feature/history identity, fitting-run/
fold and complete inventory reference, windows/partitions, source-consumer manifests,
dependency and body hashes, and covered/excluded/unresolved counts **separately
for training, evaluation and feature-history**. Counts reconcile to the requested
enumeration, not just successfully labeled rows. `sealed` means reproducible
selection, not qualified population or validated training.

## Snapshot, paging and access

Use materialized immutable membership, not an open transaction held across user
pages and not OFFSET over a live "latest" query. Preparation selects all eligible
IDs and missing-state rows from one coherent run snapshot; dataset sealing
verifies/pins its assigned subset without reselection. The committed manifest
fixes their order and source versions. A cursor binds dataset identity,
manifest hash, last ordinal and policy version; it cannot change filters or splice
pages from another dataset. Repeating a cursor reproduces the same selection.
V1 assigns ordinals by training/evaluation partition, feature cutoff, player ID
and game ID using explicit `C` text ordering. A selection policy fixes the exact
candidate/feature/history combination and profile scope. The run-wide inventory
enforces duplicate and cross-partition event rules before paging; local shard
checks cannot replace it.

New ingestion or corrections between pages do not change membership or swap
versions. A new dataset sees the new heads. Current rights revocation, mandatory
deletion or damage can make an old dataset unreadable: append an invalidation
event and return an explicit withheld/invalidated result, with no partial usable
page. Previously delivered pages remain attributable to their access time;
training must recheck dataset validity before consuming/finalizing a run.

Rights and evidence checks precede private byte reads. Access and deletion
synchronization must cover direct SQL writers as well as cooperating application
writers. The implementation must demonstrate that revocation/deletion cannot
race between its permission check and protected byte access; an old repeatable-
read snapshot or cached approval alone is insufficient. Acquire compatible guards
and digest locks in a documented order with bounded waits. Access changes do not
rewrite historical selection, and revoked protected metadata is not exposed merely
because it was selected earlier.

Batch retrieval loads required metadata/dependency sets together and verifies
shared artifacts once within the protected batch/snapshot. Verification reuse is
scoped to exact content references, snapshot and access state; no process-wide
"verified once" cache. Current rights must be checked again on subsequent page
requests. Sealing failures leave no partial dataset or durable pin. Interrupted
page reads resume with the same cursor. Retrying a completed prepare request with
the same identity/request digest returns its original sealed result; a conflict
refuses. A failed preparation may retry afresh and must disclose a new snapshot.

## Pins, release and mandatory deletion

Existing `predictive_feature_run_pins` protect the ordinary ledger only. #118
needs source-consumer/dataset pins with an audited dependency closure. V1 retains
the foundation's existing conservative association set, including replay-relevant
binding history; it does not shrink that set to make a quota pass. The closure
includes features, selected labels and required lineage, source captures/rows,
bindings/revisions, native observations/identity links, decisions, rights evidence
and private blobs needed to reproduce the selected computation/refusal.

An active durable pin survives the ordinary 90-day feature expiry until explicit
release, within provider retention and permission limits. Multiple pins are
independent. Releasing the last pin restores normal expiry eligibility using the
original recording time; a feature already older than 90 days can expire at the
next authorized sweep. Release does not imply an extra 90-day lease. A released
manifest is not promised replayable after its dependencies expire.
For this proposed V1 reader, an unpinned source feature at/after its 90-day expiry
is `expired` even if a sweep has not removed its bytes. Preparing/re-pinning a
dataset cannot resurrect it; a still-active valid pin preserves eligibility.

Pins never block rights revocation or mandatory source/provider/owner deletion.
Those operations invalidate affected datasets/runs and remove protected bytes
and identifiers as required by the event's audit policy. Only permitted minimal
audit/digests remain where identifiers cannot be retained. No hidden training
copy, unmanaged manifest blob or journal may preserve deleted provider payloads.
The same rules cover parent run inventories and pending shard selections, even
before they acquire a pin; their metadata is not an escape from deletion/access
controls. An incomplete run never becomes training-ready through a pin alone.
Pins/releases/invalidation and retention replay must restore/re-apply consistently
after backup recovery; training snapshots do not revive deleted evidence.

Use execute-only, role-checked database functions and database timestamps for
manifest/pin writes; ordinary callers cannot forge selection or retention links.
Coordinate shared retention entry points with #115; do not add another complete
copy of the multi-ledger procedure. Preserve legacy event count/digest behavior
when no new dataset/pin rows are affected, and retain digest-lock/removal-queue
recovery guarantees.

## Initial resource ceilings and measurement

These are **proposed safety ceilings, not measured throughput or delivery
forecasts**. Benchmark them before calling the implementation complete. Existing
stricter source-fact and artifact limits still apply; rights may further restrict
retained evidence. No overflow silently truncates a dataset or skips a slot.

| Bound | Proposed V1 ceiling |
| --- | --- |
| Requested slots per dataset / fitting run | 256 per dataset and 1,024 across the complete run inventory, with at most 16 source profiles per run; shards cannot bypass run-wide accounting |
| Returned rows per page/label batch | 64 |
| Serialized page payload | 8 MB |
| Unique private bytes verified per protected batch | 20 MB, preserving the existing verification ceiling |
| Dependency associations per sealed dataset | 65,536; count the conservative closure, not just selected stats |
| Run preparation / dataset preparation / page wall time | 30 seconds / 30 seconds / 10 seconds, with cancellation and bounded lock/statement waits |
| Durable retention quota | At most 32 active datasets, 256 MiB charged closure per dataset and 1 GiB total charged active closure for this local owner store |

Charge complete required blobs by actual size, plus serialized manifest bodies;
conservatively count shared bytes against each dataset's reservation. Multiple
pins of the same dataset do not multiply its charge, and releasing a pin frees
its reservation only when no active pin remains. Quota checks/updates are atomic.
If a legitimate selected slice exceeds a ceiling, report the measured blocker
and review a new limit/partition policy; do not quietly relax verification.

Measure SQL statement counts **and server-side loop/work costs**, indexed query
plans, verification calls/unique bytes, runtime, peak memory and retained storage
on 1/16/64-row batches. The new reader must not simply wrap the current
per-consumer reader in a loop. Demonstrate shared fetch/verification and avoid
row-multiplied network round trips. Set numeric benchmark thresholds from those
measurements before final review; synthetic timings alone do not establish
real-source capacity. Larger populations use explicitly partitioned manifests
with a complete parent run inventory, never silent "first 256" sampling. If that
inventory exceeds the proposed 1,024-slot bound, revise and benchmark the bound
before activation; creating more shards does not waive it.

## Delivery and coordination

Implementation checkpoint: `src/lib/predictive/training.ts` now validates the
supported history/version combinations and complete run requests, and selects
exact/latest feature and label versions from an already verified inventory.
It preserves missing/unavailable/expired states, uses run-wide event exclusion,
and discloses label supersession without returning future correction values.
`trainingSql.ts` adds one parameterized batch metadata query that retains every
requested ordinal, selects exact/latest feature IDs and historical label heads,
and reports supersession separately. Two mandatory PostgreSQL cases exercise
it against recorded source consumers. It does not read protected artifact bytes
or establish access/pin authorization by itself.
The selector remains a pure core, **not** a sealed dataset API. Database run
split enforcement, manifests/pins and retention remain outstanding. The pure
selector cannot authorize rights or validate durable pins; its adapter must
supply those verified facts.

The selection checkpoint at `7a3c1b9` passed **696 Node tests**, **75 Node database
checks + 138 PostgreSQL tests**, TypeScript and affected-file ESLint. It allocated
no migration and left frozen 0001–0011 unchanged.

The next checkpoint adds `replaySourceConsumers(ids)`: a restricted local evidence
primitive that verifies a complete bounded selection before returning protected
records. It shares transaction-local metadata queries, file reads and complete
source reconstruction, and checks every selected record before the first private
byte read. A role-checked table guard covers direct SQL rights changes and
retention; uncached clock-based access checks precede each unique file and
delivery. The implementation and lock ordering are documented in
[predictive-training-evidence.md](predictive-training-evidence.md).

Migration **0012_predictive_training_read_guard** is fixed for branch integration
under the [#106/#118 integration handoff](predictive-106-118-integration.md). It adds
the guard and feature/label lookup indexes without changing frozen 0001–0011 or
copying the retention procedure. Remote inspection found no other open feature
PR claiming a migration after 0011; this is not an agreement with another local
session. #106/#115 must integrate the final landing order before either merges.
This migration has run only in the isolated `dfs-ev-118-test` disposable Docker
project on permitted `[::1]:54329`; no persistent-dev, hosted or Production
database was migrated.

This primitive does **not** seal datasets, verify caller-supplied kickoff
assertions, pin dependencies, enforce database run splits or make model fitting
ready. Its shared-context benchmark is not population qualification or a capacity
claim. Remaining work includes end-to-end cancellation, representative indexed
plans/memory benchmarks, atomic durable run/dataset manifests and pins, quotas,
expiry/invalidation and retention/restore integration. The next implementation
increment at that checkpoint was database-enforced immutable run inventory and fixed consumer/missing
selections, followed by guarded shard verification and durable pins.

The run-preview increment adds `previewFittingRun(request)` on the local store.
It rehearses a complete inventory under 0012's guard: one metadata selection,
cutoff-visible kickoff-chain and raw-game-alias resolution, historical/current
model-input rights, exact kickoff claims and full byte-backed source-consumer
reproduction. It preserves the database's exact selected IDs and full-lineage
supersession flags rather than selecting again from the smaller verified subset.
Every slot remains in the preview with separate feature/label states and
partition counts. Its request/selection hashes bind the snapshot and kickoff
dependencies. Numeric feature/outcome bodies are not returned.

The preview is explicitly `preview-only`, `fittingReady: false` and population
unqualified. It creates no durable inventory, manifest, pin or fitting-run ID
reservation. A later recorder must reselect at its own guarded snapshot and
independently validate the whole request in SQL; a preview hash does not
authorize recording. Five mandatory PostgreSQL cases cover restricted replay,
late/false/superseded kickoff evidence, missing-slot rights and damaged bytes,
historical label identity and concurrent publication/caller mutation. This
increment allocates no migration; the prefix coordination remains binding.

Evidence checkpoint validation: **700 Node tests**, **75 Node DB checks + 142
PostgreSQL tests**, TypeScript, affected-file ESLint, migration/catalog/readiness
checks, whitespace and documentation links pass. Four new mandatory DB cases
cover guarded shared reads, concurrent rights/retention, damaged evidence and
scheduled revocation. The final 1/16/64 shared-context fixture took about
0.35/1.21/4.69 seconds with three private file reads each. Per-record SQL work
still grows linearly; this is not a real-source capacity or training-readiness
claim. See the evidence checkpoint for measurements and remaining limits.

1. **Handoff agreed (2026-10-13).** The owner reviewed `b7db281`, approved existing
   v1 for #106 and authorized #118 implementation. #106 inventories its real
   dependencies in parallel. Clocks, exact version/history references, run-wide
   accounting, immutable paging and pin/deletion semantics remain binding.
2. **Indexed batch readers and label heads.** Implement the agreed QB interface,
   coherent snapshot preparation and bounded verification reuse. Use synthetic
   consumers to prove mechanics; this alone is not #118 completion.
3. **Durable manifests and retention.** Implement atomic sealing/pins, release,
   expiry, invalidation, quota and restore/re-apply behavior with the shared
   retention integration. Benchmark and complete required gates/review once the
   increment is stable.

Released migrations are **0001–0011**; the combined branch now includes fixed
**0012–0016**: training guard, #106 gzip staging, #118 run inventory, #106
compressed inspection envelopes/guarded diagnostic binary verification and
#118 dataset manifests/pins.
#106's complete pushed 0001–0013 checkpoint at `47b1c89` was merged in `da24ab9`;
0001–0014 are unchanged by #106's integrated `4f1ad06` checkpoint. **0016 is
implemented and is #118's complete next range; 0017 only is reserved for #106
qualified compressed publication.** Coordinate landing order with
#106/#115 before merging further DDL. A
second merger integrates main without rebasing and may renumber only private,
unapplied-outside-disposable-test migrations, with explicit confirmation and
regenerated manifests/contracts. Never modify a released/applied prefix.

Required adversarial checks include inclusive receipt/cutoff boundaries, late
ingestion, corrections and unavailable heads between pages, deterministic cursor
retry, exact candidate/feature/history compatibility (including unknown/inactive
versions and v1 relabeling), cross-partition same-game rejection across players,
cutoffs, missing states and shards, concurrent run sealing, duplicate targets
across shards, invalid run/fold reuse, valid cross-run walk-forward reuse with
unique-event accounting, fixed shard selection despite later heads, incomplete
run refusal, current/historical labels and supersession, unresolved versus
affirmative zero participation, revocation before byte access (including concurrent direct
SQL changes), pinned expiry after day 90, multiple-pin release, quota contention,
narrow/broad mandatory deletion, rollback/crash recovery and backup audit parity.
Use hand-specified expected rows/versions/counts, restricted logins and actual
PostgreSQL plans. Full suites run at the stable increment boundary; focused
checks cover intervening changes. No new tests are needed for this document alone.

No model fitting/selection, paid acquisition, public serving, hosted scheduler or
Production migration is part of this contract. #118, #106 and #107 remain distinct
prerequisites for validated #54 Part B; completion of one cannot waive another.

The SQL run-inventory increment adds `prepareFittingRun(request)` and
`readFittingRun(id)`. Preparation reserves the complete normalized request and
all shard assignments at one database clock, independently validates kickoff,
policy/version/clocks and run-wide splits, and fixes exact consumer/missing
selections. Idempotent retries retain that snapshot. A later matching feature
cannot silently enter the run. Fixed-holdout event reuse within a plan refuses;
walk-forward reuse remains explicitly correlated. Execute-only recorder/replay
roles cannot edit membership or append a late shard.

Both APIs return metadata only: `inventory-sealed`, `fittingReady: false`,
population unqualified. They do not open protected files, expose numerical
feature/outcome bodies or create pins. A role-checked hook erases pending
inventory in the existing retention transaction, preserves separate supplemental
audit and retains digest-only identities to refuse erased run/plan reuse.
Deletion conservatively applies to every named protected profile, including
missing slots and narrow capture intervals. The retention API's optional
`trainingRetention` field is part of restore/reapply matching.

The next increment is guarded verification of each assigned shard using those
fixed selections, immutable dataset manifests and atomic evidence pins. Then
complete stable paging/current-label reads, release, quotas, expiry/invalidation,
recovery, end-to-end deadlines and representative capacity evidence. The
[integration handoff](predictive-106-118-integration.md) records the prefix,
checksum and shared interfaces. No persistent or hosted database ran 0014.
The combined inventory checkpoint passes 736 Node tests, 75 Node DB checks,
158 PostgreSQL tests, typecheck and affected-file lint. Generated artifacts,
frozen 0001–0013 SQL/catalog contracts, whitespace and local documentation
links pass; the final full database gate includes the total-profile ceiling.

Assigned-shard verification now implements `verifyDatasetShard` using the SQL
inventory's exact IDs and missing states. Under the read guard it checks actual
kickoff/consumer bytes, fresh protected uses and unpinned 90-day eligibility,
preserving historical supersession and global ordinals. Retries reverify files.
The metadata proof is ephemeral: `verified-only`, `fittingReady: false`, population
unqualified. It returns no numerical bodies and creates no dataset or pin. Future
sealing must verify in its own recording transaction; caller-supplied proof hashes
are not authorization. The next DDL increment remains 0016 for durable manifests,
pins and their retention closure, without changing frozen 0001–0015.
The combined shard checkpoint passes 746 Node tests, 75 DB checks and 172
PostgreSQL tests, typecheck, affected-file lint and generated-artifact/frozen-prefix
checks. See the evidence checkpoint for adversarial cases and the expiry-selection
constraint that 0016 must address; an FK-only pin cannot protect retention.

The 0016 dataset/pin increment implements `prepareDataset`, `readDatasetManifest`,
`pinDataset` and `releaseDatasetPin`. SQL fixes manifests/closure from assigned
inventory; the adapter verifies bytes inside the recording transaction and on
every read. Protected uses cover ancestor providers even when a label correction
changes scope; their current rights and mandatory deletion apply to the full
dataset lineage. Independent pins and atomic storage quotas protect valid features
past their original expiry. Release never renews it. Mandatory deletion and
unprotected expiry remove the appropriate dataset closure with supplemental
restore/reapply audit. See the integration/evidence checkpoints for the exact
prefix and checksum-guarded retention seams that #115 must preserve or replace.
These are metadata APIs, with `fittingReady: false`, population unqualified.
Paging/label reads, complete-run readiness, invalidation, deadlines and capacity
remain outstanding; no model fitting is authorized by a sealed manifest alone.

The final dataset/pin checkpoint passes 748 Node tests, 75 DB checks and 185
PostgreSQL tests (160 mandatory predictive cases), typecheck, affected-file lint
and all 17 catalog contracts. Frozen 0001–0015 remain unchanged from `84945bf`.
#118's complete next migration range is 0016; 0017 only is reserved for #106.

The next reader increment implements `readDatasetPage`, `readCurrentLabels` and
`readLabelsAt` without new DDL. Page requests include the owning run/inventory,
dataset and manifest hashes, a nullable cursor and row/byte limits. They verify
the full assigned shard and conservative closure on every call, preserve global
ordinals, missing states and frozen labels, and return separate feature/outcome
payloads only where usable. Current/historical label requests carry the exact
market/stat/version/profile scope, target keys and optional exact references;
head selection precedes compatibility filtering. Missing final labels do not
become numeric zero, DNP or sportsbook settlement. See the evidence checkpoint
for cursor-address semantics, refusal states and adversarial tests.

Remaining #118 checkpoints: audited invalidation; end-to-end deadlines/cancellation and interrupted
reads; representative indexed plans/memory/runtime/storage evidence; independent
review and final integrated CI. Reverification of the full shard per page is a
deliberate first implementation and still requires capacity assessment. #106/#107
remain separate gates for validated #54 Part B. Frozen 0001–0016 remain unchanged.

Final reader validation passes 753 Node tests, 75 Node DB checks, 193 PostgreSQL
tests (168 mandatory predictive cases), typecheck, affected-file lint and all 17
catalog contracts. The 36 frozen/generated prefix files match `2f57d12` byte for
byte; documentation links and whitespace checks pass. No persistent or hosted
database was migrated. The evidence checkpoint records the final log paths.

The complete-run checkpoint adds `readFittingRunReadiness` without DDL. It derives
all assignments from the immutable inventory, authorizes every sealed closure
before files, verifies exact shared bytes once under one guard and reconciles all
requested slots. Missing datasets stay explicit; unusable components stay counted.
Current pin durability is separate from complete verification and usable pairs.
No numerical bodies, durable certificate or population qualification are returned.
Access/expiry failures withhold the whole run and later publication never replaces
its selected references. Frozen 0001–0016 and shared gzip/cleanup interfaces remain
unchanged. Audited invalidation is the next checkpoint and needs a coordinated
forward migration after #106's confirmed prefix; no new number is allocated here.

Final complete-run checks pass 756 Node tests, 75 Node DB checks and 196 PostgreSQL
tests (171 mandatory predictive cases), typecheck, affected-file lint and all 17
catalog contracts. The 36 frozen/generated prefix files match `986bfed`; local
documentation links and whitespace pass. The evidence checkpoint records final
logs and the focused pure-fixture rerun. Only disposable databases were used.
