# #52 PR B: real-source ingestion progress

Updated 2026-10-11. PR A merged as [PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102),
`d934432e8aa32a38226c65306592b77e04e05f01`. Migration 0003 is frozen.
PR B starts from that main revision on `feature/dfsEV-52-real-source-ingestion`
in `/private/tmp/dfs-ev-52-pr-b`. Offline qualification and local raw CSV claims
persistence and canonical normalization planning are implemented. The raw/canonical
correction-lineage design also has an executable pure contract. Database binding
publication remains next; this does not finish PR B or parent #52.

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

Forward migration `0004_predictive_source_claims.sql` adds immutable raw-source
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

The released JSON observation path still expects revision arrays; it cannot
hydrate CSV rows as canonical evidence. Staged row projections do not authorize
normalization. The [source-lineage design](predictive-source-lineage.md) now defines
the separate raw binding chain and per-entity canonical chains, with a tested
append/attach/withhold transition planner and cutoff-head selector. Identity
rerouting follows the raw chain before selecting a canonical entity, so an old
player/game contribution cannot remain active. A missing raw row withholds the
contribution without generating absence, zero or DNP. These are pure functions;
no binding table or canonical writer is enabled. The next adapter must:

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
Coordinate migration numbering before review; 0004 is still local/unmerged.

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

PR B review evidence must eventually show real-source capture A and later B,
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
