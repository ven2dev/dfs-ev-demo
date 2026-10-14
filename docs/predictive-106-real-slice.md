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
Current allocation: preserve frozen 0001–0019, including #118's audited
invalidation migration frozen at `2aee941`. #106 reserves no further DDL.
Coordinate any new migration with #118 here.

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

## Schema-18 engineering checkpoint and real-proof remainder

The compressed route now includes atomic raw publication, guarded cutoff lookup,
explicit v3 normalization plans and execute-only binding/revision recording,
source decisions, numerical features and final labels, dataset/pin closure and
mandatory deletion. Combined #118 paging, label and complete-run readers are
integrated. Seven new PostgreSQL cases validate the whole synthetic path,
including 8,193 complete rows, independently expected values, earlier cutoffs,
forged plans, restricted roles, commit-time expiry and deletion with active pins.
The frozen prefix is 0001–0018; #118 owns 0019 for audited invalidation.

On 2026-10-14 the retained real 2025 player wire file was independently decoded
again in the isolated 256 MiB worker. All 19,422 ordinals were preserved: 19,400
typed projections and 22 explicit refusals. Peak RSS was 119,013,376 bytes.
Sixteen raw Hurts REG claims are present; `2025_18_WAS_PHI` remains absent. The
private report is `/private/tmp/dfs106-real-codec-schema18.json`. This diagnostic
grants no rights, publishes no claim/feature/label and proves no participation.

The original prototype journal referenced above is no longer present at its
temporary location, so its older inventory could not be reverified. Complete
2025 player/roster wire files remain; temporary storage is not a durable archive.
Historical journal proof must be recovered, or acquisition repeated with actual
new receipt times. No previous capture or database knowledge time may be invented.

The real-proof remainder is explicit: establish permitted research/model/label
uses; qualify canonical game/player/team mappings and profile links; obtain
independent 2024–2026 schedule coverage, dated membership/former-team coverage,
accepted independent completion evidence and official-stat reconciliation; and
resolve the Week 18 absence through real participation evidence. Then publish
and restore/replay the bounded real feature and final-label proof. Existing v1
history, 4/8/16 slot preservation and missing-data rules remain binding. #106
and #54 Part B remain incomplete; synthetic integration does not close them.

## Real-evidence intake checkpoint (2026-10-14)

The next increment is evidence qualification, not another schema expansion.
The existing [source-use decision](predictive-data-sources.md)
selects core nflverse statistics, schedules and roster observations for internal
research/modeling. Record that reviewed decision, attribution and exact source
versions in the appropriate profiles and use-specific rights records. A missing
runtime rights record is an implementation gap; it is not evidence that the
project has rejected this use. Public display, redistribution and optional
PFR/FTN feeds retain their separate restrictions. Official reconciliation
benchmark use remains conditional under the existing source decision.

| Gate | Evidence currently available | Next concrete acceptance step |
| --- | --- | --- |
| Original acquisition and restoration | Complete 2025 player/roster gzip files and release metadata remain; original prototype journal is missing | Recover the journal from an archive or reacquire missing inputs with actual receipt times. Verify full hashes and restore the resulting private bundle; do not reuse invented old knowledge times. |
| Internal source uses | Core nflverse internal research/modeling is selected in the source review | Carry the existing reviewed decision into feed-specific profiles and the research/model-input/outcome-label records required by each consumer. Do not extend it to other providers or public use. |
| Identity and membership | GSIS/raw game keys identify the proposed slice; current or weekly roster status alone is insufficient | Verify provider-to-canonical game/team/player mappings and profile links; qualify dated membership intervals and former teams against the actual schedule. |
| Schedule coverage | V1 requires target season and the previous two seasons | Acquire and independently verify 2024–2026 coverage for the target, own team, opposing offense and any former teams. Preserve all expected 4/8/16 slots. |
| Completion and reconciliation | Official pages supply discovery leads; no accepted independent completion or reconciliation record is present | Qualify permitted benchmark use, event/player identity, version/correction timing and independent completion evidence before recording decisions. |
| Week 18 participation | The player statistics file has no Hurts row for `2025_18_WAS_PHI` | Obtain accepted evidence of actual offensive participation or explicit DNP/absence; keep the slot unresolved until then. |
| Bounded real consumer proof | Schema-18 synthetic consumer path passes | After the preceding gates pass, publish the real feature/label evidence, restore it and independently replay the same values, provenance and missing slots. |

