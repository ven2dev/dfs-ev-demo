# #52 PR B: versioned source foundation

Updated 2026-10-13. PR A merged as [PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102),
`d934432e8aa32a38226c65306592b77e04e05f01`. Migration 0003 is frozen.
PR B's historical review baseline is merged-main checkpoint `3daf1dc`, which
includes PR A and creator-corpus PR #103. Remote `main` was fetched on 2026-10-13
and still resolves to `3daf1dc26f1bf737da57b094b0075446381eb92c`; no additional
integration or migration renumbering is needed at draft opening. Review
`git diff 3daf1dc...HEAD`; the checkout's stale local `main` is not the correct
base. GitHub compares against current remote `main`: fetch again before merging,
inspect new changes/migration numbering, and validate the final integrated state
if that target has advanced. The branch is
`feature/dfsEV-52-real-source-ingestion` in `/private/tmp/dfs-ev-52-pr-b`.
Offline qualification and local raw CSV claims
persistence and canonical normalization planning are implemented. The raw/canonical
correction-lineage design also has an executable pure contract. Database binding
publication and unavailable-state persistence are implemented in internal research
staging. Persisted binding-aware reconciliation and participation research
decisions follow in forward 0009. Forward 0010 now connects those decisions to
fixture-backed QB passing-yards feature manifests and final labels. The latest
implementation checkpoint is `4f1b976`. This code has passed local gates, but its
latest consumer integration still requires independent review.

## Revised PR B acceptance boundary (2026-10-13)

On 2026-10-13 the owner authorized proceeding with the draft-PR review process
for a **versioned source foundation checkpoint**, provided this acceptance
boundary is explicit and independent review passes. This is authorization of
the review process, not approval of the implementation or permission to merge.
This replaces PR B's previous responsibility for the first usable real-data QB
vertical slice. Parent #52 retains its original acceptance criteria. A foundation
merge does not complete that issue or qualify real predictive inputs.

PR B's completion checklist is:

- [ ] Independent review covers migrations **0005–0010**, their application
  recorders/readers/consumers, privilege boundaries and retention/recovery paths.
- [ ] Review blockers are resolved and the final integrated merge candidate
  passes required checks and remote CI. Record the exact reviewed SHA, reviewer,
  local results and CI links in the [review record](predictive-pr-b-review.md)
  or its linked PR review. Changes invalidate approval of affected code and
  require renewed review. Existing local results are evidence for `4f1b976`, not
  evidence that independent review or final-candidate remote CI has completed.
- [x] Fixture-backed usable QB passing-yards features and final labels are
  demonstrated, including replay, stale/missing evidence, provenance, rights and
  retention refusal cases. These do not qualify a provider or model population.
- [x] Retained real-data refusal evidence is disclosed separately: the
  **schema-9** proof imported 4,517 player rows and 130 team rows with **zero
  usable canonical heads, feature bundles or labels**. The **schema-10** consumer
  checkpoint is fixture-backed; it did not rerun that real-data proof or produce
  usable real outputs.
- [ ] The independent reviewer writes an architecture disposition covering both
  ledgers' rights, cutoff selection, finalization and retention, plus policy
  duplication when adding a market. The current architecture must be judged
  correct and maintainable before consolidation can be deferred to a ticket;
  any required redesign is resolved before merge rather than left implicit.
- [x] The [follow-up acceptance criteria](predictive-followups.md) identify the
  usable real slice and remaining parent work. They are local issue drafts;
  GitHub issue links must replace the draft-only coordination before parent
  closure. No follow-up ticket is evidence that this foundation passed review.

The next real slice must select one QB, target game, history window and opponent
window, then inventory every required dependency and its permitted source before
making a delivery forecast. Individual participation/completion, minimum enforced
resource limits and reproducible recovery belong to that slice. Population
completeness, broader multi-feed operations, other markets and snap-source
qualification have separate follow-up criteria.

The previously stated 6–12 and 20–35 engineering-day ranges were provisional
planning ranges, not substantiated delivery forecasts. Qualification may require
new adapters or forward schema changes. Estimate again after the selected slice's
dependency inventory; include independent review and blocker resolution explicitly.

### Source-consumer architecture review

0010 introduces a separate source-consumer ledger so a CSV feature/label can cite
its exact binding, revision, head token and source decision without pretending
that a source revision is an ordinary JSON observation. The released
observation-only feature/label ledger remains supported. This gives the current
implementation two recording, replay and retention paths.

For the current CSV implementation, #54's data handoff must use the verified
source-consumer store APIs (`replaySourcePassingYards` and, for recorded features
and labels, `replaySourceConsumer`). It must not read ordinary feature/label
tables as though they contain CSV consumers or use them as an automatic fallback.
#54 integration and model validation are not implemented by this checkpoint.

Independent review must provide a written assessment of rights, cutoff
selection, finalization and retention across both ledgers, duplicated policy,
replay consistency and the cost of adding another market. The separate ledger is the
current compatibility strategy; permanent coexistence has not been approved.
Record the reviewed SHA, correctness/maintainability conclusion and evidence in
the [review record](predictive-pr-b-review.md) or its linked PR review. A later
unified facade/consolidation ticket is acceptable only after the current design
has passed that assessment; a ticket cannot defer a present correctness or
maintainability blocker.
Any consolidation must preserve recorded provenance and historical replay with
forward changes; it must not rewrite frozen migrations or existing records.

Sections below retain earlier implementation checkpoints. Statements that the
real vertical slice or consumer activation is "next" describe those checkpoints;
this acceptance boundary and the final 0010 section govern the current finish line.

