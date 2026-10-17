# #138 source inventory

Inspected 2026-10-17T11:02:24.951047+00:00. Scope: 2021–2025 regular-season QB passing
yards. This is a source inventory, not an ingestion run, benchmark, evaluation or
population certification. Full URLs, release asset IDs, wire/decoded SHA-256,
sizes, headers, row counts and per-file license evidence are in
[source-inventory.json](evidence/feature-store-138/source-inventory.json).
The exact one-off [inspection script](evidence/feature-store-138/inspect-source-inventory.py)
and [gap inspection](evidence/feature-store-138/inspect-participation-gap.py) are
archived beside it; their hashes match the evidence. They read public bytes in
memory and write their reports to `/private/tmp/`, not the pipeline stores.
These are inspection recipes, not ingestion implementations or benchmarks.

## Design basis

- **Pattern:** a pinned source manifest before deterministic ELT. Decode only
  for schema and coverage inspection, retaining hash-bound metadata.
- **Alternatives:** inferring feeds from the old branches risks importing the
  retired design; using unpinned latest URLs as reproducibility evidence hides
  source changes; equating the MIT loader license with a data license is wrong.
- **Targets:** inventory only; the later ingest benchmark includes download,
  validation, ObjectStore write and normalization under 60 s (42 s for headroom).
  These inspections do not count as measured ingestion successes.
- **Requirement reasons:** compare provider digests when available to detect
  changed bytes; record locally computed hashes when absent to bind inspection;
  keep actual publication times to avoid invented historical availability.
- **Assumptions:** public release endpoints, no hosted database access, source
  payloads decoded in memory and not persisted. Durable raw snapshots start only
  through ObjectStore in the next step. Reports and scripts contain no raw payload.

## Selected release artifacts

| Feed | Season | File | Wire bytes | CSV rows |
|---|---|---|---:|---:|
| stats_player | 2021 | stats_player_week_2021.csv.gz | 1,254,611 | 18,969 |
| stats_player | 2022 | stats_player_week_2022.csv.gz | 1,241,515 | 18,831 |
| stats_player | 2023 | stats_player_week_2023.csv.gz | 1,237,909 | 18,643 |
| stats_player | 2024 | stats_player_week_2024.csv.gz | 1,244,175 | 18,983 |
| stats_player | 2025 | stats_player_week_2025.csv.gz | 1,262,421 | 19,422 |
| weekly_rosters | 2021 | roster_weekly_2021.csv | 15,242,660 | 46,696 |
| weekly_rosters | 2022 | roster_weekly_2022.csv | 14,790,824 | 46,163 |
| weekly_rosters | 2023 | roster_weekly_2023.csv | 14,612,235 | 45,655 |
| weekly_rosters | 2024 | roster_weekly_2024.csv.gz | 699,786 | 46,579 |
| weekly_rosters | 2025 | roster_weekly_2025.csv.gz | 708,144 | 46,849 |
| pbp_participation | 2021 | pbp_participation_2021.csv | 22,498,246 | 50,714 |
| pbp_participation | 2022 | pbp_participation_2022.csv | 22,245,804 | 50,150 |
| pbp_participation | 2023 | pbp_participation_2023.csv | 49,967,956 | 46,168 |
| pbp_participation | 2024 | pbp_participation_2024.csv | 49,688,308 | 45,919 |
| pbp_participation | 2025 | pbp_participation_2025.csv | 49,094,943 | 45,184 |
| schedules | all; filter 2021–2025 | games.csv.gz | 515,248 | 7,548 |

Total inspected wire bytes: 246,304,785.
All files decoded successfully, with no duplicate header names or malformed-width
rows. Gzip files passed the decoder's integrity check. Every non-null GitHub asset
digest matched the downloaded wire bytes. Older assets without provider digests
have locally computed hashes; a missing provider digest is not a hash failure.

`stats_player` is the current release tag; the older `player_stats` path is not
the source chosen here. Weekly rosters use the `weekly_rosters` release and
`roster_weekly_YYYY` files, not the initially probed nonexistent `rosters_weekly`
tag. Season-only rosters were inspected as metadata alternatives and rejected
for this fixture because weekly records give a closer identity/team association.
The schedule is one all-season file; preserve the original bytes, then filter
the normalized rows to the five selected seasons. Do not manufacture season files.