### Week 18 discovery result

Reviewed on 2026-10-14, the Eagles' [January 4 inactives report](https://www.philadelphiaeagles.com/news/eagles-commanders-inactvies-week-18-nfl-nfc)
says most starters were active despite being expected to rest. Hurts is not
listed among the seven Eagles inactives. The team's [Week 18 box score](https://www.philadelphiaeagles.com/game-day/2025/reg-week18/commanders-at-eagles/)
lists McKee as its passer. These observations explain why an active roster
status can coexist with a missing passing row; they establish neither Hurts'
offensive snap count nor an explicit DNP decision. No zero, absence, final label
or canonical participation record is derived from them.

This is a manual discovery note with URLs and review date, not a retained
provider-byte capture or approved automated ingestion route. Page publication
dates do not establish the project's original acquisition times. Gamebooks and
other official benchmarks still require the permitted-use and correction checks
in [the source review](predictive-data-sources.md). PFR snap counts remain
rejected for this predictive use without separate permission.

Validation for this documentation increment is link/contract consistency and
whitespace checking. No SQL, generated migration artifact, runtime behavior or
test changed, so a repeated full database gate adds no relevant evidence here.

## Fresh acquisition and private archive restoration (2026-10-14)

The existing credential-free bounded acquisition CLI reacquired the 2026
prototype inputs, completing at `2026-10-14T21:44:01.284Z`. It made 21 HTTP
requests, consumed 19,273,061 response bytes and finished in 5,713 ms. The six
complete files contain 54,808 rows: player 5,506; team 158; schedule 7,548;
identifiers 24,854; weekly roster 15,314; injuries 1,428. Depth charts remain
header-only under the existing 20 MB aggregate budget. No acquisition or parser
bound was raised. Measured process peak RSS was 401,195,008 bytes; this is the
legacy acquisition/verifier process, not the isolated 256 MiB gzip worker.

Journal SHA-256:
`f319cca7093bc033661b8f723da41b40d0968fd1cac1b8288b46984fcb6323cc`
(10,967 bytes). Verification checks every retained source/release digest and
recomputes qualification. The 15 exact-address journal/metadata/source files
were copied into a separately registered private root; restored verification
and QB inventory are byte-for-byte equal to their originals. The resulting
inventory digest is
`cf0d5b49d99bcc52f9e5e9157c3b1d9cb875e309450f9fd5fdeb48e31f2fb6db`.

The private durable archive is outside Git at
`/Users/vernonneilly/Documents/VN2DEV/dfs-ev-private-evidence/106/reacquired-20261014`.
Directories are owner-only and files are mode 0600. Its separate archive receipt
records actual acquisition/archive times, the reviewed internal research use,
mandatory-deletion precedence and maximum expiry `2027-01-12T21:44:01.284Z`.
Offline expiry is **manual**, not an automatic cleanup job or a database pin.
The durable root was independently reverified against the same journal. The
original temporary verification root is `/private/tmp/dfs106-reacquire-s2NwxW`;
the separate restoration root is `/private/tmp/dfs106-restored-6_0zof9d`.

The proposed Hurts/DAL target remains raw schedule context. Current prototype
raw passing pairs are 3/5/5 across 4/8/16 slots for the player, own team and
opposing offenses. These are not usable feature counts. The scheduled Week 6
games are still in the future at acquisition time and have no statistics in
this capture; keep their expected slots and refresh after completion. The new
archive does not recover the missing October 9 journal or its knowledge times.