The canonical stats read adapter now follows complete recorded raw lineages
before filtering by canonical player/game. It reuses the verified binding
reader, returns explicit withheld states, and pins binding provenance separately
from unchanged statistical revisions. It remains a read-only research API;
the QB consumer integration follows in 0010. Forward migration
0008 now independently recomputes the same witness in SQL, and every canonical
research read requires exact agreement with it after verifying provider files.

Shared consumer preparation now pins the exact bound head set in
[`sourceWitness.ts`](../src/lib/predictive/sourceWitness.ts). Read-only
reconciliation, positive-usage and post-window source-capture checks use this
same witness, including unresolved contributions. Query time alone does not
invalidate it; recaptures do, even when they reuse a statistical revision.
The post-window check follows the selected binding's exact capture. These
helpers do not activate features or labels. The 0009 research recorder persists
decisions using the same verified witness; 0010 activates the bounded QB consumer
path under model-input/outcome-label rights. See
[the witness contract and limits](predictive-source-lineage.md#remaining-activation-work).

## Parent #52 acceptance criteria audit (2026-10-12)

**Parent #52 is not complete.** This audit follows the nine original criteria in
[the issue](https://github.com/ven2dev/dfs-ev-demo/issues/52), rather than treating
the first QB passing-yards slice or passing tests as a scope reduction. PR A's
merged foundation and PR B's research staging establish the behaviors below
within their implemented paths; they do not yet establish them for every selected
real feed or for a scheduled predictive service.

| Acceptance criterion | Evidence in the implemented scope | What remains before parent closure |
| --- | --- | --- |
| Selected usage/opportunity, injury/availability, opponent and game-environment inputs are ingested | Fixture-backed QB passing-yards bundles; exact real player/team CSV persistence and normalization witnesses; offline schedule, identity and roster assessment. | Persist and qualify all seven selected capture groups, including raw injury/depth; complete applicable nine-market mappings; produce a usable real bundle with player and opponent context. |
| Every feature value carries source, times, normalized identity and version/provenance | PR A observation/run manifests and PR B raw-row fingerprints, exact normalization dependencies, revision IDs and binding tokens. | Carry the verified CSV bindings through active feature manifests and dependent decisions/labels; prove the provenance contract for the remaining real adapters. |
| Feature reads honor arbitrary cutoffs | Synthetic bundles and persisted raw/binding research reads cover before/at/after boundaries and late ingestion. Forward 0008 cross-checks every research witness in SQL. | Integrate the shared SQL/application rule with real-source feature reads and recorder manifests. A research fact snapshot is not yet a feature row. |
| Corrections preserve history | Immutable captures, append-only observation/raw-binding lineages, recapture/reappearance provenance, prior-cutoff replay and retention restoration regressions. | Preserve these guarantees across the active real-source consumers and remaining feed adapters; do not expose revisions through an older reader that ignores their binding head. |
| Missing/stale/unsupported/unresolved inputs stay explicit | Missing/refused/ambiguous raw rows, stale/withheld bindings and unresolved routing withhold rather than expose stale numeric payloads; fixture windows retain gaps and known-absence quality. | Apply the same states to real feature construction and qualify injury/depth freshness semantics. Unknown availability cannot become healthy and missing participation cannot become zero. |
| Identity resolution fails closed | Exact raw identity provenance, both-direction bridge ambiguity checks, kickoff-effective normalization and conservative routing before canonical filtering. | Register qualified real game/player/team bridges and dated membership evidence; integrate the same identity/head checks in downstream decisions and final labels. |
| Scheduled syncs are idempotent, bounded, observable and documented | Local exact-ID retries, atomic publication/rollback, acquisition/read caps, private journals and measured disposable-database proofs. | Complete the bounded multi-feed pilot, retry/checkpoint recovery, indexed scale and runtime/memory/storage budgets, then scheduling and hosted operation after #95 and owner-approved rights/persistence/budgets. No scheduler is active. |
| Tests cover boundaries, corrections, missingness, staleness, ambiguity, retries and no look-ahead | At code checkpoint `e8e76e7`, 831 jsdom + 616 Node tests and 74 Node DB checks + 92 DB tests passed, including 75 mandatory predictive cases. | Add SQL/application parity and end-to-end real-binding cases for features, reconciliation, participation, labels and post-window captures; test remaining adapters and pilot failure/retry behavior. Current counts are not evidence of unimplemented behavior. |
| Storage, indexes, retention, provider cost and licensing/display constraints are documented | Reviewed schema/operations guides, private content-addressed artifacts, execute-only retention/recovery, cross-version audit parity and local row/index/process measurements. | Qualify indexed roster-scale queries and enforce measured operating budgets; resolve outstanding provider-use/retention and hosted rollout gates. Research measurements are not production capacity evidence. |

The latest retained-file proof (2026-10-12 17:46 UTC, code `e8e76e7`) made zero
requests and restored 4,517 player rows (4,512 typed, five refused) plus 130 typed
team rows. Both canonical reads returned **zero usable heads** and a
`game-bridge-missing` binding with unresolved routing. It published **no active
canonical observations, features or labels**. This demonstrates safe refusal and
reproducible storage, not usable real predictive inputs or model readiness.

Evidence: [canonical research reader](../src/lib/predictive/sourceFacts.ts),
[persisted reader and publication](../src/lib/predictive/persistence.ts),
[pure routing/provenance cases](../tests/predictive/sourceFacts.test.ts),
[mandatory database cases](../tests/db/sourceClaims.test.ts),
[test reasoning](predictive-test-review.md), and
[operating and rights policy](predictive-data-operations.md). The checkpoint logs
and proof measurements are recorded in the
[session handoff](predictive-session-handoff.md#latest-checkpoint-canonical-stats-read-adapter).

The shared binding-aware SQL head/witness kernel and application research-read
parity now exist in 0008. The next integration unit is adopting that rule in
feature, final-label and post-window recorders and their application readers.
0009 implements the isolated research decision recorder described below;
activate the dependent feature/label consumers together. #90's PR #103 merged as `3daf1dc`
on 2026-10-12; the coordinated merge/renumber now places PR B after its released
creator-corpus migration. A new forward activation migration can follow.
Qualified completion, participation/zero-opportunity, complete population,
membership and schedule/history evidence remain separate source gates; a
correct head rule cannot manufacture them. Model evaluation belongs to #54 and
product UI integration to #53, rather than being additional #52 implementation.

## Migration ordering decision (2026-10-12)

The owner approved #90 landing first: its creator-corpus migration owns 0004.
PR #103 merged as `3daf1dc` at 2026-10-12 19:27:45 UTC. Main is merged into
this branch without rebasing, and PR B's three unmerged migrations are moved
from **0004–0006 to 0005–0007**. Their SQL bytes/checksums are unchanged; catalog
prefix contracts and generated manifests now include the creator-corpus schema.
The owner confirmed the old private prefixes ran only in disposable databases.
Released 0001–0004 SQL/checksums/catalog contracts remain unchanged.

| Current migration | Earlier private filename |
| --- | --- |
| `0005_predictive_source_claims.sql` | `0004_predictive_source_claims.sql` |
| `0006_predictive_source_bindings.sql` | `0005_predictive_source_bindings.sql` |
| `0007_predictive_unavailable_bindings.sql` | `0006_predictive_unavailable_bindings.sql` |

Historical checkpoint logs below retain their original numeric schema versions;
those disposable databases have been removed. Recreate any old private prefix
rather than attempting to migrate its obsolete ledger. The runner's checksum
and target guards remain intact.

Capture-less bindings cannot prove they fall outside a time-scoped source
deletion. Keep the conservative closure: remove those bindings and their entire
raw-key lineage for the named profile. This can remove more history than the
event's time window; never turn an unknown capture time into evidence of safety.

The cross-version retention regression executes legacy empty/nonempty deletions
under pre-0006 SQL, restores identical evidence into a post-0006 database, and
requires identical audit counts/digests in both full and digest-only modes. It
also checks file removal, unrelated survivors and idempotent reapplication
through a non-superuser retention-only login. See the
[test reasoning](predictive-test-review.md#pr-b-cross-version-retention-audit-2026-10-12).

## Implemented increment

`sourceStats.ts` projects the ten permitted player/team counts under
`nflverse-raw-stats-v1`. It retains raw game/team/opponent/player identities and
the GSIS namespace, without minting canonical identities. Missing columns and
blank/NA cells stay distinct from observed zero; signed yardage is preserved.
Context, identity, integer bounds and paired count relationships fail closed.
The assessment refuses player/team rows outside the captured stats season.

`sourceReadiness.ts` applies approved F3: positive attempts, carries or targets
support an **individual source participation claim**. Missing statistics,
all-zero usage and weekly ACT cannot establish absence, zero participation or a
complete eligible population. Identity, roster, stats and schedule conflicts
withhold that individual's claim. A contradictory non-QB roster row cannot erase
a QB candidate; malformed current-season QB context stays unresolved.

The candidate evidence digest includes distinct selected-row fingerprints for
roster, identity, matching schedule and statistics evidence. It is invariant to
input order and exact duplicates, including conflicting evidence. This is an
assessment digest, not a canonical feature dependency manifest. The original
selected projection digest preserves source row order.

The new `assess` command re-verifies the v1 journal, exact source/metadata hashes,
header profiles, capture timestamps and original qualification before applying
the separately versioned readiness rule. Existing `verify` output and immutable
v1 journals remain unchanged. `sourceDiagnostics` contains the legacy counts,
including the original all-unresolved participation rule; `qbParticipation`
contains the new F3 assessment. Neither authorizes features or final labels.

```sh
npm run predictive:source -- assess \
  --artifact-root /private/tmp/dfs-ev-52-source-proof.utpDdL \
  --journal f496e74d6823d5507b301568d2c9c1dbc6f562fe93c8cbb52f621bd6674a5b31.json \
  --journal-bytes 10967
```

This runs offline with no acquisition or SQL. It shares `verify`'s credential
guard; use an environment without database/provider credentials. Retain every
source/metadata file referenced by the journal for restoration.

## Actual sample and limits

The input is the existing 2026-10-09 capture, not a newly downloaded season.
The candidate unit is a QB **team/week** roster record, not a distinct player,
starter or gradable pick. All roster statuses remain in the enumeration.

| Measure | Observed |
| --- | ---: |
| Player statistics rows | 4,517 |
| Typed player projections | 4,512 |
| Player refusals: missing GSIS raw ID | 5 |
| Team rows / typed projections | 130 / 130 |
| QB team/week candidates | 553 |
| Positive-usage individuals | 148 |
| Unresolved: missing stats / identity | 404 / 1 |
| Confirmed absences | 0 |

An independent Python `csv.DictReader`/SHA-256 check agrees with the candidate
partition and identifies the five missing raw player IDs. This establishes
sample parity, not independent official outcomes or population completeness.

Candidate evidence digest:
`e4e59e643e54de3f9e5096d0944958ff65ee7d85fc0edc692ecc8b8df3b6dfd1`.
Original selected projection digest:
`20b3612bb591839f0e6e4238b7f7da122c2cefefacfcf27cf8cbca28a9052443`.

Offline assessment measured **1.86 seconds wall**, 2.00 seconds user CPU,
0.16 seconds system CPU and **444,760,064 bytes maximum RSS** (about 424 MiB),
using macOS `/usr/bin/time -l`. This includes restoration, selected-row parsing,
legacy qualification and assessment, not acquisition or SQL. The implementation
retains selected rows in memory and has no hard memory ceiling; byte/row caps do
not substitute for a memory budget.

Private evidence is `/private/tmp/dfs52-prb-assessment.json`,
`/private/tmp/dfs52-prb-assessment-metrics.txt`, and `/private/tmp/dfs52-prb-parity.py`
with `/private/tmp/dfs52-prb-parity.json`. The
[source prototype](predictive-source-prototype.md) records original requests,
bytes and storage. This increment adds no raw files. Temporary storage is not a
durable archive.

## Local raw CSV claims persistence

Forward migration `0005_predictive_source_claims.sql` adds immutable raw-source
rows, not canonical observations. The complete, unfiltered 2026 player/team
season-file is the supported scope, capped at 8 MB and 8,192 parsed records.
Each row records its capture, record ordinal, raw-key hash, allowlisted row hash
and either a typed projection or an explicit refusal. Ordinals count emitted
CSV records, not physical lines; quoted newlines and skipped blanks are tested.
Exact source hashes pin excluded columns without importing those columns.

`publishSourceStats()` verifies the parser/header/profile, writes exact CSV
bytes to `.db-blobs/` under the digest lock, and atomically publishes the run,
capture and every row. A database trigger stamps ingestion from the database
clock even for direct SQL. The original archive capture time stays separate;
importing it now cannot establish earlier SQL knowledge. Current internal
research rights are checked under the profile lock. Exact retries preserve the
run, ingestion time and replay; failed publication cleans only its unpublished
CSV address. Existing root journals stay unchanged.

`replaySourceStats()` runs read-only at repeatable read, checks current rights,
selects the newest source snapshot visible at the cutoff, verifies the raw hash
and header, and re-parses every record against the stored fingerprints and typed
projection. Importing an older archive later cannot replace a newer snapshot.
Different hashes captured at the same time remain ambiguous. Missing, refused
and conflicting rows remain explicit; disappearance is not converted into zero
or absence. The staging boundary rejects linking these CSV artifacts directly
to canonical observations. Raw claims never publish features or finalize labels.

Retention includes source rows in its deletion closure, audit digest and optional
full tombstones. Existing execute-only owner APIs, exact file-reference checks,
queued removal/resume and digest locks remain in force. Ordinary restrictive
foreign keys remain in place. Events with no source rows retain their released
counts/digests for backup re-apply compatibility. Migration 0003 and all released
contracts/checksums remain unchanged; app readiness minimum remains 2.

The offline proof uses the retained v1 journal and its previously approved
internal-research review. It makes no upstream requests and creates/removes only
a registered disposable database and a separate private artifact directory:

```sh
docker compose --env-file /dev/null --project-name dfs-ev-demo-test \
  -f compose.test.yml up -d --wait --wait-timeout 60
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  npm run predictive:source:local -- prove \
  --artifact-root /private/tmp/dfs-ev-52-source-proof.utpDdL \
  --journal f496e74d6823d5507b301568d2c9c1dbc6f562fe93c8cbb52f621bd6674a5b31.json \
  --journal-bytes 10967
npm run test:db:down
```

CSV-storage checkpoint proof (`83de5fd`) on 2026-10-11 (Los Angeles; SQL import at
2026-10-12 02:29 UTC):

| Measure | Player | Team |
| --- | ---: | ---: |
| Stored source records | 4,517 | 130 |
| Typed / refused | 4,512 / 5 | 130 / 0 |
| Exact CSV bytes | 2,011,144 | 53,958 |
| Publication time | 3,031 ms | 111 ms |
| One targeted replay, including full-file verification | 289 ms | 12 ms |

Combined row heap is 4,227,072 bytes; indexes 1,662,976 bytes; total relation
storage 5,922,816 bytes. Whole-process maximum RSS is 444,497,920 bytes (~424 MiB).
These are one-run local measurements, not a scheduled-operation capacity claim.
Raw files add 2,065,102 logical bytes in the scratch store. There are zero
canonical observations, features or final labels. Both feeds are unavailable
one millisecond before import, and identical retries preserve replay.
Evidence: `/private/tmp/dfs52-prb-csv-proof-83de5fd.json`. Replay digests include actual
SQL ingestion times and legitimately differ when the proof is rerun.

## Canonical normalization planning

`sourceNormalization.ts` now plans a typed canonical player/team stats payload
from verified source replay, together with exact row ordinals/fingerprints,
raw capture/file references, parser/transform versions, identity links, current
rights decisions and bridge/schedule observation dependencies. It requires an
explicit game bridge, dated team/opponent aliases, and a schedule consistent
with season, week, season type and home/away identity. Player claims also need
the exact raw ID/namespace bridge effective at kickoff and a cutoff-known
authorization link. A GSIS-looking ID alone supplies no bridge. Missing/conflicting
evidence produces no candidate. Zero, signed yards and missingness are preserved.

The persisted `planSourceStatsNormalization()` re-verifies raw CSV and stored
rows, then hydrates scoped bridge/schedule evidence against exact JSON bytes
inside one read-only, repeatable-read transaction. It loads both forward and
reverse identity mappings and schedules sharing the selected raw aliases, so a
conflict outside the first mapped game/player cannot be hidden. It validates
chosen source chains without reconstructing unrelated corrections from mixed
artifacts. A replay-only non-superuser can use this path. Retention can leave
profile/link registrations, but those cannot replace deleted bridge evidence.

Normalization explicitly uses current `internal-research` rights. Existing
feature replay still defaults to `model-input`; this does not expand licensed
uses. The plan's payload digest is separate from its binding/plan digest.
Later bridge corrections affect only later cutoffs, while unrelated evidence,
input ordering and a later access time under unchanged rights leave the plan
unchanged. Plans are ephemeral: no observation ID, predecessor, feature run,
completion, membership window, absence or label is created.

The extended retained-file proof at 2026-10-12 03:17 UTC (2026-10-11 Los Angeles)
imports/replays the same 4,517 player and 130 team rows, then correctly returns
`unavailable-source-normalization / game-bridge-missing` for both feeds. It does
not invent canonical bridges. Player publish/replay/plan measured 3,037/274/270 ms;
team 108/12/31 ms. Source-row storage stays 5,922,816 bytes; maximum process RSS
was 414,973,952 bytes (~396 MiB). Zero requests and zero canonical observations,
features or labels were published, and the scratch DB/files were removed.
Evidence: `/private/tmp/dfs52-prb-normalization-proof.json`.

## Canonical publication: next engineering work

### Canonical stats reader implemented without a new migration

`replaySourceStatsFacts({ profileIds, entityKeys, cutoff })` reads every recorded
raw lineage in the explicit source profiles in one repeatable-read, read-only
transaction. It verifies historical witnesses with their own versions/clocks,
replans at the cutoff, follows raw heads, and only then filters canonical
entities. A current unrecorded remapping withholds both the previous and newly
mapped destinations, even when the destination has no stored canonical revision
yet. Stale states expose routing metadata and failure reasons, not old numeric
payloads. Recorded missing/conflicting context never becomes a zero or absence.
Unresolved routing is explicit and cannot be filtered away as unrelated: until
a current plan establishes a destination, the preliminary selector withholds
within the requested profiles. Historical destinations alone cannot establish
where a currently unresolved raw claim belongs.

Each usable head includes its exact binding event and a binding token, alongside
the revision's first recorder time. A recapture or reappearance can retain the
same numeric revision while changing its binding token and source references.
Equivalent current rights renewal preserves the original selected binding and
digest. Current source/context rights are checked before opening historical
files. The preliminary selector reports selected/missing/ambiguous/withheld;
multiple observed provider heads still require reconciliation.

This is **recorded-lineages-only** coverage: it does not enumerate an eligible
player population or make unrecorded raw rows usable. Discovery intentionally
scans whole requested profiles before canonical filtering, avoiding incomplete
SQL routing. It refuses more than 16 profiles, 64 entity filters, 256 raw
lineages, 8,192 total events, or the existing 256 events per raw lineage/20 MB
verified-byte bounds. It never returns a truncated prefix. These limits and the
existing file cache bound this research operation; indexed large-roster reads
and a memory/elapsed-time budget remain future work.

The retained-file proof at 2026-10-12 17:46 UTC makes zero requests. It imports
4,517 player rows (4,512 typed, five refused) and 130 typed team rows. Both
canonical fact reads return zero usable heads and one `game-bridge-missing`
withheld binding with unresolved routing. Player/team fact reads measured 357/50 ms. Whole-process wall
time was 7.77 seconds and maximum RSS 465,534,976 bytes (~444 MiB), measured
rather than capped. Active canonical observations, features and labels remain
zero. Evidence: `/private/tmp/dfs52-prb-facts-proof.log` and
`/private/tmp/dfs52-prb-facts-proof-metrics.log`.

The increment passes 831 jsdom + 616 Node tests, 74 Node database checks +
92 database tests (all 75 mandatory predictive cases), typecheck, lint and CI
gate. No migration/catalog/readiness artifact changed. Seven new mandatory
database cases and twelve pure cases cover this adapter; see the
[test reasoning](predictive-test-review.md#pr-b-canonical-fact-reader-2026-10-12).

### Remaining active integration

The released JSON observation path still expects revision arrays; it cannot
hydrate CSV rows as canonical evidence. Staged row projections do not authorize
normalization. The [source-lineage design](predictive-source-lineage.md) now defines
the separate raw binding chain and per-entity canonical chains, with a tested
append/attach/withhold transition planner and cutoff-head selector. Identity
rerouting follows the raw chain before selecting a canonical entity, so an old
player/game contribution cannot remain active. A missing raw row withholds the
contribution without generating absence, zero or DNP. These functions defined
the initial pure contract. The subsequent binding storage checkpoint below implements
bindings and canonical source revisions in research staging. Activation still
requires the following complete adapter boundary:

1. Record the planned binding atomically with canonical evidence, revalidating it
   at publication under the database clock. Add database-enforced exact row/
   bridge references and re-parse/recompute the normalized payload during
   hydration. A generated JSON witness can supplement raw provenance, not replace
   it. Current plans are not an authorization token or a stored dependency table.
2. Preserve same-profile source keys and correction chains across complete
   snapshots. Changed content appends revisions; recaptures never backdate
   visibility. Disappearance requires compatible complete coverage before
   publishing `absence-v1`, not a missing-row inference from a probe.
   The released source key includes the canonical entity: an identity correction
   that changes that entity cannot simply be appended to its current chain. The
   forward recorder must enforce the separate raw/canonical chains described
   above before enabling writes.
3. Include row bindings, normalization witnesses and dependent canonical rows in
   retention, and stamp new decision knowledge times with the database clock.
4. Keep target/player normalization bounds separate from shared full-file parsing.
   The much larger identifiers/roster feeds are outside this stats-only storage
   increment. Measure their storage, queries and RSS before increasing bounds.

Any schema extension must be forward from frozen 0003, with generated catalog/
readiness artifacts and disposable empty, upgrade, no-op and retention proofs.
The coordinated merge now sequences this work at 0005–0007 after #90's released
0004, preserving the SQL bytes. Historical evidence below uses its original
private prefix numbers.

## Source gates before usable passing-yards inputs

- **Completion:** `event-completion-v1` needs qualified provider final status plus
  its confirmer. A stats row, scores, elapsed time or `END GAME` alone cannot
  satisfy the complete policy. Qualify a permitted status source and test partial
  games, suspension, missing terminal rows and corrections.
- **Population/zero opportunity:** F3 closes only individual positive-usage cases.
  The 405 unresolved candidates are not zeros/exclusions. Official
  [nflverse scheduling documentation](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
  says FTN participation from 2023 arrives after the postseason, so it cannot
  provide current-season lagged coverage. Its
  [CC BY-SA attribution terms](https://nflreadr.nflverse.com/reference/load_participation.html)
  need a separate use review. PFR remains rejected under approved F4.
- **Identity/membership:** register evidence-backed player/team/game bridges,
  including GSIS mappings, aliases/reschedules and ambiguity controls. Weekly
  roster grain does not prove exact membership effective bounds.
- **Schedule/history:** establish independent complete enumeration and prior-season
  samples. Current mutable historical files cannot establish past availability.

Injury/depth semantics and the oversized full depth feed remain separate gates
for enriched candidates. No account, key, purchase, hosted migration or schedule
is needed for local storage/adapter development. #95 gates hosted activation.

The usable-real-slice follow-up evidence must show real-source capture A and later B,
unchanged earlier replay, correctly changed later replay, exact raw/bridge
dependencies and measured costs. Edited fixtures are useful tests, but cannot
be described as observed provider corrections. Unqualified completion/population
keeps the real bundle unavailable and parent #52 open.

## Validation

The new tests use hand-specified counts/refusals for ten-field projection,
missing/zero/signed values, paired denominators, identity/context/season refusal,
positive individual evidence, unresolved denominators, contradictory positions
and conflict ordering. Offline tests verify original v1 output, unchanged bytes,
no fetch or SQL-owned file publication, tampered-byte refusal and credentials.

The CSV-storage checkpoint passed on Node 24.18.1: **831 jsdom + 529 Node tests**, typecheck,
lint, the production Webpack build, CI gate, `git diff --check`, and the complete
PostgreSQL gate (**74 Node checks + 58 database tests**, including all **41**
mandatory predictive cases). App tests require local
loopback listeners; the sandbox-denied attempt was rerun with that permission.
The retained-file proof above passed with no downloads. Database cases cover
timestamp enforcement, cutoff boundaries, row/byte corruption, current rights,
complete ordinals, equal-time conflicts, late old archives, migration upgrade/
no-op, rollback cleanup, non-superuser retention/resume and retention re-apply
after re-importing retained files into a fresh database. This last check proves
deletion-set parity, not preservation of historical SQL ingestion times. The
[test reasoning review](predictive-test-review.md) distinguishes independent
oracles from checks shared with the implementation.

The subsequent normalization planner passes **561 Node tests** (including 32
new planning cases), the full PostgreSQL gate (**74 Node checks + 62 DB tests**,
all **45** mandatory predictive cases), typecheck and lint. Four new DB cases
cover replay-only access/read isolation, reverse identity conflicts and mixed
artifact scoping, raw tampering, and schedule alias conflicts outside the mapped
game. The extended real-file proof above also passes. This increment changes no
SQL migration, catalog contract, application route or readiness version.

The raw-lineage increment adds **42 pure cases**, bringing the complete Node
suite to **603**. All **831 jsdom** cases and the PostgreSQL gate (**74 Node
checks + 62 DB tests**, all **45** required predictive cases) pass, as do
typecheck and lint. The test fixture for team-only lineage deliberately removes
player authorization links; the full validation path correctly refuses a
player link on a team-only source profile. The lineage functions remain outside
the publication path. Their synthetic history checks do not prove SQL clock,
privilege, concurrency or retention enforcement. Migration 0003 and its released
contract remain untouched; no additional migration is introduced here.


## Bound source revisions checkpoint

Forward migration 0005 now persists canonical source statistics, exact raw and
context associations, and separate raw/canonical correction chains in internal
research staging. The local store exposes `recordSourceNormalization` and
`replaySourceNormalization`. Recorder-only writes, database clocks, complete
SQL recomputation, original-byte hydration, expected-head concurrency, current
research rights and whole-lineage retention are covered by mandatory disposable
PostgreSQL tests. See [the implemented storage boundary](predictive-source-lineage.md#storage-checkpoint-implemented-in-0006).

This supersedes the earlier statement that binding storage is unimplemented.
It does **not** activate canonical observations, model reads or labels. The
existing real archive still has no registered game bridges, so its normalization
remains `game-bridge-missing`; no download or provider qualification occurred in
this increment. At the 0005 checkpoint, the recorder accepted positive
normalization plus missing/refused/ambiguous raw-row states; context failures
were unrecordable read-only plans. The 0006 checkpoint below supersedes that
limitation. Feature, reconciliation, participation and label reads still need
the same binding-aware heads before activation. Migration 0003 and committed 0004 remain unchanged;
maximum-known advances to 5 while application readiness minimum stays 2.


The bound-revision checkpoint passes **831 jsdom + 603 Node tests** with two
workers, the complete disposable PostgreSQL gate (**74 Node DB checks + 75 DB
Vitest tests**, all **58** mandatory predictive cases), typecheck, lint, CI-gate
checks, `git diff --check` and local links in the four updated guides. Two default
worker-count app attempts had timeouts in untouched UI/creator files under local
machine load; all the same cases pass with `--maxWorkers=2`. No test timeout or
repository test configuration was changed. The scratch lifecycle removed its
Docker database. Logs: `/private/tmp/dfs52-prb-bindings-jsdom.log`,
`/private/tmp/dfs52-prb-bindings-node.log` and
`/private/tmp/dfs52-prb-bindings-db.log`. The new storage behavior is verified with
synthetic fixtures; no additional provider download or real bridge qualification
was performed. No persistent dev, hosted or Production database received 0005.


## Unavailable-state storage checkpoint

Forward migration 0006 adds normalization plan v2. The database independently
reconstructs the complete witness for missing/ambiguous captures, raw-row
failures, missing/conflicting game/team/opponent/player identity, absent/missing/
ambiguous schedules, incompatible schedule context and missing player identity
links. It compares the entire proposal, including failure reason, exact evidence
sets and current rights; recomputing a forged digest cannot authorize a record.
The current witness must still match at the recorder's database clock.

Unavailable plans pin the source's rights and those of every cited dependency.
A missing context state supersedes usable statistics through the raw binding
chain. Recovery can attach unchanged statistics without manufacturing a numeric
correction. Earlier cutoffs keep their original result while access rights permit.
All cited conflicting capture files are verified before recording and on replay.
Denied context profiles are filtered before their files are opened.

Existing v1 plans and exact-ID retries retain their original byte/digest witness;
new records require v2. A v1-to-v2 format transition alone is not an evidence
correction. Retention conservatively removes capture-less bindings and their
whole raw lineage when their source profile is scoped, including time-scoped
deletions: a record with no capture cannot prove it falls outside that interval.
The revoked-rights response remains an access refusal, not authorization to
retain or expose provider payloads.

Migration 0003 and committed 0004/0005 stay unchanged. Maximum-known advances
to 6; application readiness minimum remains 2. These revisions still do not
contribute to features, participation/reconciliation decisions or final labels.
The next implementation must make every application/SQL consumer use the same
raw-binding head rule before activation.


Validation for the 0006 checkpoint: **831 jsdom + 604 Node tests**, **74 Node database
checks + 84 database tests**, all **67 mandatory predictive cases**, typecheck,
lint, CI-gate, migration/catalog/readiness verification, whitespace checks and
21 local documentation links pass. The retained-file proof ran at
2026-10-12 16:38 UTC with **zero requests**: 4,517 player rows (4,512 typed,
five refused) and 130 typed team rows; each feed recorded/replayed its
`game-bridge-missing` binding and verified an exact-ID retry. Active canonical
observations remain zero. Peak whole-process RSS was 476,119,040 bytes
(~454 MiB), measured rather than capped. Registered scratch databases and the
isolated PR-B Docker container were removed; the creator container was left
alone after isolation. No persistent dev, Neon or Production migration ran.

Evidence: `/private/tmp/dfs52-prb-unavailable-jsdom.log`,
`/private/tmp/dfs52-prb-unavailable-node.log`,
`/private/tmp/dfs52-prb-unavailable-db.log`,
`/private/tmp/dfs52-prb-unavailable-proof.log`.

## Latest verified checkpoint: consumer witnesses and #90 merge

Commit `4319a6b` implements shared application witnesses and read-only
reconciliation/usage/post-window source-capture checks. Seventeen pure cases
and two mandatory database cases prove exact binding provenance, reuse of an
unchanged statistical revision with fresh capture evidence, unresolved-provider
withholding and replay-only access. These remain research helpers; active
feature/decision/label integration and the matching SQL rule are still next.

Main/#90 `3daf1dc` is now merged without rebasing, with PR B files at 0005–0007.
Released SQL/catalog contracts 0001–0004 match main exactly and the renamed SQL
keeps its old checksums. Generated prefixes/readiness include creator-corpus
0004; minimum readiness remains 2 and maximum-known is 7. A mandatory v4-upgrade
case seeds all five creator-corpus tables and proves that predictive migrations,
CSV publication and no-op reruns preserve their rows and recorded history.

The final gates pass **873 jsdom + 633 Node tests**, **75 Node DB checks + 103
DB tests**, all **78 mandatory predictive** and **8 creator-corpus** cases,
typecheck, full lint, CI gate, Firebase Admin runtime, the production Webpack
build, migration/catalog/readiness verification and whitespace/link checks.
Only PR B's isolated disposable project was used and removed. No persistent
dev, Neon or Production migration ran. Evidence logs are
`/private/tmp/dfs52-prb-consumers-{jsdom,node,db,typecheck,lint,ci,build}.log`.

The version-7 retained-file proof at 2026-10-12 20:00 UTC made zero requests,
restored the same 4,517 player/130 team rows, and returned zero usable heads with
`game-bridge-missing` and unavailable consumer witnesses for both feeds. It
published no active canonical observations/features/labels. Whole-process wall
time was 7.97 seconds and maximum RSS 498,810,880 bytes (~476 MiB), measured,
not capped. Evidence: `/private/tmp/dfs52-prb-consumers-proof.log` and
`/private/tmp/dfs52-prb-consumers-proof-metrics.log`. Source qualification and the
parent ACs remain incomplete; the #90 sequencing hold is resolved.

## Shared SQL witness checkpoint (0008, 2026-10-12)

Forward migration 0008 adds the private binding-aware witness reconstruction and
checker plus a role-checked, database-clock public reader. Every
`replaySourceStatsFacts()` read now verifies provider bytes and requires exact
agreement between the application and SQL witnesses in one read-only,
repeatable-read transaction. Rehashed omissions/fabrications refuse. Current-use
checks reject stale/reused-revision bindings, withheld, missing and empty sets;
historical witnesses still replay at their own cutoff. Source discovery expands
all recorded raw lineages before canonical filtering, including destinations
without stored revisions and unresolved routing.

No new consumer tables, feature/decision/label activation or retention procedure
are introduced. SQL proves metadata; the application retains byte verification.
Internal-research access is not model-input/outcome authorization. The next
forward migration must connect recorders/manifests and retention closure across
all active consumers together. Source qualification and parent ACs remain open.

Validation passes **873 jsdom + 633 Node tests**, **75 Node DB checks + 110
database tests**, all **85 mandatory predictive** and **8 creator-corpus** cases,
typecheck, lint, CI gate and production Webpack build. Seven mandatory tests add
direct SQL forgery/currentness/roles/upgrade cases; their
[oracles and limits](predictive-test-review.md#pr-b-sql-witness-parity-0008-2026-10-12)
are documented. Released 0001–0004 and previous private 0005–0007 SQL/catalog
contracts remain unchanged. Minimum readiness stays 2; maximum-known becomes 8.

The schema-8 retained-file proof at 2026-10-12 21:28 UTC made **zero requests**,
restored the same 4,517 player/130 team rows and verified both unavailable
`game-bridge-missing` witnesses through SQL. Player/team fact reads measured
389/59 ms; whole-process wall time was 8.08 seconds and maximum RSS 428,195,840
bytes (~408 MiB), measured rather than capped. It published zero active canonical
observations/features/labels. All database writes were disposable/local.
Evidence: `/private/tmp/dfs52-prb-sql-witness-{db,node,jsdom,typecheck,lint,ci,build}.log`,
`/private/tmp/dfs52-prb-sql-witness-proof.log` and
`/private/tmp/dfs52-prb-sql-witness-proof-metrics.log`.

## Persisted research decision checkpoint (0009, 2026-10-12)

Forward 0009 adds append-only reconciliation and participation decision records,
exact binding/native/right associations, an execute-only database-clock recorder
and verified read-only replay. It shares the 0008 witness and recomputes policies
independently in SQL. Exact retries, stale recaptures, unavailable recovery,
current-rights revocation before files, non-superuser permissions and expected-head
concurrency are covered. Retention removes entire affected scope lineages so a
deleted contradictory successor cannot revive a positive ancestor; conservative
capture-less deletion and restored-backup audit parity are tested.

These are **internal-research records**. Existing feature/run and final-label
writers remain gated; the next migration must integrate their binding-aware
manifests, current heads, completion/post-window/raw-identity checks, use-specific
rights and retention together. A current insufficient/conflicting/unresolved
research decision is not usable label evidence. Real sources remain unqualified
for game bridges, completion, membership and complete population. No scheduler,
hosted rollout, source request or active real feature/label is added here.

The [lineage contract](predictive-source-lineage.md#persisted-research-decisions-0009)
and [fourteen database test oracles](predictive-test-review.md#pr-b-persisted-research-decision-tests-0009-2026-10-12)
cover the scope and limits. Previous SQL/catalog prefixes 0001–0008 are unchanged;
minimum readiness remains 2, maximum-known becomes 9. Validation results and
measurements are recorded in the latest session handoff checkpoint.

## QB source consumers (0010, 2026-10-13)

`sourceConsumers.ts` and the store's `replaySourcePassingYards`,
`recordSourcePassingYards`, `recordSourceFinalLabel` and `replaySourceConsumer`
connect verified CSV facts to the existing QB window policy. This is a new,
explicit source-consumer ledger; source revisions never masquerade as ordinary
observations, and released observation-only feature/label tables stay intact.
Only fixture-backed QB passing yards is activated. Real source qualification,
other markets, a scheduler and hosted operation remain outstanding.

Each queried fact pins its source witness, exact binding/revision/head token,
persisted reconciliation and participation heads, and explicit missing/stale
reasons. Unchanged recaptures stale current decisions even when the statistical
revision is reused; historical cutoffs and stored runs reproduce their original
answer. Native schedule/coverage/membership/completion dependencies remain
ordinary observations and retain their existing semantics. Known absence keeps
its chronological slot; unknown participation never becomes zero. Computation
time is excluded from the input digest. Body bytes, current rights and the
server recording time are bound into a separate execution digest.

The SQL recorder checks the witness and decision head independently (following
successors, not lexical IDs), validates displayed stats against selected source
payloads and checks native manifest closure. The application reproduces the full
window calculation on replay. The recorder is execute-only and stamps its clock
after evidence/publication locks; consumers and association sets are append-only.
Replay checks current use rights and association closure before any file opens,
verifies the body and all relevant provider/context bytes, and reproduces the
historical calculation in a read-only/repeatable-read transaction.

Internal-research permission alone is insufficient: every source, historical
normalization context and native-evidence profile also needs the requested
model-input or outcome-label permission. Final labels require current persisted
participation/reconciliation, qualified current completion, the existing final
window, the selected binding's exact post-window capture, and its exact raw-ID
player bridge with current linked/effective normalization. A planning/recording
race that changes the witness or decisions refuses finalization.

Retention includes source consumers, their complete association sets and body
blobs. Deleting a source/binding/native decision removes its dependent features
and the entire affected label lineage, preventing ancestor revival. Feature
consumers expire after 90 days; legacy feature-run pins apply only to the legacy
ledger, and this bounded source-consumer API exposes no pin facility. Empty new
closures preserve earlier retention counts/digests. Existing digest locks,
rollback cleanup and queued blob recovery also protect the new body files.

0001–0009 SQL/catalog prefixes remain frozen and unchanged. Readiness stays at
minimum 2 and maximum-known advances to 10. All execution used disposable local
PostgreSQL. The retained real-file proof remains the schema-9 proof documented
in the handoff: zero qualified usable heads, no real feature or label. Passing
synthetic end-to-end cases does not change that qualification result.

PR B's next step is independent foundation review against the revised acceptance
checklist above. The [first usable real-slice follow-up](predictive-followups.md#first-usable-real-qb-passing-yards-slice)
owns qualification of game/identity, schedule/history, membership and completion
evidence and a bounded usable real bundle/label proof. Remaining feed/market and
population qualification still prevent closing parent #52. Foundation readiness
requires review, blocker resolution and final checks; fixture results alone do
not satisfy that gate.
