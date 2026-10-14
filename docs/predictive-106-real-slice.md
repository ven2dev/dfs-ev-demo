# #106 first real QB slice: active scope and discovery checkpoint

Started 2026-10-13 on `feature/dfsEV-106-real-qb-slice` from merged main
`716d7559f6b3d402b098810efa5e6646f99e6709`. #106 remains in source/contract
qualification; no canonical real feature or final label has been published.

## Accepted scope

Retain existing `player-opponent-v1:player_pass_yds`, feature version
`passing-yards-source-v1`, label version `source-final-label-v1`, and
`qb-passing-history-three-season-v1`. The proposed 2026-only engineering candidate
is withdrawn. Existing source records and feature policy are unchanged.

The proposed proof is Jalen Hurts / GSIS `00-0036389`, PHI, against DAL at
`2026_07_DAL_PHI`. The retained source schedule and current official schedule
agree on October 26 at 20:15 Eastern (October 27 00:15 UTC). Proposed feature
cutoff is October 26 23:15 UTC. This is an inventory target, not a promise of
readiness or source truth. Qualify the current kickoff/membership and capture
all needed dependencies before that cutoff; a missed gate requires an explicit
new future target, never backdated acquisition.

For this target, independent schedule coverage spans 2024–2026; numerical
history is at most 16 expected REG games with separate 4/8/16 player, own-team
and opposing-offense summaries. All known former teams must be accounted for
when membership qualification discovers any; today's team is not historical
membership. Preserve genuine absences as slots and leave unknowns unresolved.
For a 2024 target, the same policy would require 2022–2024 schedule coverage.
Creator comparison horizon is not narrowed by this one-game engineering proof.