The legacy inventory's `prior-season-publication-contract-unsupported` reason
describes that prototype's 2026-only CSV adapter. It does **not** revoke the
schema-18 qualified 2025 gzip publication/consumer path. Prior-season numerical
evidence must enter through that explicit versioned path, not by relabeling this
legacy journal or declaring separate 2025 files verified by its inventory.

Source restoration now passes; canonical identity, dated membership, independent
schedule coverage, accepted completion, permitted official reconciliation and
Week 18 participation remain unqualified. No database was accessed and no real
feature or final label was published. Validation was actual acquisition, three
independent archive-verification executions, exact restored inventory comparison
and documentation consistency/whitespace checks; no database suite was repeated.

## Prior-season raw numerical history checkpoint (2026-10-14)

Acquired the missing complete [2025 team statistics gzip](https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2025.csv.gz)
and its release metadata through a bounded, unauthenticated discovery probe.
Three HTTP requests consumed 901,360 bytes in 727 ms. The source was received at
`2026-10-14T22:32:55.241Z`; GitHub's release size and digest agree with its exact
76,602 wire bytes. SHA-256:
`5348409f099b285877641446e869dcda3179464584dd71f73becc087219b0383`.
Its complete decoded file is 229,660 bytes and 570 records; all 570 rows project
under the explicit 2025 compressed team contract with no refusal.

Reverified this file and the retained 2025 player file through the isolated
256 MiB workers, including complete wire hashes, release metadata, gzip/CRC,
headers, scope and ordinal-preserving claims. The player file retains 19,422
ordinals, with 19,400 typed projections and 22 explicit refusals. These are raw
claims, not canonical bindings. No filtered QB file substitutes for either
complete provider snapshot.

Combining their raw claims with the independently reverified current prototype
inventory improves the bounded history discovery:

| History | Raw passing pairs / expected slots at 4 | At 8 | At 16 |
| --- | ---: | ---: | ---: |
| Hurts | 3 / 4 | 6 / 8 | 14 / 16 |
| Own team | 3 / 4 | 7 / 8 | 15 / 16 |
| Opposing offenses | 3 / 4 | 7 / 8 | 15 / 16 |

The expected slots are unchanged. Player gaps are future `2026_06_CAR_PHI` and
unresolved `2025_18_WAS_PHI`; no zero, DNP or older replacement is inferred.
All 20 selected prior-season own-team/opposing-offense passing pairs agree with
sums over the complete player file's typed claims. This establishes **same-provider
consistency only**, not independent official reconciliation, complete population,
participation or accepted completion. The three-season schedule coverage rule
remains binding even though this target's last 16 raw slots span 2025–2026.

The original 2025 player/roster discovery files, metadata and provenance report,
and the new team files/report are now preserved outside Git at
`/Users/vernonneilly/Documents/VN2DEV/dfs-ev-private-evidence/106/prior-season-2025`.
Original capture times are preserved; archive times are separate. Private
receipts give manual maximum expiry dates no later than 90 days after the
earliest corresponding source capture, subordinate to mandatory deletion.
The archived `reproduce.mts` reconstructs this discovery from complete files;
the roster remains a retained discovery source, not a qualified membership
adapter. Neither the private archive nor the probe is a database retention pin.

Reconstruction from original temporary files and the durable archive gives
identical semantic evidence, digest
`1dbc63c0e6a0e35ad4aa014e2ad91f7c41295146dd2bf5318d41dce6f2e18e1d`.
Per-run RSS measurements are retained separately and excluded from that
identity. Validation uses real acquisition, full isolated-worker verification,
exact restored semantic comparison and documentation/whitespace checks. No
database was accessed; frozen 0001–0019 and Relay's SQL-capacity work remain
unchanged. Canonical identity/membership, independent coverage, completion,
official reconciliation and participation qualification still precede real
feature/label publication.