Inventory downloads are ephemeral. At ingestion, bind the fixture to actual
ObjectStore snapshot hashes. If a mutable release changed, record a new inventory
revision before evaluation rather than silently substituting bytes. The schedule
already changed between metadata reads during this session; the JSON records
the metadata and verified bytes from the completed inspection, not the earlier read.

## Coverage observed

| Season | REG games | QB stat rows | Distinct QBs | Missing roster identity/team/week | Missing positive offense match |
|---|---:|---:|---:|---:|---:|
| 2021 | 272 | 655 | 81 | 0 | 0 |
| 2022 | 271 | 633 | 83 | 0 | 0 |
| 2023 | 272 | 663 | 81 | 0 | 0 |
| 2024 | 272 | 664 | 78 | 0 | 0 |
| 2025 | 272 | 664 | 81 | 0 | 1 |

There are 3,279 QB stat rows, with no duplicate player/game key, missing GSIS ID
or missing attempts/yards field among them. All 1,359 schedule games have QB stats
and participation rows. This says nothing about whether every relevant play,
roster candidate or zero-opportunity participant is represented.

There are 156 zero-attempt QB stat rows; do not exclude them solely for having
zero attempts. Confirm participation individually before assigning a usable label.
One 2025 row lacks a positive offense-player match: Russell Wilson
(`00-0029263`), `2025_01_NYG_WAS`, NYG, 37 attempts / 168 passing yards. It remains
unresolved, not an inferred absence or zero. The exact evidence is in the JSON.

The 2021 and 2022 participation files contain 4,388 and 4,292 rows respectively
with missing offense-player lists, including postseason rows. These counts do not
classify the plays as eligible or prove missing offensive plays. Positive presence
can be established from another row; absence cannot be inferred from these lists.
Broader completeness, exact membership intervals, observed completion clocks and
pregame identity availability remain unqualified. Gaps are reported without
blocking this spike, per the owner; #54 retains population-completeness work.

## Licenses and attribution

| Feed | Published declaration | Attribution | Qualification |
|---|---|---|---|
| Weekly stats, all five seasons | CC BY 4.0 | nflverse contributors | Release-repository declaration |
| Weekly rosters, all five seasons | CC BY 4.0 | nflverse contributors | Release-repository declaration |
| Participation 2021–2022 | CC BY-SA 4.0 | NFL NextGenStats via nflverse | Feed-specific declaration |
| Participation 2023–2025 | CC BY-SA 4.0 | FTN Data via nflverse | Feed-specific declaration |
| Schedule release | CC BY 4.0 | Lee Sharpe / nflverse | Repository declaration; upstream chain unresolved |

Sources: [pinned release license](https://github.com/nflverse/nflverse-data/blob/a78da18ca93f167bd0a2af274df48f539fa4153c/LICENSE.md),
[pinned participation loader and license](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R),
[official data-license overview](https://nflreadpy.nflverse.com/#license).
The participation-specific declaration takes precedence over the release root.
Preserve license, source URL, attribution and modification notices with derived
artifacts; record ShareAlike separately rather than treating all feeds as CC BY.
These are source-declaration findings, not independent proof of every upstream grant.

The schedule's upstream `nfldata` root has no explicit license file. The request
to [add one](https://github.com/nflverse/nfldata/issues/33) remains open. The
[commercial clarification](https://github.com/nflverse/nfldata/issues/35) was
closed as not planned with no maintainer answer. Closure is not a license grant.
The release declaration is recorded, but full schedule rights-chain confirmation
remains unresolved and cannot be reported as passed or as a commercial clearance.

## Availability and remaining external gates

All five weekly stats assets were updated in August 2026. The
[official availability schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
says 2023-onward participation is provided after the postseason. Neither proves
pregame availability for historical targets. Owner approved explicitly flagged
retrospective reconstruction; the strict point-in-time mode stays separate.

Current externally gated findings: GCS test not run (owner reports Spark;
Blaze upgrade, budget and a dedicated pipeline account are prerequisites); GCS
retention/create-once behavior not yet verified; Neon timeout not yet verified.
No app Firebase admin key, hosted database connection or Production command was used.
