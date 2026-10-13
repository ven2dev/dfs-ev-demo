# #106 / #118 feature and label handoff proposal

Status: **proposed, awaiting agreement before runtime implementation**.
Prepared 2026-10-13 from merged-main `716d7559f6b3d402b098810efa5e6646f99e6709`
(PR #105). Relay owns [#118](https://github.com/ven2dev/dfs-ev-demo/issues/118);
the real-slice session owns [#106](https://github.com/ven2dev/dfs-ev-demo/issues/106).
This document specifies a contract to review, not an implemented API or a claim
that real data is qualified. Both branches start from merged main.
Relay branch: `feature/dfsEV-118-training-reads-retention`. This checkpoint
changes this proposal only; no runtime code, schema or migration has changed.

## Shared boundary

V1 supports **QB `player_pass_yds` only**, with stat `passing_yards`, feature
version `passing-yards-source-v1` and label version `source-final-label-v1`.
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

## Objects exchanged by #106 and #118

#106 records ordinary identity/schedule/completion evidence and the source
bindings/decisions using the existing verified publication paths. It then records
features with `recordSourcePassingYards` and final labels with
`recordSourceFinalLabel`, rather than sending #118 unverified JSON or CSV values.

For each requested player/event slot, the handoff names:

| Field | Meaning |
| --- | --- |
| Slot identity | Canonical GSIS player ID, canonical game ID, season/season type, kickoff version, market and training/evaluation partition |
| Pregame feature request | Exact `candidate`, profile IDs, prediction cutoff and history policy/window; enriched first-real-slice proof uses opponent context |
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
candidate, profile set and feature cutoff. Ties use `(recorded_at, id COLLATE "C")`
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

## Proposed versioned service surface

Names below specify behavior; they are documentation, not exported code yet.
Every request carries `version: "qb-training-read-v1"`.

| Operation | Result / restriction |
| --- | --- |
| `prepareDataset(request)` | Seal an immutable selection manifest from a bounded explicit slot enumeration, versioned selection policy, feature/label clocks, code identity and population reference; create its durable pin atomically or refuse the whole request |
| `readDatasetPage(datasetId, cursor, limits)` | Return exact rows from that sealed manifest, deterministic ordinal order and a next cursor; verify current access and evidence before payloads |
| `readCurrentLabels(keys, limits)` | Bounded batch of heads at one database-clock cutoff, including explicit missing/finalization/refusal states; separate from pregame feature selection |
| `readLabelsAt(keys, labelsAsOf, limits)` | The same batch semantics for historical label heads, including exact version/correction metadata |
| `pinDataset(datasetId, pinId, runIdentity)` | Audited idempotent additional pin on the existing immutable selection, subject to rights, quota and evidence availability |
| `releaseDatasetPin(pinId)` | Append a database-clock release event; it cannot rewrite the pin, extend provider retention or restore erased evidence |

A dataset row carries its ordinal and requested key/cutoffs, selected feature
and label references, separate feature/label states and reasons, participation/
finalization state, quality flags and exact provenance. Numeric payloads exist
only where the appropriate component is verified and usable. Absence, unresolved
participation, missing/expired/stale/refused evidence and unavailable bundles stay
distinct; none is silently dropped, converted to zero or scored as a Push.

The manifest records requested versus selected identities, original request,
selection-policy/code versions, windows/partitions, source-consumer manifests,
dependency and body hashes, and covered/excluded/unresolved counts **separately
for training, evaluation and feature-history**. Counts reconcile to the requested
enumeration, not just successfully labeled rows. `sealed` means reproducible
selection, not qualified population or validated training.

## Snapshot, paging and access

Use materialized immutable membership, not an open transaction held across user
pages and not OFFSET over a live "latest" query. Preparation selects all eligible
IDs and missing-state rows from one coherent database snapshot. The committed
manifest fixes their order and source versions. A cursor binds dataset identity,
manifest hash, last ordinal and policy version; it cannot change filters or splice
pages from another dataset. Repeating a cursor reproduces the same selection.
V1 assigns ordinals by training/evaluation partition, feature cutoff, player ID
and game ID using explicit `C` text ordering. A selection policy fixes candidate
and profile scope; duplicate player/game slots within a partition refuse instead
of being deduplicated or counted as independent training examples.

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
| Requested slots per dataset | 256, with at most 16 source profiles |
| Returned rows per page/label batch | 64 |
| Serialized page payload | 8 MB |
| Unique private bytes verified per protected batch | 20 MB, preserving the existing verification ceiling |
| Dependency associations per sealed dataset | 65,536; count the conservative closure, not just selected stats |
| Preparation / page wall time | 30 seconds / 10 seconds, with cancellation and bounded lock/statement waits |
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
with a complete parent inventory, never silent "first 256" sampling.

## Delivery and coordination

1. **Agree this handoff.** #106 can inventory its real dependencies in parallel.
   Confirm clocks, consumer/version references, requested-slot accounting,
   immutable paging and pin/deletion semantics before runtime implementation.
2. **Indexed batch readers and label heads.** Implement the agreed QB interface,
   coherent snapshot preparation and bounded verification reuse. Use synthetic
   consumers to prove mechanics; this alone is not #118 completion.
3. **Durable manifests and retention.** Implement atomic sealing/pins, release,
   expiry, invalidation, quota and restore/re-apply behavior with the shared
   retention integration. Benchmark and complete required gates/review once the
   increment is stable.

Frozen migrations are **0001–0011**. No new migration number is allocated by this
proposal. Coordinate landing order with #106/#115 before either adds DDL. A
second merger integrates main without rebasing and may renumber only private,
unapplied-outside-disposable-test migrations, with explicit confirmation and
regenerated manifests/contracts. Never modify a released/applied prefix.

Required adversarial checks include inclusive receipt/cutoff boundaries, late
ingestion, corrections and unavailable heads between pages, deterministic cursor
retry, current/historical labels and supersession, unresolved versus affirmative
zero participation, revocation before byte access (including concurrent direct
SQL changes), pinned expiry after day 90, multiple-pin release, quota contention,
narrow/broad mandatory deletion, rollback/crash recovery and backup audit parity.
Use hand-specified expected rows/versions/counts, restricted logins and actual
PostgreSQL plans. Full suites run at the stable increment boundary; focused
checks cover intervening changes. No new tests are needed for this document alone.

No model fitting/selection, paid acquisition, public serving, hosted scheduler or
Production migration is part of this contract. #118, #106 and #107 remain distinct
prerequisites for validated #54 Part B; completion of one cannot waive another.
