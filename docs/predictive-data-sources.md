# Predictive data source qualification

Research date: 2026-10-05. This document is the Step 1 source decision for
[issue #49](https://github.com/ven2dev/dfs-ev-demo/issues/49). It qualifies
candidate inputs for later ingestion and model evaluation; it does not add an
ingestion job, choose a predictive model, or authorize a provider change.
The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/49#issuecomment-6002308058)
sets the three atomic documentation steps and downstream ownership.

## Existing live weather versus historical feature evidence

The app already obtains a kickoff forecast from Open-Meteo in
[`weather.ts`](../src/lib/weather.ts), independently of The Odds API's odds
requests. It returns temperature in Fahrenheit, wind in mph and precipitation
amount in mm. The shared live cache retains the latest inputs for refresh
coordination; it is not an immutable forecast history. #49 assesses capture
times, source versions and historical reconstruction needed for predictive
evaluation. It does not add live weather to the app or change its provider.
NWS, NOAA and MET Norway are qualification alternatives, not approved runtime
replacements.

## Scope and decision rules

The MVP independent baseline may use player usage and opportunity, injuries and
availability, role evidence, opponent context, schedule and venue facts, and
eligible non-market forecasts. It excludes player-prop probabilities, game
spreads, totals and moneylines, creator recommendations or confidence, and
closing prices or later market movement. Those values may be retained as a
separate comparison record, but they cannot enter the independent projection
through a `game environment` field. A future market-aware model must have its
own model version and evaluation in #54.
The queried prop line defines a question against the player-stat distribution;
it is not a feature for estimating that distribution.

The following dispositions are source-use decisions, not model-readiness
claims:

- **Selected:** the inspected evidence supports the named internal research use
  with the stated cutoff, identity and attribution controls. This does not
  select public display or establish model support.
- **Conditional:** the source is promising for the named use, but a listed
  verification gate must pass before ingestion or public display.
- **Deferred:** a viable alternative exists, or access, rights or history is
  unverified. No deferred source is treated as approved by implication.
- **Rejected:** the inspected terms or capability conflict with this MVP use.
- **Unavailable:** no approved route exists for the named use, such as bulk
  redistribution without separate permission.

Each source/use has one primary disposition. Timing is a separate qualifier:
**prospective-only** means forward capture does not establish old cutoffs;
**outcome/postgame-only** means the represented game's values cannot predict
that same game before kickoff. A selected forward-capture source can therefore
have a separate conditional historical use. Public-use decisions are recorded
separately from internal-use decisions below.

An archive's season/week, file update time, model initialization, or current
value does not prove that the value was publicly available at an earlier
analysis cutoff. A strict historical feature requires an observation or capture
time, availability evidence, source version, identity bridge, and correction
lineage. When those are absent, the feature is prospective-only or exploratory
historical data and must be labeled accordingly.

All checks below were bounded, read-only public checks. No provider account,
paid request or production credential was used. Annual public CSV samples and
selected GRIB messages were downloaded outside the checkout. Inspection tooling
and raw artifacts remain outside Git; no project dependency was added.

The source-use dispositions below differ from Step 2's five per-market readiness
dispositions. Neither is a claim that #54 has validated model support.

## Source matrix

| Candidate and fields | Identifiers and coverage | Timing, corrections and reliability | Cost, rights and public display | Qualified internal use and disposition |
| --- | --- | --- | --- | --- |
| **nflverse weekly player statistics**: attempts, completions, TDs, interceptions, targets, carries and receptions (integer counts); passing/rushing/receiving yards (integer yards); target share (fraction) | `player_id` (GSIS), `game_id`, team/opponent, season/type/week; current releases include 2026 and historical seasons | Latest revised postgame values; no per-field availability/revision history. Derived statistics aim to match official box scores; reconciliation still required. | $0; CC BY 4.0 repository notice and underlying-owner boundary below; public raw-stat/commercial derived display conditional. | **Selected**: forward-captured lagged statistics (prospective-only). **Selected**: practical label feed (outcome-only), with Step 2 finalization/reconciliation rules. **Deferred**: strict old predictor versions without a verified version archive. |
| **nflverse weekly team statistics**: aggregate attempts/carries/targets (counts), yards, and derived opportunity/efficiency rates with explicit denominators | `game_id`, team/opponent and season/type/week; current and historical releases | Latest revised aggregates; target-game results cannot enter its earlier cutoff. Plays/game is not situation-neutral pace. | $0; nflverse rights boundary below; public raw-stat/commercial derived display conditional. | **Selected**: forward-captured lagged team/opponent context (prospective-only). **Deferred**: strict old predictor versions. Target-game values are postgame-only. |
| **nflverse play-by-play**: `posteam`, `defteam`, `play_type`, game/quarter clock seconds, `score_differential`, `down`, distance and play outcomes | `game_id`, `play_id`, season/type/week, team/player identifiers; documented back to 1999 | Clean files refresh after game days, with extra game-day updates and Wednesday-to-Thursday stat-correction refreshes. Published seasons contain later corrections, not immutable cutoff history. | $0; nflverse rights boundary below; public raw/derived display conditional. | **Selected**: forward capture of prior-game play context for internal pace/opponent research (prospective-only). **Selected**: represented-game postgame analysis (outcome/postgame-only). **Conditional**: historical pregame features pending version/availability evidence. Step 2 decides situation-neutral pace's MVP role. |
| **nflverse schedules and identifiers**: event, kickoff, teams, location, roof and stadium metadata | Game identifiers, season/type/week, teams and kickoff context; schedules mix pregame and postgame columns | Scheduled kickoff can anchor a cutoff. Results, starters, realized weather and closing market fields are later-known; reschedules require event remapping. | $0; nflverse rights boundary below; public raw/derived display conditional. | **Selected**: forward-captured event identity/scheduled context for research. **Conditional**: actual venue/roof predictors and historical scheduled context pending earlier versions, neutral/international handling and identity checks. **Rejected**: postgame columns as same-game pregame inputs. |
| **nflverse current/season rosters and player identifiers**: latest roster and GSIS crosswalk | GSIS/provider identifiers; latest season membership | Current roster does not prove historical team membership or role at an old cutoff. | $0; nflverse rights boundary below; no selected public identifier/stat display. | **Selected**: current identity lookup for internal research. **Rejected**: today's membership as evidence for an old event; use the separate weekly-roster candidate. |
| **nflverse weekly rosters**: season, `week`, `game_type`, team, position, `status` and provider crosswalks | Documented back to 2002; `gsis_id`, `espn_id`, `pfr_id`, `sportradar_id` and other provider IDs | Week-level membership/status supports dated joins, but weekly grain proves neither original publication time nor unchanged old IDs/status. Roster status is not automatically game-day active status. | $0; nflverse rights boundary below; public raw/derived display conditional. | **Selected**: forward-captured dated membership/identity research (prospective-only). **Conditional**: historical player/team joins and cutoff status pending correction/availability and bridge checks. |
| **nflverse depth charts**: position/slot/rank (ordinals), `dt`, ESPN/GSIS IDs | 2025 sample: 221 timestamps, all 32 teams each time; legacy weekly schema through 2024 | `dt` is load time. Pipeline retains old ranks but refreshes GSIS mappings/cleans old names; gaps and missing GSIS IDs exist. | $0; nflverse rights boundary/feed-specific terms; public raw/derived display conditional. | **Selected**: forward-captured role observations for internal research (prospective-only). **Conditional**: bounded historical ranks pending identity/availability checks. **Deferred**: pre-2025 strict timing. |
| **nflverse injuries**: practice/report status (categories), injury text, team/week/GSIS | Current releases contain 2025/2026; season/type/week rows | No report-publication/revision timestamp. A missing/blank row is not healthy or cleared. | $0; nflverse rights boundary; public status display conditional on rights, freshness and semantics. | **Selected**: immutable forward-captured status observations for internal research (prospective-only). **Deferred**: strict historical reconstruction. Not a stat/participation outcome label. |
| **nflverse snap counts**: snaps (count), share (fraction) | PFR player/game IDs, season/type/week; documented from 2012; explicit GSIS/PFR bridge needed | Realized participation is postgame; lagged predictors require the earlier version's availability. | $0; underlying PFR retention/display rights unverified. | **Conditional**: internal lagged/participation research pending PFR rights, bridge and availability checks. **Rejected**: target-game pregame participation. Public display **Deferred** pending PFR-specific rights. |
| **NWS current API**: hourly temperature, wind and precipitation forecast | Venue coordinates/kickoff; U.S. coverage | Seven-day current forecast. Identifying `User-Agent` required; honor caching headers. Fixed public rate limit unpublished. Retain issue/valid times. | $0, open for any purpose; API page imposes no display-credit requirement. Source credit may be project policy. | **Conditional**: U.S. venue predictors pending capture/roof/venue checks (prospective-only). **Unavailable**: historical replay through the current API. |
| **NOAA NDFD archive**: temperature (K), wind (m/s), 12-hour precipitation probability (%) | Cloud archive from 2020-04-16; nine message samples at one CONUS venue across 2021/2023/2025 | ecCodes produced plausible values; independent decoder validation remains open. Issue/header time, GRIB reference, valid interval and archive receipt differ. Coverage/first-public-availability unproven. | $0 provider fee; public reuse, NOAA credit requested, no implied endorsement; label modifications. | **Conditional**: historical forecast predictors. Recommended-decoder cross-check, nonzero PoP scaling, multiple venues/lead times, in-domain missingness, availability and coverage gates remain open. |
| **MET Norway Locationforecast**: temperature (°C), wind (m/s), precipitation amount (mm) | Global current coordinates; London sample below | No global historical forecast replay. Capture `updated_at`/per-field intervals; sampled compact response has no precipitation probability. | $0, CC BY 4.0/NLOD attribution/traffic rules; no SLA. | **Conditional**: forward temperature/wind/amount predictors pending capture/venue checks (prospective-only). **Unavailable**: historical replay through this API. Do not infer probability from amount. |
| **Open-Meteo**: existing kickoff forecast, historical model/reanalysis products | Coordinates/model/run metadata; existing path uses temperature/wind/precipitation amount, not probability | Existing path retains no issue/revision history. Initialization is not public availability; reanalysis is not an earlier issued forecast. | Free service non-commercial; commercial product use requires paid or qualified self-hosted route. | **Conditional**: new forward feature capture for a non-commercial pilot. **Deferred**: new commercial or strict historical feature use. Existing live integration is not changed by #49. |
| **NOAA GFS archive**: global model grids | Global coverage; international venue/run/product identity needs separate qualification | Docs checked, payload not decoded. Units, accumulation intervals and availability need a separate probe. | Public NOAA reuse conditions; operations costs separate from provider fees. | **Conditional**: historical global alternative. NDFD's exploratory samples do not qualify GFS by analogy. |
| **ScoreTape injury change log**: capture-timestamped status history/reconstruction | Provider athlete identity/capture timestamp; explicit GSIS bridge required | Docs describe forward capture/latest row at or before cutoff. Explorer history seven days; earliest NFL coverage, completeness, clearance/removal behavior and payload semantics unverified. | Research/modeling terms; bulk redistribution prohibited without permission. Retention/public derived-display rights unverified. | **Conditional**: forward injury predictors pending authenticated payload, identity, semantics and retention checks. **Deferred**: wider historical reconstruction and public display. No key requested. |
| **BALLDONTLIE NFL injuries** | Provider identity; historical join/arbitrary-cutoff revisions not established | Injury access paid; inspected docs do not prove multi-season revision archive. | Paid access; commercial/public rights need plan/terms review. | **Deferred**: paid upgrade, not a free MVP source. |
| **SportsDataIO**: final revised stats/game-start injuries | Commercial provider IDs; bridge needs qualification | History guide describes final revised stats/game-start injuries, not midweek changes or historical depth charts. | Quote-based; Discovery Lab personal/non-commercial. | **Rejected**: MVP point-in-time injury/depth use; paying does not fix missing cutoff contract. |
| **Sportradar**: historical weekly injuries | Provider IDs/historical weekly coverage | Arbitrary intraweek replay/correction timing unverified. | Paid quote/commercial rights review required. | **Deferred**: paid upgrade pending precise replay/rights demonstration. |
| **NFLMeta**: public NFL data wrapper | Provider IDs; wrapper does not prove independent revisions | Injury data substantially nflverse-derived; independent capture history unestablished. | Free non-commercial; commercial paid. | **Deferred**: wrapper cannot qualify independent timestamps or public product rights. |
| **API-Sports**: advertised free request tier | Provider IDs/history need qualification | 100 free requests/day does not prove arbitrary-cutoff revisions. | Terms do not grant publication/commercial competition rights. | **Rejected**: public-product selection despite free access. |
| **FTN participation/charting through nflverse**: optional personnel/routes/charted plays | Source-specific game/play/player bridges | Participation from 2023 onward published after postseason; charting subset from 2022 charted within 48 hours after games. Distinct feeds/delivery schedules. | Charting CC BY-SA 4.0 with FTN-via-nflverse credit; share-alike compatibility needed for shared adapted datasets/outputs. Attribution alone is insufficient. | **Rejected**: delayed participation for current-season lagged use. **Deferred**: optional charting pending timestamps, source-specific rights and share-alike compatibility review. |
| **Official NFL gamebooks / NFL.com box scores**: official player totals, summary, active/DNP information | Official game/event/team identity; names/jerseys require GSIS bridge | Postgame reconciliation benchmark candidate; original gamebook does not prove final corrections. Version/date/discrepancy handling required. | Public viewing documented; sampled gamebook has media-use notice requiring written permission for other uses. Project-use, automated ingestion/redistribution rights unverified. | **Conditional**: manual official-stat reconciliation benchmark pending permitted-use/correction checks. **Unavailable**: automated ingestion/redistribution without separate clearance. nflverse remains practical label feed. |
| **Sportsbook markets and creator data**: prop probabilities, spreads/totals/moneylines, recommendations/confidence, closing movement | Existing bookmaker/creator identities | Separate comparison/evidence records; later movement/closing values are future information at earlier cutoff. | Existing provider/creator policies apply. | **Rejected**: independent-baseline features. Future market-aware/creator models require separate versioned evaluation in #54/#53. |

Primary field/semantics evidence: [player stats](https://nflreadr.nflverse.com/reference/load_player_stats.html),
[team stats](https://nflreadr.nflverse.com/reference/load_team_stats.html),
[play-by-play](https://nflreadr.nflverse.com/reference/load_pbp.html),
[PBP dictionary](https://nflreadr.nflverse.com/articles/dictionary_pbp.html),
[weekly rosters](https://nflreadr.nflverse.com/reference/load_rosters_weekly.html),
[depth dictionary](https://nflreadr.nflverse.com/articles/dictionary_depth_charts.html),
[schedules](https://github.com/nflverse/nfldata/blob/master/data/games.csv), and
[snap counts](https://nflreadr.nflverse.com/reference/load_snap_counts.html).
The [schedule dictionary](https://nflreadr.nflverse.com/articles/dictionary_schedules.html)
defines `gametime` as kickoff in 24-hour Eastern time, regardless of venue.
Combine it with `gameday` and convert using `America/New_York`, including DST;
do not treat that field as UTC or generalize its timezone to all timestamps.
Current historical roof, venue or roster values need earlier-version
evidence before becoming pregame features.
The [upstream update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
describes after-game play-by-play/statistical updates and a Wednesday-to-Thursday
correction refresh, frequent schedule refreshes, daily roster/depth/injury
updates and periodic PFR updates.
These are intended schedules, not measured delivery latency or service guarantees.
Paid candidates have no verified project-specific latency or SLA without an
authenticated feed/contract.

### Access, rate limits, cost and rights

| Source | Public fee/limit evidence on review date | Reliability and rights boundary |
| --- | --- | --- |
| nflverse release feeds | $0, no key; GitHub unauthenticated REST metadata 60 requests/hour plus secondary limits; asset downloads do not use that primary REST quota | Cache/change detection and bounded retries; upstream schedules are not an SLA. Data repo publishes CC BY 4.0; preserve source/license/change notices and feed-specific exceptions. |
| NWS | $0, open for any purpose; numeric rate limit unpublished | Identifying User-Agent, caching, bounded retries; prospective source, no historical replay. |
| NOAA NDFD/GFS | $0 provider fees; fixed request quota/SLA not established | Range downloads and bounds required; public reuse, requested credit, modified-data notices and no implied endorsement. |
| MET Norway | $0; over 20 requests/second per application requires agreement | Honor expiry, `If-Modified-Since`, identifying User-Agent and ≤4 decimal coordinate precision; CC BY/NLOD credit/change notices; no SLA. |
| Open-Meteo free API | Non-commercial; <10,000/day, <5,000/hour, <600/minute; terms also list a monthly allowance | Attribution required; a public free demo's qualification differs from a revenue-producing product. No new paid/self-hosted setup here. |
| ScoreTape | Explorer $0, 1 request/second, seven-day history; larger history paid | Documentation-only qualification; completeness, clearance, indefinite retention and public derived display remain unverified. |
| BALLDONTLIE | Injury endpoint starts at $9.99/month ALL-STAR, 60 requests/minute; free 5/minute tier excludes injuries | Authenticated NFL payload/revision behavior and public retention/display rights unverified. |
| SportsDataIO / Sportradar | Commercial quote/entitlement; rate quotas not established for this project | Contract-specific display/retention/attribution; no claim a paid account fixes missing revision history. |
| NFLMeta | Free non-commercial: 5,000 requests/month, 20/minute, 25,000 rows/month; new-key activation requires card verification. Builder commercial tier advertised $12/month. | Wrapper convenience does not establish independent revision history or eliminate underlying source attribution. |
| API-Sports | Free allowance advertised as 100 requests/day | Terms do not grant publication/commercial competition rights; unselected for the public product. |

Supporting [NWS service terms](https://www.weather.gov/documentation/services-web-api),
[NOAA reuse terms](https://registry.opendata.aws/noaa-ndfd/),
[MET traffic rules](https://api.met.no/doc/TermsOfService),
[Open-Meteo terms](https://open-meteo.com/en/terms),
[ScoreTape plans](https://scoretape.com/docs),
[BALLDONTLIE tiers](https://nfl.balldontlie.io/),
[NFLMeta quotas](https://nflmeta.org/pricing), and
[API-Sports rights](https://api-sports.io/terms) apply to the named use only.
The [API-Sports public offer](https://api-sports.io/) documents the advertised
100-request/day free allowance; that access allowance does not grant display rights.

The [data repository license](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md)
is CC BY 4.0, distinct from package MIT licensing. The
[nflverse ownership statement](https://nflverse.nflverse.com/#terms-of-use)
places underlying NFL data under their owners' terms. The
[CC BY scope](https://creativecommons.org/licenses/by/4.0/legalcode.en#s2)
grants only rights the licensor has authority to grant. The repository notice
therefore does not settle every downstream display or commercial use.

| nflverse use | Primary disposition | Boundary / evidence needed |
| --- | --- | --- |
| Internal research/modeling with player/team statistics, play-by-play, schedules and roster/role/status observations | **Selected** | Preserve attribution, source/license/change notices and versions; use the matrix's timing/identity controls. This is a project research decision, not blanket underlying-owner clearance. |
| Internal PFR snap-count research | **Conditional** | Resolve PFR-specific retention/use terms before selection. |
| Internal FTN charting enrichment | **Deferred** | Optional scope; resolve source-specific use terms and share-alike compatibility before selecting an integration. |
| Public raw-stat, identifier, roster or status display from the core nflverse candidates | **Conditional** | Clarify underlying-owner/feed permissions and freshness/semantics; attribution alone does not close the gate. |
| Public derived display from the core nflverse candidates, including commercial projections or derived statistics | **Conditional** | Clarify rights for the specific outputs and commercial use before launch; a transformation does not automatically grant display rights. |
| Public PFR/FTN raw or derived display | **Deferred** | Separate source-specific terms/share-alike qualification; the core-feed decisions do not select these optional displays. |
| Bulk redistribution of source artifacts or reconstructed datasets | **Unavailable** | No approved redistribution route for this project without separate rights qualification and owner approval. |

Images/logos are not covered by a selected statistical use. PFR/FTN permissions
must be evaluated separately. For FTN charting, the
[CC BY-SA terms](https://creativecommons.org/licenses/by-sa/4.0/)
require compatible licensing when sharing adapted material. Determine whether a
proposed derived dataset/output is adapted material and how share-alike applies
before combining it with a proprietary public product; do not assume credit
alone is sufficient or that every model automatically inherits the license.

NWS's API page permits public reuse and requires an identifying User-Agent;
it does not state a display-attribution requirement. NWS source credit is an
optional project policy, separate from access behavior. NOAA requests credit
and labels for modifications; MET Norway requires license attribution/change
notices. Open-Meteo public use depends on the non-commercial/commercial access
choice. Technical forecast gates remain separate from these rights decisions.

## Direct findings and workload references

The following bounded samples were inspected from public nflverse releases. They
are reference workloads, not a production sizing decision:

| 2025 artifact | Bytes | Rows | Regular-season rows |
| --- | ---: | ---: | ---: |
| Weekly player statistics | 8,656,387 | 19,422 | 18,540 |
| Weekly team statistics | 229,660 | 570 | 544 |
| Injuries | 696,006 | 6,068 | 5,783 |
| Snap counts | 2,401,290 | 26,613 | 25,396 |

The player file has 6,108 regular-season rows in the QB/RB/WR/TE
`position_group` values, including 71 FB rows in the RB group. Filtering exact
`position` values instead yields 6,037 rows. Five 2021–2025
player files total approximately 42.3 MB uncompressed. The measured
`depth_charts_2025.csv` is 52,917,870 bytes (52.9 MB); the separately inspected
2026 release asset, `depth_charts_2026.csv`, is 57,941,923 bytes (57.9 MB).
The latter is release-metadata size, not the 2025 downloaded sample.
Storing the full mutable file on every revision would duplicate data
unnecessarily. Step 3 will estimate selected
normalized rows, revision artifacts, manifests, indexes, bandwidth and compute
separately.

Reproduction paths under
`https://github.com/nflverse/nflverse-data/releases/download/` are
`stats_player/stats_player_week_2025.csv`, `stats_team/stats_team_week_2025.csv`,
`injuries/injuries_2025.csv`, `snap_counts/snap_counts_2025.csv` and
`depth_charts/depth_charts_2025.csv` (also the corresponding 2024 depth file).
Count parsed records, not physical lines; CSV fields can contain quoted commas
or newlines. Player/team/injury files use `season_type`; snaps use `game_type`.
These filters do not narrow the registry's supported position set.

| Inspected artifact | SHA-256 |
| --- | --- |
| `stats_player_week_2025.csv` | `e5e0615b3d96a3eaebfaee91e55afb4a4e7fe0caf057454177bcd7d6ad4bcfc2` |
| `stats_team_week_2025.csv` | `91058a59d894855377b2f39f40c4e7bdbeef96d12144289dc68215209a1c93cb` |
| `injuries_2025.csv` | `873ca1606dd575bd01152508a243ef6b3a0f8f97b90b707217e62ee8c7ceb735` |
| `snap_counts_2025.csv` | `3fc2deb0e9ad86d34d4578cb80bb21c95253e088ee22ca028adf46f7485eff1f` |
| `depth_charts_2025.csv` | `f5a4aa3fa70150e810b2255200c8735a6c1cc8ff77361308ce39149345b39b4a` |
| `depth_charts_2024.csv` | `f210a33774611f7f78a89af789b61c6289a2631a21227a1a3c63c973c23588b7` |

Exact row-count/hash reproduction used Python 3.13.7 and its standard-library
`csv.DictReader`, with UTF-8 BOM handling and CSV newline handling. Download the
public files to these temporary paths, then run:

```bash
python3 --version
python3 - <<'PY'
import csv
import hashlib
from pathlib import Path

positions = {"QB", "RB", "WR", "TE"}
for sample in ("player-2025", "team-2025", "injuries-2025", "snaps-2025",
               "depth-2025", "depth-2024"):
    path = Path(f"/private/tmp/dfs-ev-49-{sample}.csv")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    rows = regular = groups = exact_positions = 0
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        type_field = next((key for key in ("season_type", "game_type")
                           if key in reader.fieldnames), None)
        for row in reader:
            rows += 1
            if type_field and row[type_field] == "REG":
                regular += 1
                groups += row.get("position_group") in positions
                exact_positions += row.get("position") in positions
    print(sample, {"bytes": path.stat().st_size, "rows": rows,
                   "REG": regular if type_field else None,
                   "sha256": digest})
    if sample == "player-2025":
        print({"REG_position_group_QB_RB_WR_TE": groups,
               "REG_position_QB_RB_WR_TE": exact_positions})
PY
```

Changed artifacts require a new evidence record rather than silently rewriting
the historical findings here.

## Required verification gates

These gates keep a promising source from being mistaken for a qualified one.

### NOAA forecast archive

Nine selected GRIB2 messages were inspected using temporary ecCodes Python
bindings 2.49.0 / decoder library 2.48.0 outside the project. Unsigned S3
listings plus small header/range requests retrieved complete temperature/wind
messages valid at kickoff and a PoP12 interval covering kickoff. No project
dependency changed.

**ecCodes produced plausible sample values; independent decoder validation
remains open.** The [NOAA archive documentation](https://registry.opendata.aws/noaa-ndfd/)
warns that some decoders mishandle NDFD's grid scanning pattern and recommends
`grib2io`, `degrib` or `wgrib2`. No recommended decoder was used in this probe.
The results below are exploratory observations, not a passed decoding gate.

All three actual home games use Lincoln Financial Field at
`39.90083333,-75.1675`, with 13:00 Eastern / 17:00 UTC scheduled kickoffs. The
decoded nearest CONUS grid point is `39.89137275,-75.16819504`, 1.054 km away.

| Source game | Kickoff UTC | ecCodes temperature | ecCodes wind | PoP12 interval/raw value |
| --- | --- | ---: | ---: | --- |
| `2021_02_SF_PHI` | 2021-09-19T17:00:00Z | 298.7 K / 25.55 °C | 3.1 m/s | 12:00Z–next-day 00:00Z / 0 |
| `2023_04_WAS_PHI` | 2023-10-01T17:00:00Z | 298.1 K / 24.95 °C | 3.6 m/s | 12:00Z–next-day 00:00Z / 0 |
| `2025_03_LA_PHI` | 2025-09-21T17:00:00Z | 295.4 K / 22.25 °C | 3.1 m/s | 12:00Z–next-day 00:00Z / 0 |

Temperature/wind are instantaneous values. PoP12 is the
[12-hour precipitation probability](https://digital.weather.gov/staticpages/definitions.php),
not amount or hourly probability. ecCodes returned generic PoP name/units as
`unknown`; the intended percent interpretation comes from the NDFD product and
[encoding documentation](https://graphical.weather.gov/docs/grib_design.html).
All three raw PoP values are zero, so they cannot validate numeric scaling.
Every sampled PoP message has template 4.9, discipline 0, category 1, parameter
8, probability type 1 and upper threshold 254 × 10^-3. Future decoding must
validate the product fingerprint and retain the interval, rather than infer a
unit from an unknown decoder label.

Prepend `https://noaa-ndfd-pds.s3.amazonaws.com/wmo/` to these reproduction paths.
Ranges are inclusive complete GRIB messages:

| Object path | Byte range | Archive `LastModified` UTC |
| --- | --- | --- |
| `temp/2021/09/19/YEUZ98_KWBN_202109190020` | 16238913–17204899 | 2021-09-19T00:22:46Z |
| `wspd/2021/09/19/YCUZ98_KWBN_202109190020` | 19295316–20444928 | 2021-09-19T00:22:47Z |
| `pop12/2021/09/19/YDUZ98_KWBN_202109190019` | 460969–915133 | 2021-09-19T00:22:43Z |
| `temp/2023/10/01/YEUZ98_KWBN_202310010020` | 16172239–17129363 | 2023-10-01T00:23:36Z |
| `wspd/2023/10/01/YCUZ98_KWBN_202310010020` | 19644428–20823896 | 2023-10-01T00:23:37Z |
| `pop12/2023/10/01/YDUZ98_KWBN_202310010020` | 428909–834787 | 2023-10-01T00:23:34Z |
| `temp/2025/09/21/YEUZ98_KWBN_202509210016` | 16036879–16980631 | 2025-09-21T00:22:19Z |
| `wspd/2025/09/21/YCUZ98_KWBN_202509210016` | 18468100–19579109 | 2025-09-21T00:22:21Z |
| `pop12/2025/09/21/YDUZ98_KWBN_202509210016` | 443382–899725 | 2025-09-21T00:17:15Z |

All GRIB reference times are 00:30Z, distinct from earlier WMO header and archive
receipt times. These samples predate an illustrative 06:00Z analysis cutoff;
they must be rejected at 00:10Z. Reference/filename alone misses later receipt
or overwrite time. Archive metadata provides receipt evidence, not independent
proof of first public publication, unchanged historical bytes or access policy.
Independent decoder validation, strict availability and full event/lead-time
coverage remain open. Neither nominal home-team venue nor current roof state
qualifies neutral/international/relocated events without earlier evidence.

Negative checks: listing `wmo/temp/2019/09/08/` returned `KeyCount=0`; this does
not rule out older non-cloud NOAA archives. Querying the CONUS sample at
Tottenham (`51.6043,-0.0664`) returned missing value 9999 at a point over 4,147
km away. Reject missing/off-domain points; nearest lookup alone is insufficient.
This demonstrates domain rejection, not ordinary missing-value handling within
CONUS. The in-domain missing-data gate has not been tested.

Before selecting NDFD forecast features, record all of these checks:

1. Cross-check at least one temperature, wind and PoP value and its grid location
   with a NOAA-recommended decoder, recording its version and artifact hashes.
2. Include a nonzero PoP sample to verify percent scaling and the 12-hour interval.
3. Test at least two actual in-domain venues. All current samples use Philadelphia.
4. Test at least two lead times, including an early-week and near-kickoff forecast.
   All current samples have approximately 16.5 hours of reference-to-kickoff lead.
5. Exercise a missing message or value within the supported domain and prove it
   remains missing rather than becoming zero or an off-grid substitute.
6. Qualify cutoff availability/version provenance and the intended historical
   event coverage. Correct decoding alone does not establish these.

Example reproduction in a temporary environment (public request, no credential):

```bash
curl --fail --silent --show-error --range 16036879-16980631 \
  https://noaa-ndfd-pds.s3.amazonaws.com/wmo/temp/2025/09/21/YEUZ98_KWBN_202509210016 \
  -o /tmp/ndfd-temperature-sample.grib
```

```python
import eccodes as ec

with open("/tmp/ndfd-temperature-sample.grib", "rb") as sample:
    message = ec.codes_grib_new_from_file(sample)
try:
    print({key: ec.codes_get(message, key) for key in
           ["units", "dataDate", "dataTime", "validityDate", "validityTime"]})
    print(ec.codes_grib_find_nearest(message, 39.90083333, -75.1675, npoints=1))
finally:
    ec.codes_release(message)
```

That message's SHA-256 is
`e5ebf3147488c213d27b66da7fb51f2445ec5024f9e38f518f64a0189cf86d46`.
The nine selected messages total approximately 7.6 MB, plus small listings and
header ranges. This is a bounded ecCodes probe; it does not validate independent
decoding, precipitation scaling or exhaustive backfill.

### Current forecast alternatives

An identifying research User-Agent linking to this repository was used for one
public NWS point/grid sample and one MET Norway compact sample. NWS at Lincoln
Financial Field resolved `PHI/50,76`; grid `updateTime` was
`2026-10-05T20:10:28+00:00`. Sample units were °C, km/h, precipitation % and mm,
with different `validTime` intervals by field.

The MET request at Tottenham returned
`updated_at=2026-10-05T19:19:25Z`, forecast times through
`2026-10-15T00:00:00Z`, and an hourly sample of 17.8 °C, 2.6 m/s wind and 0 mm
next-hour precipitation. Its compact metadata did not include precipitation
probability. An amount/probability fallback is not equivalent; Step 2 must
name different features or withhold the missing one. These current samples
prove payload units, not historical replay or service uptime.

### Pace and opponent play context

The [play-by-play loader](https://nflreadr.nflverse.com/reference/load_pbp.html)
documents history back to 1999; the
[dictionary](https://nflreadr.nflverse.com/articles/dictionary_pbp.html)
includes possession/defense, play type, game/quarter clock seconds, score
differential, down and distance. These fields support derived lagged pace and
opponent opportunity/efficiency candidates. Their existence does not select a
particular situation-neutral filter, denominator or model. Step 2 must decide
whether that candidate is MVP-worthy and define exclusions such as clock
stoppages, kneels, spikes and possession changes before calling it pace.

The represented game's plays are outcome/postgame-only. For a later game,
forward capture can retain the prior-game artifact, availability time and
correction lineage. Existing revised season files remain conditional for
historical predictors. The intended after-game updates and Wednesday-to-Thursday
correction refresh do not prove which version existed at an old cutoff.
This qualification is documentation-based; no annual PBP payload was measured.

Use an explicit non-market field allowlist. PBP also contains `spread_line`,
`total_line` and market-aware fields such as `vegas_wp`; their presence in the
same artifact does not make them eligible for the independent baseline.
Public raw/derived display follows the separate nflverse rights decisions.

### Weekly membership and identity evidence

The [weekly-roster loader](https://nflreadr.nflverse.com/reference/load_rosters_weekly.html)
documents seasons back to 2002, separate from the latest season roster. Its
season/week/game-type/team/status fields and GSIS/provider IDs support dated
membership and identity research. A week-level row is not an immutable
publication snapshot, and roster status is not a confirmed game-day active list.

Forward capture is selected for internal research. Historical player/team joins
remain conditional: verify original availability, later corrections, traded or
multi-team player handling, missing IDs and the versioned provider bridge.
Normalize `game_type` to the event's season-type contract rather than assuming
all feeds name it alike. No name-only joins or modern crosswalk replacements
may silently resolve old events. This qualification is documentation-based;
weekly-roster payload coverage and original-version behavior remain unmeasured.

### Timestamped role data

The [dictionary](https://nflreadr.nflverse.com/articles/dictionary_depth_charts.html)
defines `dt` as record load time. Parsed public samples establish:

| Artifact | Bytes / rows | Timing findings |
| --- | --- | --- |
| `depth_charts_2024.csv` | 3,391,616 / 37,312 | Weekly legacy schema; no load timestamp |
| `depth_charts_2025.csv` | 52,917,870 / 554,215 | 221 UTC timestamps, all 32 teams each; 2025-08-03T10:09:07Z through 2026-03-14T07:32:09Z; 5,577 rows without GSIS ID |

No sampled load date exists on 2025-08-04/05/06, 2025-12-13 or 2026-01-18.
Those are file gaps, not proof that no upstream chart changed. The PIT QB slot
has a real revision, compared by stable ESPN identity:

| Load time UTC | ESPN ID | Player | Rank |
| --- | --- | --- | ---: |
| 2025-08-29T07:14:32Z | 4036419 | Skylar Thompson | 3 |
| 2025-08-29T07:14:32Z | 4429955 | Will Howard | 4 |
| 2025-09-11T11:37:43Z | 4036419 | Skylar Thompson | 4 |
| 2025-09-11T11:37:43Z | 4429955 | Will Howard | 3 |

The [pipeline at inspected commit `72aba7a`](https://github.com/nflverse/nflverse-rosters/blob/72aba7add6996a9b5775e1559cdf6f05aeb4733a/exec/update-depth-charts.R)
appends observations but reapplies current ESPN→GSIS mappings and name cleanup
to old rows. Ranks are retained; not every original field is immutable. Preserve
raw ESPN identity and a separately versioned canonical bridge. Load time does
not prove team publication or each snapshot's GitHub upload time. Historical
rank use remains conditional on availability evidence and the reconstruction
contract; forward capture is viable. Rank is role evidence, not guaranteed
opportunity, playing time or active status.

Both inspected depth-file hashes are recorded in the artifact table above.

### Injury change logs

The nflverse injury file can supply captured status evidence but has no
publication or revision timestamp. ScoreTape documents a promising capture-time
reconstruction, while its NFL start date, completeness, status-clear/removal
semantics, authenticated payload, retention and derived-display rights remain
unverified. A seven-day explorer window does not establish a multi-season
archive. These checks require an approved account or provider response and are
recorded as unknown until obtained.
The [nflverse pipeline](https://github.com/nflverse/nflverse-rosters/blob/72aba7add6996a9b5775e1559cdf6f05aeb4733a/exec/update-injuries.R)
replaces the season artifact from its current query. A capture establishes the
file observed then, not unseen within-day updates or an explicit clearance.
ScoreTape's [NFL guide](https://scoretape.com/nfl) and API docs show different
API-version/authentication examples; confirm the supported injury endpoint
before integration. Its documented example does not prove NFL archive depth.

### Outcomes, usage and corrections

Official NFL statistics are the intended authority for canonical labels;
nflverse remains the practical label feed, subject to reconciliation and the
Step 2 correction policy. The NFL's
[gamebook access guide](https://support.nfl.com/hc/en-us/articles/35869678028180-Game-Books)
identifies official summaries in Game Center recaps. The inspected
[2025 Week 16 PHI–WAS gamebook](https://www.nflgsis.com/2025/REG/16/60069/Gamebook.pdf)
contains individual rushing, passing and receiving totals plus inactive/DNP
sections. It is a concrete manual reconciliation benchmark candidate, not an
approved automated feed. Its media-use notice requires permission for other
uses; project benchmark use and automated retention/redistribution therefore
remain unresolved. A permitted NFL.com box-score route may satisfy the manual
benchmark without bulk PDF ingestion, but its terms must be qualified too.

Before trusting reconciled labels, record official event/player identity, the
official URL/version and observation date, and the compared nflverse version.
An original postgame PDF alone does not establish correction finality.
Record material discrepancies and hold affected labels unresolved until the
official correction/version or identity issue is resolved; never silently
prefer nflverse. No cross-source numeric reconciliation was performed in Step 1.

A source's release timestamp is not a pregame feature timestamp. Prospective
collection must retain the source version, capture/availability time and
correction lineage. Outcome-label rules, including overtime, inactive/DNP,
postponed or canceled games and finalization windows, are specified in Step 2;
this document therefore does not turn a postgame usage value into a pregame
feature.

### Identity and event joins

The minimum join is GSIS player identity plus season/type, game and scheduled
kickoff context. Snap-count PFR IDs and provider IDs require explicit bridges.
Today's roster cannot resolve a historical team membership. Weekly rosters are
the dated candidate, subject to their availability/correction gates. A
rescheduled game, ambiguous event or unresolved player identity fails closed;
a name-only match is not evidence.

### Rights and attribution

Each selected use needs dataset/feed-specific terms, not just a package license,
free endpoint or timestamp. Derived public display is a separate qualification
from internal modeling. Sources with unverified retention or display rights are
not selected for that use. Required attribution/change notices for MET Norway,
Open-Meteo and permitted nflverse/FTN uses, NOAA's requested credit, and optional
NWS source credit must remain distinct in the operations handoff.

## Handoff and current decision

Step 1 supplies #52 with a candidate source matrix and its gates. The current
shortlist is:

- nflverse player/team statistics, play-by-play, schedules and current/weekly
  identifiers for candidate labels, event/membership identity and prospective
  lagged context; an official NFL benchmark remains conditional on permitted use;
- NWS or MET Norway as prospective forecast alternatives, with NOAA NDFD's
  exploratory historical samples conditional on decoder, missingness,
  availability and coverage gates;
- timestamped depth charts and forward-captured injury evidence only after their
  revision, identity and rights checks pass.

Strict reconstructed injury history, strict reconstructed role history and paid
feeds remain deferred or conditional. GFS is an unprobed global historical
candidate; this document does not declare global history unavailable. ecCodes
produced plausible domestic NDFD samples; independent decoder validation remains
open. Existing current Open-Meteo is already integrated; new sources are
future capture or access alternatives, not an implementation decision. A failed
gate must be recorded with the alternative considered; it cannot silently
become a reduced-feature model. Missing inputs will either withhold analysis
or name a separately versioned reduced-feature candidate for #54 validation.

**Historical-validation constraint for #54:** until sufficient prospective
snapshots exist—or a verified historical version archive is selected—#54 may
use reconstructed history only for exploratory development. It cannot present
that evaluation as strict point-in-time validation. Selected outcomes and
revised multi-season files do not remove this MVP schedule constraint for
player statistics, injuries, role, pace or opponent-context predictors.

Step 2 will turn these source dispositions into exact contracts for all nine
registry markets and canonical outcome labels, including explicit
`pushProbability` and the correction needed to #54's arbitrary-line
complementarity wording. Step 3 will make final
retention, operating-cost, freshness, outage and display decisions. Neither step
authorizes production ingestion or provider spending.

## Primary references

- [nflverse data schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
- [nflverse public releases](https://github.com/nflverse/nflverse-data/releases)
- [nflverse data license](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md)
- [nflverse underlying-owner terms](https://nflverse.nflverse.com/#terms-of-use)
- [CC BY license scope](https://creativecommons.org/licenses/by/4.0/legalcode.en#s2)
- [nflreadr play-by-play](https://nflreadr.nflverse.com/reference/load_pbp.html)
- [nflreadr PBP dictionary](https://nflreadr.nflverse.com/articles/dictionary_pbp.html)
- [nflreadr weekly rosters](https://nflreadr.nflverse.com/reference/load_rosters_weekly.html)
- [nflreadr schedule dictionary](https://nflreadr.nflverse.com/articles/dictionary_schedules.html)
- [nflreadr depth charts](https://nflreadr.nflverse.com/reference/load_depth_charts.html)
- [nflreadr snap counts](https://nflreadr.nflverse.com/reference/load_snap_counts.html)
- [nflreadr participation](https://nflreadr.nflverse.com/reference/load_participation.html)
- [FTN charting and its license](https://nflreadr.nflverse.com/reference/load_ftn_charting.html)
- [CC BY-SA share-alike terms](https://creativecommons.org/licenses/by-sa/4.0/)
- [Official NFL gamebook access](https://support.nfl.com/hc/en-us/articles/35869678028180-Game-Books)
- [Official PHI–WAS gamebook example](https://www.nflgsis.com/2025/REG/16/60069/Gamebook.pdf)
- [NWS web API](https://www.weather.gov/documentation/services-web-api)
- [NOAA NDFD](https://www.ncei.noaa.gov/products/weather-climate-models/national-digital-forecast-database)
- [NOAA NDFD archive terms](https://registry.opendata.aws/noaa-ndfd/)
- [NOAA global forecast products](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast)
- [NOAA GFS public archive](https://registry.opendata.aws/noaa-gfs-bdp-pds/)
- [MET Norway forecast API](https://api.met.no/weatherapi/locationforecast/2.0/documentation)
- [MET Norway license](https://api.met.no/doc/License)
- [MET Norway terms](https://api.met.no/doc/TermsOfService)
- [Open-Meteo terms](https://open-meteo.com/en/terms)
- [Open-Meteo single runs](https://open-meteo.com/en/docs/single-runs-api)
- [ScoreTape API documentation](https://scoretape.com/docs)
- [ScoreTape terms](https://scoretape.com/terms)
- [BALLDONTLIE NFL](https://nfl.balldontlie.io/)
- [SportsDataIO historical data guide](https://sportsdata.io/help/historical-data-integration-guide)
- [SportsDataIO rights questions](https://sportsdata.io/help/data-rights-and-licensing-questions)
- [Sportradar historical NFL data](https://developer.sportradar.com/football/docs/nfl-ig-historical-data)
- [NFLMeta data sources](https://nflmeta.org/data-sources)
- [NFLMeta pricing](https://nflmeta.org/pricing)
- [API-Sports terms](https://api-sports.io/terms)
- [GitHub API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Verification for this documentation-only step: source dispositions have a
linked primary reference or a recorded unresolved gate; direct observations,
workload measurements and unknowns are labeled separately; no credentials or
bulk data are committed. Run `git diff --check` before commit. Full application
tests are unnecessary for a documentation-only change.