Handoff agreement: [#106/#118 contract at b7db281](https://github.com/ven2dev/dfs-ev-demo/blob/b7db281e156ac4decfd181e4d158ce912bef57e0/docs/predictive-training-handoff.md).
Relay owns training-read/dataset/pin runtime. This branch owns raw evidence,
qualified bridges/membership/completion, source consumers and the real slice.
Current allocation: preserve frozen 0001–0017; 0018 only is reserved for #106's
normalization/consumer increment. Coordinate any further DDL with #118 here.

## Executable inventory

`npm run predictive:qb-inventory -- ...` reuses the immutable prototype verifier
before examining source claims. It checks the original journal, referenced byte
sizes/digests, headers and restored qualification rather than trusting a JSON
report. The new pure inventory lists raw chronology, statistics/membership gaps,
season-support restrictions and independent evidence gates; it cannot publish
features/labels or promote claims into canonical evidence.

```sh
npm run predictive:qb-inventory -- \
  --artifact-root /private/tmp/dfs-ev-52-source-proof.utpDdL \
  --journal f496e74d6823d5507b301568d2c9c1dbc6f562fe93c8cbb52f621bd6674a5b31.json \
  --journal-bytes 10967 --player 00-0036389 --team PHI \
  --game 2026_07_DAL_PHI --cutoff 2026-10-26T23:15:00.000Z
```

The retained journal is observed 2026-10-09, not current or pre-2025 evidence.
Raw source values and inventories stay private outside Git. Discovery does not
require a database or provider account. App/database credentials are refused.

Observed raw pairs in this archive: player 2/4/4 across 4/8/16 horizons;
own team 2/4/4; opposing offenses 3/5/5. Each horizon retains exactly its
scheduled raw slots (4/8/16), including the missing recent and prior-season
rows; it does not move backwards to select a complete subset. These counts are
not qualified training samples, completion or participant counts. Independent
schedule completeness, dated membership/former-team coverage, canonical binding,
completion and official reconciliation are all unqualified.

The schedule source's `WC`, `DIV`, `CON`, `SB` codes are classified as POST for
inventory chronology and remain excluded from the selected REG numerical
windows. Raw schedule codes remain intact; this is not a production adapter
or a licence/identity qualification.

## Measured prior-season compatibility gates

Metadata inspection and a bounded public-source discovery probe found:

| 2025 source | Plain CSV metadata size | Complete compressed file size | Header versus registered 2026 profile |
| --- | ---: | ---: | --- |
| `stats_player_week_2025.csv` / `.csv.gz` | 8,656,387 | 1,262,421 | Same 150 columns, same order |
| `roster_weekly_2025.csv` / `.csv.gz` | 15,385,661 | 708,144 | Same 36 columns, same order |

Probe capture on October 13 used 6 HTTP requests, 2,956,042 consumed wire bytes
(including release metadata), and 1.584 seconds. Complete gzip bytes match the
GitHub release asset SHA-256 and size. The probe stopped decoded inspection at
the existing 8 MB boundary; it observed at least 8,193 rows in each source.
Decoded files are incomplete, not fully qualified imports. The current blob,
claim/parser and SQL row limits remain intact. No compressed source was inserted
into the database, and no new source rights/profile decision was fabricated.

Private evidence: `/private/tmp/dfs106-source-probe-lzpwbnwa/report.json` and
its referenced complete compressed/metadata files; exploratory probe script
`/private/tmp/dfs106-compressed-probe.py`. `/private/tmp` is not durable storage.
Only original compressed bytes and metadata were retained, with private modes;
partial decoded data was not published as an original provider file.

| Layer | Current restriction requiring a forward contract |
| --- | --- |
| Source asset/claim registration | Season 2026 only; exact registered parser/header/feed profile |
| Application claims | Full season-file CSV, no filtered source substitution; 8 MB / 8,192 rows |
| SQL source projection/guard | Explicit season 2026; fixed asset suffix; ordinal bound 8,192 |
| Private/SQL blob store | JSON or CSV UTF-8 only; 8 MB per blob, no binary gzip artifact |
| #118 protected-batch verification | Proposed 20 MB of unique private bytes; preserve rights/locking/closure |

Header parity alone does not approve 2025 source use, original historical
availability, membership effective bounds, correction finality or complete
population. Imported 2025 captures would be available now for a future target,
not retroactively at 2025 cutoffs.

## Next implementation decision

Two technically honest routes preserve v1:

1. **Compressed source artifacts, recommended for design review.** Retain exact
   gzip wire bytes with their own digest, a versioned bounded streaming decoder
   and decoded-content identity; qualify the necessary seasons and row schema.
   Keep decoder byte/row/memory/time limits independent from compressed size.
   Bind original source-record ordinals and validate complete snapshots, not a
   QB-filtered synthetic replacement. Extend binary artifact/SQL/reader contracts
   forward and coordinate codec/verification budgets with #118. Small wire size
   does not bypass decoded, row or CPU limits.
2. **Larger plain source artifacts.** Qualify a reviewed larger per-source blob/
   row policy and ensure aggregate budgets cover player plus roster and shared
   context. This is simpler media handling but costly for #118's 20 MB verification
   ceiling: those two complete 2025 CSVs alone total over 24 MB. Partitioning
   cannot silently lose required dependency validation or replace provider bytes.

No caps or schema have been raised in this checkpoint. Choose/review a concrete
codec, capacity and migration proposal before production-path integration. Do
not change the feature history policy to avoid this source-storage gate.

In parallel, qualify a permitted provider-final-status plus accepted independent
confirmer, independent PHI/DAL schedule enumeration, defensible dated membership
and official passing-yard reconciliation. A score, stats row, elapsed game time
or single terminal marker does not satisfy existing completion policy. Positive
usage may establish an individual claim through the recorded source decision;
missing/zero statistics and weekly ACT cannot create absent/zero participants.
Official gamebooks/box scores remain conditional uses. PFR remains rejected.

## Validation and QC reasoning

Six focused tests use hand-specified chronology/IDs, independent 4/8/16 counts,
a valid control, explicit contradictory-stat and exact-cutoff refusals,
REG/POST exclusion, order determinism, signed/zero preservation and missing newest
slots. ACT and positive raw usage explicitly remain unqualified here. The real
CLI independently restores the original journal before listing the inventory.
There are no database changes in this checkpoint; it cannot establish a usable
real model input or a qualified label. Required code checks are recorded after
running them; the full DB suite is reserved for changes to the publication path.

## References

- [Official PHI schedule](https://www.philadelphiaeagles.com/news/eagles-schedule-release-2026)
- [nflverse data timing](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
- [Player release metadata](https://api.github.com/repos/nflverse/nflverse-data/releases/tags/stats_player)
- [Weekly roster release metadata](https://api.github.com/repos/nflverse/nflverse-data/releases/tags/weekly_rosters)
- [Existing source/rights decisions](predictive-data-sources.md)
- [Existing feature/history contract](predictive-feature-contract.md)

Checkpoint verification: all 669 Node tests, typecheck (including readiness),
lint and whitespace checks pass. An isolated temporary copy first passed all
six new tests, then four single faults each caused failed assertions: dropping
the 16th slot, mixing POST into REG, using DAL's own offense as opponent context,
and accepting a feature cutoff exactly at kickoff. The working-tree source was
not mutated. This is selected assertion sensitivity, not exhaustive mutation
coverage or real-source qualification. The restored archive CLI also runs
successfully against the actual retained bytes; no DB test service was started.

## Complete compressed proof continuation

The [compressed-source contract](predictive-compressed-source-contract.md) now
records complete offline decoding and independent Python parity: 19,422 player
rows and 46,849 roster rows, matching the exact decoded CSV sizes from metadata.
The inspection-only codec streams with separate wire, decoded, row, record-byte
and time ceilings; existing publication/store limits and v1 remain unchanged.
No migration number was reserved and no binary publication path is active.

Full inspection also establishes a concrete dependency: `2025_18_WAS_PHI` has
no Hurts statistics claim, despite a weekly roster claim. Preserve its slot and
qualify explicit participation/absence evidence rather than infer a zero or DNP.

## Shared-prefix storage continuation

#106 has integrated #118's handoff at `42de9fb` and added forward migration
`0013_predictive_compressed_blob_staging.sql`; 0001–0012 remain unchanged.
The [integration handoff](predictive-106-118-integration.md) records the exact
prefix/hash and validation boundaries. Binary filesystem and SQL address/queue
handling now cover `.csv.gz`. Every compressed receipt uses the database clock,
including unknown synthetic parsers. Compressed captures remain incomplete;
raw claim and canonical publication bypasses are refused.

Next: a versioned complete-file codec envelope and qualified multi-season claims,
with guarded binary reads that retain #118's fresh-rights and stored-byte gates
and independently cap decoded work. Follow with compressed publication rollback,
restored retention, rights/deletion races and full consumer reconstruction tests.
The missing 2025 Week 18 participation/absence evidence and other real-source
qualification requirements above remain prerequisites for the selected real proof.
