# #52 PR B: real-source ingestion progress

Updated 2026-10-11. PR A merged as [PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102),
`d934432e8aa32a38226c65306592b77e04e05f01`. Migration 0003 is frozen.
PR B starts from that main revision on `feature/dfsEV-52-real-source-ingestion`
in `/private/tmp/dfs-ev-52-pr-b`. This increment is an offline qualification
adapter; it does not finish PR B or parent #52.

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

## CSV publication: next engineering work

Filesystem CSV support does not make SQL replay CSV-aware. `validateDataset()`
expects JSON revision arrays, limited to 1 MB/2,048 rows per artifact.
`persistArtifact()` writes JSON media; `hydrate()` verifies observations against
that JSON. The player CSV exceeds 2 MB; full identifiers/roster enumeration also
exceeds the 8,192-observation publication bound. Changing suffixes or a cap cannot
establish normalization provenance.

Requirements for the next storage design, before implementing any migration:

1. Keep exact full CSV bytes, verified media/header/profile and retrieval context
   as the source artifact. Preserve v1 journals in their existing archive
   namespace; never silently rename them into SQL-owned blobs.
2. Bind each normalized observation to its exact source capture, parsed data-row
   ordinal, selected-row hash, parser/transform version and exact bridge revisions.
   The ordinal counts emitted records, not physical lines: quoted newlines and
   skipped blanks make line numbers unsuitable. Full source hashes pin excluded
   columns without importing them into SQL.
3. Hydration re-parses the raw bytes and checks the allowlisted projection,
   payload and raw identity. A generated JSON manifest may be an additional
   immutable witness; it cannot replace the original artifact/row binding.
   Profile authorization alone cannot prove a row's normalization.
4. Preserve source archive times separately from later SQL publication. Importing
   a retained capture now cannot backdate SQL ingestion. Stamp decision knowledge
   times with the database clock; release `updated_at` stays diagnostic.
5. Preserve same-profile correction chains/source keys. Changed content appends
   revisions; exact recaptures add visibility evidence without earlier availability.
   Disappearance requires a complete capture with compatible scope, never a probe
   or filtered subset.
6. Include raw artifacts, normalized witnesses, row bindings and descendants in
   the retention graph. Extend reviewed execute-only APIs and digest locks, with
   rollback/resume/orphan proofs under the intended non-superuser role. A new
   table with an unhandled foreign key would break current retention.
7. Bound shared file parsing separately from target/player publication. Keep
   refused/unresolved rows in diagnostics. Measure SQL rows/links, index/TOAST
   sizes, bytes per recapture, queries and RSS before raising bounds or scheduling.

No schema changes are committed in this increment. Any extension needs 0004 or
later, generated migration/catalog/readiness artifacts and disposable empty,
upgrade, no-op and retention proofs. Coordinate numbering with other work;
0003 and its checksum remain unchanged.

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

## Validation of this increment

The new tests use hand-specified counts/refusals for ten-field projection,
missing/zero/signed values, paired denominators, identity/context/season refusal,
positive individual evidence, unresolved denominators, contradictory positions
and conflict ordering. Offline tests verify original v1 output, unchanged bytes,
no fetch or SQL-owned file publication, tampered-byte refusal and credentials.

Validation passed on Node 24.18.1: **517 Node tests**, including 54 new tests,
typecheck, lint and `git diff --check`. The retained capture was restored offline
and the independent Python candidate partition agrees. No database schema or
publication path changed, so the DB suite was not repeated for this increment.
Database integration
becomes mandatory when the CSV publication/schema path changes. PR A's DB and
remote-CI proofs do not count as tests of that future path.
